import { createLocalJWKSet, jwtVerify } from "jose";
import { ConnectorError } from "./connectors";
import { DestinationError, PreSendError, readBounded } from "./connector-net";
import type { ConnectorIdentity, FrozenEndpoints } from "./connector-oauth-store";

/**
 * Token-endpoint and revocation calls shared by sign-in and refresh, and ID-token validation.
 * All network calls go through the vetted transport passed in; responses are bounded, and
 * upstream error text is never surfaced.
 */
const MAX = 64 * 1024;
const TIMEOUT_MS = 20_000;
const fail = (message: string): never => { throw new ConnectorError("invalid_request", message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
/** At least MIN_SECRET_LENGTH (8): shorter tokens could not be redacted without mangling ordinary text. */
const TOKEN = /^[\x21-\x7e]{8,8192}$/;
const SCOPE = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;

export interface ClientAuth { clientId: string; clientSecret: string | null; tokenAuthMethod: FrozenEndpoints["tokenAuthMethod"] }
export interface TokenSet { accessToken: string; refreshToken: string | null; expiresIn: number | null; scope: string | null; idToken: string | null }

/** How a token-endpoint call ended. "uncertain" means the server may have acted (e.g. rotated the refresh token). */
export type TokenOutcome = { kind: "ok"; tokens: TokenSet } | { kind: "rejected" } | { kind: "uncertain" } | { kind: "not_sent"; message: string };

function authenticate(form: URLSearchParams, client: ClientAuth): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (client.tokenAuthMethod === "client_secret_basic" && client.clientSecret) {
    headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.clientSecret)}`).toString("base64")}`;
  } else {
    form.set("client_id", client.clientId);
    if (client.tokenAuthMethod === "client_secret_post" && client.clientSecret) form.set("client_secret", client.clientSecret);
  }
  return headers;
}

/** Absent optional fields stay absent; present but malformed ones make the whole response invalid. */
export function parseTokenResponse(body: unknown): TokenSet | null {
  if (!object(body) || typeof body.access_token !== "string" || !TOKEN.test(body.access_token)) return null;
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") return null;
  if (body.expires_in !== undefined && !(typeof body.expires_in === "number" && Number.isSafeInteger(body.expires_in) && body.expires_in > 0)) return null;
  if (body.refresh_token !== undefined && !(typeof body.refresh_token === "string" && TOKEN.test(body.refresh_token))) return null;
  if (body.scope !== undefined && !(typeof body.scope === "string" && body.scope.length <= 2048 && SCOPE.test(body.scope))) return null;
  if (body.id_token !== undefined && !(typeof body.id_token === "string" && body.id_token.length <= 16384)) return null;
  return {
    accessToken: body.access_token, refreshToken: (body.refresh_token as string | undefined) ?? null, expiresIn: (body.expires_in as number | undefined) ?? null,
    scope: (body.scope as string | undefined) ?? null, idToken: (body.id_token as string | undefined) ?? null,
  };
}

/**
 * POSTs to a frozen token endpoint. Its own timeout, never a caller's signal, so one caller's
 * cancellation cannot leave a shared exchange half done.
 */
export async function requestTokens(fetcher: typeof fetch, endpoint: string, client: ClientAuth, fields: Record<string, string>): Promise<TokenOutcome> {
  const form = new URLSearchParams(fields);
  const headers = authenticate(form, client);
  let response: Response;
  try { response = await fetcher(endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) }); }
  catch (error) {
    // Only a refusal before sending (address, proxy, URL policy) is certain not to have reached the
    // server; a refused redirect or invalid status came after the request was sent.
    if (error instanceof DestinationError && !error.afterSend) return { kind: "not_sent", message: error.message };
    // Proven pre-send transport failures (DNS, refused connection, TLS verification) also left the grant untouched.
    if (error instanceof PreSendError) return { kind: "not_sent", message: "The authorization server could not be reached; nothing was sent." };
    return { kind: "uncertain" };
  }
  let text: string;
  try { text = await readBounded(response, MAX); } catch { return { kind: "uncertain" }; }
  let body: unknown;
  try { body = JSON.parse(text); } catch { body = null; }
  if (response.status === 200) {
    const tokens = parseTokenResponse(body);
    return tokens ? { kind: "ok", tokens } : { kind: "uncertain" };
  }
  // RFC 6749 §5.2 errors are definitive: the grant or client is not accepted.
  if ((response.status === 400 || response.status === 401) && object(body)
    && ["invalid_grant", "invalid_client", "unauthorized_client", "invalid_scope"].includes(String(body.error))) return { kind: "rejected" };
  return { kind: "uncertain" };
}

/** RFC 7009 revocation, best effort. */
export async function revokeTokens(fetcher: typeof fetch, endpoint: string | null, client: ClientAuth, tokens: Array<{ token: string | null; hint: "refresh_token" | "access_token" }>):
  Promise<"revoked" | "unsupported" | "failed" | "none"> {
  const present = tokens.filter((entry): entry is { token: string; hint: "refresh_token" | "access_token" } => !!entry.token);
  if (!present.length) return "none";
  if (!endpoint) return "unsupported";
  let ok = true;
  for (const { token, hint } of present) {
    const form = new URLSearchParams({ token, token_type_hint: hint });
    const headers = authenticate(form, client);
    try {
      const response = await fetcher(endpoint, { method: "POST", headers, body: form.toString(), signal: AbortSignal.timeout(TIMEOUT_MS) });
      await response.body?.cancel().catch(() => {});
      if (response.status !== 200) ok = false;
    } catch { ok = false; }
  }
  return ok ? "revoked" : "failed";
}

/** Space-separated scope lists: true when every granted scope in `next` was already in `granted`. */
export function scopeWithin(next: string | null, granted: string | null): boolean {
  if (next === null || granted === null) return true;
  const allowed = new Set(granted.split(" "));
  return next.split(" ").every(scope => allowed.has(scope));
}

const ALGORITHMS = ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"];
const short = (value: unknown, max: number) => typeof value === "string" && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) ? value : undefined;

/** The verified claims of the original sign-in that a refreshed ID token must match (OIDC Core §12.2). Never the raw token. */
export interface OidcContext { sub: string; aud: string[]; nonce: string | null; authTime: number | null }

/**
 * Validates an OIDC ID token against the JWKS from the issuer's trusted metadata (fetched through
 * the vetted transport; header-supplied key URLs are never followed): signature, exact issuer,
 * audience/authorized party, expiry, subject and nonce. At sign-in the nonce is required and must
 * match; on refresh it may be absent, but if present must match. Returns the identity to display
 * and the claims later refreshes are compared against.
 */
export async function verifyIdToken(fetcher: typeof fetch, input: { idToken: string; jwksUri: string; issuer: string; clientId: string; nonce: string | null; nonceRequired: boolean }):
  Promise<{ identity: ConnectorIdentity; context: OidcContext }> {
  const refused = (): never => fail("The provider's identity token did not verify, so the sign-in was refused.");
  let jwks: unknown;
  try {
    const response = await fetcher(input.jwksUri, { method: "GET", headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return fail("The provider's signing keys could not be loaded, so the account could not be verified."); }
    jwks = JSON.parse(await readBounded(response, MAX));
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    return fail("The provider's signing keys could not be loaded, so the account could not be verified.");
  }
  if (!object(jwks) || !Array.isArray(jwks.keys)) return fail("The provider's signing keys are invalid.");
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(input.idToken, createLocalJWKSet(jwks as { keys: [] }), {
      issuer: input.issuer, audience: input.clientId, algorithms: ALGORITHMS, clockTolerance: 60, requiredClaims: ["sub", "exp", "iat"],
    }));
  } catch { return refused(); }
  if (input.nonceRequired ? payload.nonce !== input.nonce : payload.nonce !== undefined && payload.nonce !== input.nonce) return refused();
  const audiences = (Array.isArray(payload.aud) ? payload.aud : [payload.aud]).filter((a): a is string => typeof a === "string");
  if ((audiences.length > 1 || payload.azp !== undefined) && payload.azp !== input.clientId) return refused();
  const subject = short(payload.sub, 255);
  if (!subject) return refused();
  if (payload.auth_time !== undefined && !(typeof payload.auth_time === "number" && Number.isFinite(payload.auth_time))) return refused();
  const email = payload.email_verified === true ? short(payload.email, 320) : undefined;
  const name = short(payload.name, 200);
  return {
    identity: { subject, ...(email ? { email } : {}), ...(name ? { name } : {}) },
    context: { sub: subject, aud: [...new Set(audiences)].sort(), nonce: typeof payload.nonce === "string" ? payload.nonce : null, authTime: (payload.auth_time as number | undefined) ?? null },
  };
}

/** OIDC Core §12.2: a refreshed ID token must describe the same authentication as the original. */
export function sameAuthentication(original: OidcContext, next: OidcContext): boolean {
  return next.sub === original.sub
    && JSON.stringify(next.aud) === JSON.stringify(original.aud)
    && (next.authTime === null || next.authTime === original.authTime);
}
