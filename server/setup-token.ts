/**
 * One-time sign-in links for a new or recovered server: `coding-sessions setup-link`
 * prints `https://HOST/#setup=TOKEN`, and the first browser to open it is signed in.
 *
 * Only a SHA-256 of the token is stored. It works once, expires after 30 minutes, and
 * a new link replaces the previous one. The token travels in the URL fragment, which
 * browsers never send to the server, so it stays out of proxy and access logs.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = "setup_token";
export const SETUP_TOKEN_TTL_MS = 30 * 60_000;
const TOKEN_RE = /^cssetup_[A-Za-z0-9_-]{43}$/;

export interface SetupTokenStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  delete(key: string): void;
}

const digest = (token: string) => createHash("sha256").update(token).digest();

export function createSetupToken(store: SetupTokenStore, now = Date.now(), ttlMs = SETUP_TOKEN_TTL_MS): string {
  const token = `cssetup_${randomBytes(32).toString("base64url")}`;
  store.set(KEY, JSON.stringify({ hash: digest(token).toString("hex"), expiresAt: now + ttlMs }));
  return token;
}

/** True once for the current, unexpired token; any use or expiry removes it. */
export function consumeSetupToken(store: SetupTokenStore, token: unknown, now = Date.now()): boolean {
  if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
  let saved: { hash?: unknown; expiresAt?: unknown };
  try { saved = JSON.parse(store.get(KEY) ?? "null") ?? {}; } catch { saved = {}; }
  if (typeof saved.hash !== "string" || typeof saved.expiresAt !== "number") return false;
  if (saved.expiresAt <= now) { store.delete(KEY); return false; }
  const expected = Buffer.from(saved.hash, "hex");
  const actual = digest(token);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return false;
  store.delete(KEY);
  return true;
}
