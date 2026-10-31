/**
 * OAuth 2.1 for the MCP connector: the authorization server Claude (desktop, web,
 * phone), Claude Code and Codex sign in through before calling /mcp.
 *
 * - Clients register themselves (RFC 7591) — every MCP client expects to — but only
 *   with redirect URIs this app accepts: claude.ai / claude.com's callback, or a
 *   loopback address for a CLI on the user's own machine. Open registration with an
 *   open redirect would let any page mint a consent screen that sends the code to it.
 * - Authorization codes are single-use, live 5 minutes, and need PKCE S256.
 * - Access tokens live an hour; refresh tokens 30 days and rotate on every use.
 * - Codes and tokens are stored only as SHA-256 hashes, like every other secret here.
 *
 * Takes its Database as an argument so tests run against an in-memory one.
 */
import type { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";

export const ACCESS_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
export const CODE_TTL_MS = 5 * 60 * 1000;

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
const b64url = (buf: Buffer) => buf.toString("base64url");

/** Hosts whose https callbacks may receive a code, beside loopback. */
const DEFAULT_REDIRECT_HOSTS = ["claude.ai", "claude.com"];

function extraRedirectHosts(): string[] {
  return (process.env.MCP_REDIRECT_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean);
}

const isLoopbackHost = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";

/** Whether a client may register this redirect URI. Pure, for tests. */
export function redirectUriAllowed(raw: string, extraHosts: string[] = extraRedirectHosts()): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "http:") return isLoopbackHost(u.hostname);
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return [...DEFAULT_REDIRECT_HOSTS, ...extraHosts].some((h) => host === h || host.endsWith("." + h));
}

/**
 * Whether `requested` matches one of a client's registered URIs. Exact, except that
 * a loopback URI may differ in port (RFC 8252 §7.3): CLIs bind a free port per login.
 */
export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  if (registered.includes(requested)) return true;
  let r: URL;
  try { r = new URL(requested); } catch { return false; }
  if (r.protocol !== "http:" || !isLoopbackHost(r.hostname)) return false;
  return registered.some((uri) => {
    try {
      const g = new URL(uri);
      return g.protocol === "http:" && g.hostname === r.hostname && g.pathname === r.pathname && g.search === r.search;
    } catch { return false; }
  });
}

/** PKCE S256: base64url(sha256(verifier)) === challenge. */
export function pkceMatches(verifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return b64url(createHash("sha256").update(verifier).digest()) === challenge;
}

export interface OAuthClient { client_id: string; name: string; redirect_uris: string[]; created_at: number }

export type RegisterResult = { ok: true; client: OAuthClient } | { ok: false; error: string; description: string };

export function registerClient(db: Database, body: unknown): RegisterResult {
  const req = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const uris = Array.isArray(req.redirect_uris) ? req.redirect_uris.filter((u): u is string => typeof u === "string") : [];
  if (!uris.length) return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris is required." };
  const refused = uris.find((u) => !redirectUriAllowed(u));
  if (refused) {
    return { ok: false, error: "invalid_redirect_uri", description: `This server does not send codes to ${refused}.` };
  }
  const name = typeof req.client_name === "string" && req.client_name.trim() ? req.client_name.trim().slice(0, 80) : "MCP client";
  const client: OAuthClient = { client_id: "xsc_" + b64url(randomBytes(16)), name, redirect_uris: uris, created_at: Date.now() };
  db.query("INSERT INTO oauth_clients (client_id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .run(client.client_id, client.name, JSON.stringify(uris), client.created_at);
  return { ok: true, client };
}

export function getClient(db: Database, clientId: string | null | undefined): OAuthClient | null {
  if (!clientId) return null;
  const row = db.query("SELECT client_id, name, redirect_uris, created_at FROM oauth_clients WHERE client_id = ?").get(clientId) as
    { client_id: string; name: string; redirect_uris: string; created_at: number } | null;
  if (!row) return null;
  let uris: string[] = [];
  try { uris = JSON.parse(row.redirect_uris); } catch {}
  return { ...row, redirect_uris: uris };
}

export interface AuthorizeRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  /** Shown on the page: the redirect URI itself can't be trusted, so nothing is sent to it. */
  | { ok: false; fatal: true; message: string }
  /** Sent back to the client's redirect URI as ?error=. */
  | { ok: false; fatal: false; redirectUri: string; state: string | null; error: string; description: string };

/** Validate /oauth/authorize parameters (from the query string or the consent form). */
export function checkAuthorize(db: Database, params: URLSearchParams): AuthorizeCheck {
  const client = getClient(db, params.get("client_id"));
  if (!client) return { ok: false, fatal: true, message: "Unknown client. Remove the connector and add it again." };
  const redirectUri = params.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0]! : "");
  if (!redirectUri || !redirectUriMatches(redirectUri, client.redirect_uris)) {
    return { ok: false, fatal: true, message: "That redirect address is not registered for this client." };
  }
  const state = params.get("state");
  const fail = (error: string, description: string): AuthorizeCheck =>
    ({ ok: false, fatal: false, redirectUri, state, error, description });
  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  return { ok: true, request: { client, redirectUri, state, codeChallenge, resource: params.get("resource") } };
}

export function issueCode(db: Database, req: AuthorizeRequest): string {
  const code = "xsa_" + b64url(randomBytes(32));
  db.query("DELETE FROM oauth_codes WHERE expires_at < ?").run(Date.now());
  db.query("INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(sha256(code), req.client.client_id, req.redirectUri, req.codeChallenge, req.resource, Date.now() + CODE_TTL_MS);
  return code;
}

/** Where the browser goes after Allow or Deny. */
export function redirectWith(redirectUri: string, params: Record<string, string | null>): string {
  const u = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) u.searchParams.set(k, v);
  return u.toString();
}

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

export type TokenResult = { ok: true; body: TokenResponse } | { ok: false; status: number; error: string; description: string };

export const MCP_SCOPE = "sessions";

function mintPair(db: Database, clientId: string, resource: string | null): TokenResponse {
  const now = Date.now();
  const access = "xso_" + b64url(randomBytes(32));
  const refresh = "xsr_" + b64url(randomBytes(32));
  const insert = db.query("INSERT INTO oauth_tokens (token_hash, kind, client_id, resource, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)");
  insert.run(sha256(access), "access", clientId, resource, now, now + ACCESS_TTL_MS);
  insert.run(sha256(refresh), "refresh", clientId, resource, now, now + REFRESH_TTL_MS);
  db.query("DELETE FROM oauth_tokens WHERE expires_at < ?").run(now);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: MCP_SCOPE };
}

const tokenError = (error: string, description: string, status = 400): TokenResult => ({ ok: false, status, error, description });

/** POST /oauth/token for authorization_code and refresh_token grants (public clients). */
export function exchangeToken(db: Database, form: URLSearchParams): TokenResult {
  const grant = form.get("grant_type");
  const clientId = form.get("client_id");

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const row = db.query("SELECT client_id, redirect_uri, code_challenge, resource, expires_at FROM oauth_codes WHERE code_hash = ?").get(sha256(code)) as
      { client_id: string; redirect_uri: string; code_challenge: string; resource: string | null; expires_at: number } | null;
    // Single use, whatever happens next.
    db.query("DELETE FROM oauth_codes WHERE code_hash = ?").run(sha256(code));
    if (!row || row.expires_at < Date.now()) return tokenError("invalid_grant", "The code is unknown or has expired.");
    if (clientId && clientId !== row.client_id) return tokenError("invalid_grant", "The code was issued to another client.");
    if ((form.get("redirect_uri") ?? row.redirect_uri) !== row.redirect_uri) return tokenError("invalid_grant", "redirect_uri does not match.");
    if (!pkceMatches(form.get("code_verifier") ?? "", row.code_challenge)) return tokenError("invalid_grant", "PKCE verification failed.");
    return { ok: true, body: mintPair(db, row.client_id, row.resource) };
  }

  if (grant === "refresh_token") {
    const hash = sha256(form.get("refresh_token") ?? "");
    const row = db.query("SELECT id, client_id, resource, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").get(hash) as
      { id: number; client_id: string; resource: string | null; expires_at: number } | null;
    if (!row || row.expires_at < Date.now()) return tokenError("invalid_grant", "The refresh token is unknown or has expired.");
    if (clientId && clientId !== row.client_id) return tokenError("invalid_grant", "The refresh token was issued to another client.");
    db.query("DELETE FROM oauth_tokens WHERE id = ?").run(row.id); // rotate
    return { ok: true, body: mintPair(db, row.client_id, row.resource) };
  }

  return tokenError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

/** True if the bearer is a live access token; stamps last_used_at. */
export function checkAccessToken(db: Database, token: string | null): boolean {
  if (!token || !token.startsWith("xso_")) return false;
  const row = db.query("SELECT id, expires_at FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'").get(sha256(token)) as
    { id: number; expires_at: number } | null;
  if (!row || row.expires_at < Date.now()) return false;
  db.query("UPDATE oauth_tokens SET last_used_at = ? WHERE id = ?").run(Date.now(), row.id);
  return true;
}

/** Connected clients that still hold a live token, for the menu. */
export function listConnections(db: Database) {
  return db.query(`
    SELECT c.client_id, c.name, c.created_at,
           MAX(t.last_used_at) AS last_used_at
      FROM oauth_clients c JOIN oauth_tokens t ON t.client_id = c.client_id
     WHERE t.expires_at > ?
     GROUP BY c.client_id ORDER BY c.created_at DESC`).all(Date.now()) as
    Array<{ client_id: string; name: string; created_at: number; last_used_at: number | null }>;
}

/** Disconnect a client: its tokens and codes go with it (ON DELETE CASCADE). */
export function revokeClient(db: Database, clientId: string): boolean {
  db.query("DELETE FROM oauth_tokens WHERE client_id = ?").run(clientId);
  db.query("DELETE FROM oauth_codes WHERE client_id = ?").run(clientId);
  return db.query("DELETE FROM oauth_clients WHERE client_id = ?").run(clientId).changes > 0;
}

/* ---------- discovery documents ---------- */

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [MCP_SCOPE],
  };
}

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/mcp`,
    authorization_servers: [origin],
    scopes_supported: [MCP_SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "xCloud Sessions",
  };
}
