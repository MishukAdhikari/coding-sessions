import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import { db, getMeta, setMeta } from "./db";
import { createHash, randomBytes } from "node:crypto";
import { config } from "./config";
import { bootstrapPassword } from "./bootstrap";

export const RP_ID = config.rpId;
export const ORIGIN = config.origin;
const RP_NAME = "xCloud Sessions";
const USER_ID = new TextEncoder().encode("xcloud-sessions-admin");
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/* ---------- bootstrap password ---------- */

export async function ensureAdminPassword(): Promise<string | null> {
  if (getMeta("admin_password_hash")) return null;
  const { password, path } = bootstrapPassword(config.dataDir);
  setMeta("admin_password_hash", await Bun.password.hash(password));
  return path; // log only the protected location, never the credential
}

export async function verifyPassword(password: string): Promise<boolean> {
  const hash = getMeta("admin_password_hash");
  if (!hash) return false;
  return Bun.password.verify(password, hash);
}

/* ---------- cookie sessions ---------- */

export function createAuthSession(ua: string | null): string {
  const token = randomBytes(32).toString("base64url");
  db.query("INSERT INTO auth_sessions (token_hash, ua, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(sha256(token), ua, Date.now(), Date.now() + SESSION_TTL_MS);
  db.query("DELETE FROM auth_sessions WHERE expires_at < ?").run(Date.now());
  return token;
}

export function checkAuthSession(token: string | null): boolean {
  if (!token) return false;
  const row = db.query("SELECT expires_at FROM auth_sessions WHERE token_hash = ?").get(sha256(token)) as
    { expires_at: number } | null;
  return !!row && row.expires_at > Date.now();
}

export function destroyAuthSession(token: string | null): void {
  if (token) db.query("DELETE FROM auth_sessions WHERE token_hash = ?").run(sha256(token));
}

/* ---------- CLI access tokens (for the xcm client) ---------- */

/** Mint a bearer token for the CLI. The raw value is shown once; only its hash is stored. */
export function createCliToken(label: string | null): string {
  const token = "xcm_" + randomBytes(24).toString("base64url");
  db.query("INSERT INTO cli_tokens (token_hash, label, created_at) VALUES (?, ?, ?)")
    .run(sha256(token), label, Date.now());
  return token;
}

/** True if the bearer token is known; stamps last_used_at as a side effect. */
export function checkCliToken(token: string | null): boolean {
  if (!token || !token.startsWith("xcm_")) return false;
  const hash = sha256(token);
  const row = db.query("SELECT id FROM cli_tokens WHERE token_hash = ?").get(hash) as { id: number } | null;
  if (!row) return false;
  db.query("UPDATE cli_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return true;
}

export function listCliTokens() {
  return db.query("SELECT id, label, created_at, last_used_at FROM cli_tokens ORDER BY created_at DESC").all() as
    Array<{ id: number; label: string | null; created_at: number; last_used_at: number | null }>;
}

export function revokeCliToken(id: number): void {
  db.query("DELETE FROM cli_tokens WHERE id = ?").run(id);
}

/* ---------- rate limiting (in-memory, single process) ---------- */

const attempts = new Map<string, { count: number; resetAt: number }>();

export function rateLimited(key: string, max = 5, windowMs = 15 * 60 * 1000): boolean {
  const now = Date.now();
  const slot = attempts.get(key);
  if (!slot || slot.resetAt < now) {
    attempts.set(key, { count: 1, resetAt: now + windowMs });
    return false;
  }
  slot.count++;
  return slot.count > max;
}

/* ---------- WebAuthn ---------- */

interface StoredCredential {
  id: number;
  cred_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  label: string | null;
  created_at: number;
  rp_id: string | null;
}

/**
 * A passkey can only ever authenticate under the relying party it was registered
 * with: move the app to another RP and the authenticator will not even offer the
 * old credential. Such a row must therefore not be counted or advertised, or the
 * login screen offers an Unlock button that silently does nothing.
 *
 * Rows written before this column existed carry null and get the benefit of the
 * doubt — on a server whose RP never moved they are the operator's working
 * passkey — and a successful login stamps them, so the answer stops being a guess.
 */
export function credentialUsable(credentialRpId: string | null, rpId: string): boolean {
  return credentialRpId === null || credentialRpId === rpId;
}

function allCredentials(): StoredCredential[] {
  return db.query("SELECT * FROM credentials").all() as StoredCredential[];
}

/** The credentials that could actually sign in against the RP in force right now. */
function usableCredentials(): StoredCredential[] {
  return allCredentials().filter((c) => credentialUsable(c.rp_id, RP_ID));
}

export function credentialSummaries() {
  return allCredentials().map((c) => ({
    id: c.id,
    label: c.label,
    createdAt: c.created_at,
    // Surfaced rather than hidden: a stale row is worth seeing and deleting.
    usable: credentialUsable(c.rp_id, RP_ID),
  }));
}

export function deleteCredential(id: number): void {
  db.query("DELETE FROM credentials WHERE id = ?").run(id);
}

export function hasPasskey(): boolean {
  return usableCredentials().length > 0;
}

const challenges = new Map<string, { challenge: string; purpose: "reg" | "auth"; expiresAt: number }>();

function stashChallenge(challenge: string, purpose: "reg" | "auth"): string {
  const id = randomBytes(16).toString("base64url");
  challenges.set(id, { challenge, purpose, expiresAt: Date.now() + 5 * 60 * 1000 });
  for (const [k, v] of challenges) if (v.expiresAt < Date.now()) challenges.delete(k);
  return id;
}

function takeChallenge(id: string, purpose: "reg" | "auth"): string | null {
  const entry = challenges.get(id);
  challenges.delete(id);
  if (!entry || entry.purpose !== purpose || entry.expiresAt < Date.now()) return null;
  return entry.challenge;
}

export async function registrationOptions() {
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: RP_ID,
    userName: "administrator",
    userID: USER_ID,
    attestationType: "none",
    excludeCredentials: usableCredentials().map((c) => ({ id: c.cred_id })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  return { options, challengeId: stashChallenge(options.challenge, "reg") };
}

export async function verifyRegistration(challengeId: string, response: unknown, label: string | null) {
  const expectedChallenge = takeChallenge(challengeId, "reg");
  if (!expectedChallenge) return { verified: false as const, error: "Challenge expired — try again." };
  let verification: VerifiedRegistrationResponse;
  try {
    verification = await verifyRegistrationResponse({
      response: response as any,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
  } catch (e) {
    return { verified: false as const, error: e instanceof Error ? e.message : "Verification failed." };
  }
  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false as const, error: "Verification failed." };
  }
  const { credential } = verification.registrationInfo;
  db.query("INSERT INTO credentials (cred_id, public_key, counter, transports, label, created_at, rp_id) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(credential.id, credential.publicKey, credential.counter, JSON.stringify(credential.transports ?? []), label, Date.now(), RP_ID);
  return { verified: true as const };
}

export async function authenticationOptions() {
  const options = await generateAuthenticationOptions({
    rpID: RP_ID,
    userVerification: "preferred",
    allowCredentials: usableCredentials().map((c) => ({
      id: c.cred_id,
      transports: c.transports ? JSON.parse(c.transports) : undefined,
    })),
  });
  return { options, challengeId: stashChallenge(options.challenge, "auth") };
}

export async function verifyAuthentication(challengeId: string, response: unknown) {
  const expectedChallenge = takeChallenge(challengeId, "auth");
  if (!expectedChallenge) return { verified: false as const, error: "Challenge expired — try again." };
  const credId = (response as { id?: string })?.id;
  const cred = usableCredentials().find((c) => c.cred_id === credId);
  if (!cred) return { verified: false as const, error: "Unknown passkey." };
  try {
    const verification = await verifyAuthenticationResponse({
      response: response as any,
      expectedChallenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
      credential: {
        id: cred.cred_id,
        publicKey: new Uint8Array(cred.public_key),
        counter: cred.counter,
        transports: cred.transports ? JSON.parse(cred.transports) : undefined,
      },
    });
    if (!verification.verified) return { verified: false as const, error: "Verification failed." };
    // It just authenticated here, so its relying party is no longer a guess.
    db.query("UPDATE credentials SET counter = ?, rp_id = ? WHERE id = ?")
      .run(verification.authenticationInfo.newCounter, RP_ID, cred.id);
    return { verified: true as const };
  } catch (e) {
    return { verified: false as const, error: e instanceof Error ? e.message : "Verification failed." };
  }
}
