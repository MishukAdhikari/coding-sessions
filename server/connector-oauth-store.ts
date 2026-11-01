import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { SecretCodec } from "./secrets";
import { ConnectorError } from "./connectors";
import type { OidcContext } from "./connector-oauth-tokens";

/**
 * Durable state for outbound OAuth connectors. Every secret is sealed with AAD bound to the
 * connector, its auth epoch and the secret's purpose, so ciphertext cannot be moved between
 * connectors, epochs or fields. Writes are compare-and-set:
 * - auth_epoch (on mcp_connectors) changes with URL, mode, account or disconnect; anything
 *   bound to an older epoch is dead, including pending logins and late token responses.
 * - token_version (on the grant) changes only when a grant is refreshed.
 */
const SEALED = "xcs:secret:v1:";
const PENDING_TTL_MS = 10 * 60_000;
type Purpose = "access" | "refresh" | "client_secret" | "verifier";

export type GrantState = "connected" | "reconnect_required";
export type Registration = "preregistered" | "cimd" | "dcr" | "manual";
export interface ConnectorIdentity { subject: string; email?: string; name?: string }
/** Authorization-server choices frozen at sign-in start and carried unchanged into the grant. */
export interface FrozenEndpoints {
  registration: Registration; tokenEndpoint: string; revocationEndpoint?: string | null;
  tokenAuthMethod: "none" | "client_secret_basic" | "client_secret_post"; scope?: string | null;
  /** From trusted metadata only, for later identity validation. */
  jwksUri?: string | null; userinfoEndpoint?: string | null;
}
export interface PendingInput extends FrozenEndpoints {
  connectorId: string; epoch: number; attempt: number; sessionHash: string; issuer: string; resource: string; clientId: string;
  clientSecret?: string | null; redirectUri: string; verifier: string; nonce?: string | null;
  /** The provider promised an iss parameter on the callback (RFC 9207). */
  issParameter?: boolean;
}
export interface PendingFlow extends Omit<PendingInput, "sessionHash" | "clientSecret" | "nonce" | "revocationEndpoint" | "scope" | "jwksUri" | "userinfoEndpoint" | "issParameter"> {
  /** Carried from start to commit; see beginAttempt. */
  clientSecret: string | null; nonce: string | null; revocationEndpoint: string | null; scope: string | null;
  jwksUri: string | null; userinfoEndpoint: string | null; issParameter: boolean;
}
export interface GrantInput extends FrozenEndpoints {
  connectorId: string; epoch: number;
  /** For replaceGrant: the sign-in attempt this grant came from; it must still be the latest. */
  attempt?: number; issuer: string; resource: string; clientId: string;
  clientSecret?: string | null; accessToken: string; refreshToken?: string | null; expiresAt?: number | null;
  identity: ConnectorIdentity | null;
  /** Present only when the identity came from a verified ID token. */
  oidcContext?: OidcContext | null;
}
export interface Grant {
  version: number; issuer: string; resource: string; clientId: string; registration: Registration; clientSecret: string | null;
  tokenEndpoint: string; revocationEndpoint: string | null; tokenAuthMethod: FrozenEndpoints["tokenAuthMethod"];
  accessToken: string; refreshToken: string | null; expiresAt: number | null; scope: string | null;
  /** A refresh was claimed for this version and has not finished. */
  refreshPending: boolean;
  /** When this version's access token was stored (to size the early-refresh window). */
  issuedAt: number;
  jwksUri: string | null;
  /** The original sign-in's verified ID-token claims; null when no identity was verified. */
  oidcContext: OidcContext | null;
}
/** Safe to show and serialize: no tokens, secrets or verifiers. */
export interface OAuthStatus {
  state: GrantState | "disconnected"; issuer: string | null; identity: ConnectorIdentity | null; connectedSince: number | null;
  expiresAt: number | null; registration: Registration | null; scope: string | null;
}
interface GrantRow {
  connector_id: string; auth_epoch: number; token_version: number; status: GrantState; issuer: string; resource: string; client_id: string;
  registration: Registration; token_endpoint: string; revocation_endpoint: string | null; token_auth_method: FrozenEndpoints["tokenAuthMethod"]; client_secret: string | null; access_token: string | null; refresh_token: string | null; expires_at: number | null;
  scope: string | null; identity: string | null; connected_since: number; refresh_pending: number; updated_at: number;
  jwks_uri: string | null; oidc_context: string | null;
}
interface PendingRow {
  connector_id: string; auth_epoch: number; session_hash: string; issuer: string; resource: string; client_id: string;
  client_secret: string | null; redirect_uri: string; verifier: string; nonce: string | null;
  registration: Registration; token_endpoint: string; revocation_endpoint: string | null; token_auth_method: FrozenEndpoints["tokenAuthMethod"]; scope: string | null;
  iss_parameter: number; jwks_uri: string | null; userinfo_endpoint: string | null; attempt: number;
}
export interface OAuthStoreDependencies { database: Database; codec: () => SecretCodec; now?: () => number }

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** The browser-session binding: a hash of the exact xs_auth cookie value, never the cookie itself. */
export const sessionHash = (cookie: string) => sha256(`xs_auth:${cookie}`);

export class ConnectorOAuthStore {
  private readonly now: () => number;
  constructor(private readonly deps: OAuthStoreDependencies) { this.now = deps.now ?? Date.now; }
  private get db() { return this.deps.database; }

  /** Throws when secrets cannot be stored (no encryption key), so a sign-in fails before any network traffic. */
  assertWritable(): void { this.deps.codec(); }

  private seal(connectorId: string, epoch: number, purpose: Purpose, value: string): string {
    const sealed = this.deps.codec().sealSecret(value, `mcp-connector-oauth:${connectorId}:${epoch}:${purpose}`);
    if (!sealed.startsWith(SEALED)) throw new ConnectorError("storage", "Connector secrets must be encrypted. Nothing was saved.");
    return sealed;
  }
  private open(connectorId: string, epoch: number, purpose: Purpose, value: string | null): string | null {
    if (value === null) return null;
    if (!value.startsWith(SEALED)) throw new ConnectorError("storage", "A stored connector secret is not encrypted and was not used.");
    try { return this.deps.codec().openSecret(value, `mcp-connector-oauth:${connectorId}:${epoch}:${purpose}`); }
    catch (error) { throw error instanceof ConnectorError ? error : new ConnectorError("storage", "A connector secret cannot be opened with this server's key."); }
  }
  private currentEpoch(connectorId: string): number | null {
    const row = this.db.query("SELECT auth_epoch FROM mcp_connectors WHERE id=? AND auth_mode='oauth'").get(connectorId) as { auth_epoch: number } | null;
    return row?.auth_epoch ?? null;
  }

  /**
   * Advance the connector's auth epoch: drops its grant and every pending login, so nothing
   * started earlier can complete or refresh. Returns the new epoch.
   */
  advanceEpoch(connectorId: string): number {
    return this.db.transaction(() => {
      this.db.query("UPDATE mcp_connectors SET auth_epoch=auth_epoch+1, token_version=0 WHERE id=?").run(connectorId);
      this.db.query("DELETE FROM connector_oauth_pending WHERE connector_id=?").run(connectorId);
      this.db.query("DELETE FROM connector_oauth_grants WHERE connector_id=?").run(connectorId);
      return (this.db.query("SELECT auth_epoch FROM mcp_connectors WHERE id=?").get(connectorId) as { auth_epoch: number } | null)?.auth_epoch ?? 0;
    })();
  }

  /** Starts a new sign-in attempt on this epoch and returns its number; any earlier attempt is superseded. */
  beginAttempt(connectorId: string, epoch: number): number {
    return this.db.transaction(() => {
      const moved = this.db.query("UPDATE mcp_connectors SET oauth_attempt=oauth_attempt+1 WHERE id=? AND auth_epoch=? AND auth_mode='oauth'").run(connectorId, epoch);
      if (moved.changes !== 1) throw new ConnectorError("invalid_request", "This connector changed; start the sign-in again.");
      return (this.db.query("SELECT oauth_attempt FROM mcp_connectors WHERE id=?").get(connectorId) as { oauth_attempt: number }).oauth_attempt;
    })();
  }
  private latest(connectorId: string, epoch: number, attempt: number): boolean {
    return !!this.db.query("SELECT 1 FROM mcp_connectors WHERE id=? AND auth_mode='oauth' AND auth_epoch=? AND oauth_attempt=?").get(connectorId, epoch, attempt);
  }

  /** Records a login attempt; returns the raw state for the authorization URL. Secrets are sealed before anything is written. */
  createPending(input: PendingInput): string {
    const state = randomBytes(32).toString("base64url");
    const verifier = this.seal(input.connectorId, input.epoch, "verifier", input.verifier);
    const secret = input.clientSecret ? this.seal(input.connectorId, input.epoch, "client_secret", input.clientSecret) : null;
    const now = this.now();
    this.db.transaction(() => {
      // A slower, earlier start must not replace a newer one.
      if (!this.latest(input.connectorId, input.epoch, input.attempt)) throw new ConnectorError("invalid_request", "A newer sign-in was started, or this connector changed; use the latest sign-in.");
      this.db.query("DELETE FROM connector_oauth_pending WHERE expires_at<=? OR consumed_at IS NOT NULL").run(now);
      // The latest attempt for a connector supersedes any earlier one still waiting for its callback.
      this.db.query("DELETE FROM connector_oauth_pending WHERE connector_id=?").run(input.connectorId);
      this.db.query(`INSERT INTO connector_oauth_pending (state_hash,connector_id,auth_epoch,session_hash,issuer,resource,client_id,client_secret,redirect_uri,verifier,nonce,
          registration,token_endpoint,revocation_endpoint,token_auth_method,scope,iss_parameter,jwks_uri,userinfo_endpoint,attempt,created_at,expires_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(sha256(state), input.connectorId, input.epoch, input.sessionHash, input.issuer, input.resource,
        input.clientId, secret, input.redirectUri, verifier, input.nonce ?? null, input.registration, input.tokenEndpoint, input.revocationEndpoint ?? null,
        input.tokenAuthMethod, input.scope ?? null, input.issParameter ? 1 : 0, input.jwksUri ?? null, input.userinfoEndpoint ?? null, input.attempt, now, now + PENDING_TTL_MS);
    })();
    return state;
  }

  /**
   * Claims a login attempt exactly once. Only the initiating browser session can claim it (a
   * different session neither redeems nor burns it), only before expiry, and only while the
   * connector is still on the same epoch.
   */
  consumePending(state: unknown, session: string): PendingFlow | null {
    if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) return null;
    const hash = sha256(state);
    const row = this.db.transaction(() => {
      const found = this.db.query("SELECT * FROM connector_oauth_pending WHERE state_hash=? AND consumed_at IS NULL AND expires_at>?").get(hash, this.now()) as PendingRow | null;
      if (!found) return null;
      const a = Buffer.from(found.session_hash), b = Buffer.from(session);
      if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
      const claimed = this.db.query("UPDATE connector_oauth_pending SET consumed_at=? WHERE state_hash=? AND consumed_at IS NULL").run(this.now(), hash);
      return claimed.changes === 1 ? found : null;
    })();
    // Only the latest attempt on the current epoch can be completed.
    if (!row || !this.latest(row.connector_id, row.auth_epoch, row.attempt)) return null;
    return {
      connectorId: row.connector_id, epoch: row.auth_epoch, issuer: row.issuer, resource: row.resource, clientId: row.client_id,
      clientSecret: this.open(row.connector_id, row.auth_epoch, "client_secret", row.client_secret), redirectUri: row.redirect_uri,
      verifier: this.open(row.connector_id, row.auth_epoch, "verifier", row.verifier)!, nonce: row.nonce,
      registration: row.registration, tokenEndpoint: row.token_endpoint, revocationEndpoint: row.revocation_endpoint,
      tokenAuthMethod: row.token_auth_method, scope: row.scope,
      issParameter: row.iss_parameter === 1, jwksUri: row.jwks_uri, userinfoEndpoint: row.userinfo_endpoint, attempt: row.attempt,
    };
  }

  /**
   * Stores the epoch's one grant. It succeeds only while the connector is on this epoch and has
   * no grant yet (token_version 0): a second callback, or one landing on a reconnect-required
   * grant, cannot overwrite it. Every new sign-in starts from a fresh epoch.
   */
  commitGrant(input: GrantInput): boolean {
    const e = input.epoch, id = input.connectorId;
    const access = this.seal(id, e, "access", input.accessToken);
    const refresh = input.refreshToken ? this.seal(id, e, "refresh", input.refreshToken) : null;
    const secret = input.clientSecret ? this.seal(id, e, "client_secret", input.clientSecret) : null;
    const now = this.now();
    return this.db.transaction(() => {
      const claimed = this.db.query("UPDATE mcp_connectors SET token_version=1 WHERE id=? AND auth_epoch=? AND auth_mode='oauth' AND token_version=0").run(id, e);
      if (claimed.changes !== 1) return false;
      this.db.query(`INSERT INTO connector_oauth_grants (connector_id,auth_epoch,token_version,status,issuer,resource,client_id,registration,token_endpoint,revocation_endpoint,
          token_auth_method,client_secret,access_token,refresh_token,expires_at,scope,identity,jwks_uri,userinfo_endpoint,oidc_context,connected_since,updated_at)
        VALUES (?,?,1,'connected',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(id, e, input.issuer, input.resource, input.clientId, input.registration, input.tokenEndpoint, input.revocationEndpoint ?? null,
          input.tokenAuthMethod, secret, access, refresh, input.expiresAt ?? null, input.scope ?? null,
          input.identity ? JSON.stringify(input.identity) : null, input.jwksUri ?? null, input.userinfoEndpoint ?? null,
          input.oidcContext ? JSON.stringify(input.oidcContext) : null, now, now);
      return true;
    })();
  }

  /**
   * Installs a sign-in's grant in place of whatever the connector has, only if the connector is
   * still on the epoch the sign-in started from. Atomically: advance to a new epoch (ending the
   * old grant, any other pending sign-in, clients and calls), and store the new grant there. The
   * caller clears tool approvals in the same transaction. Returns the new epoch, or null when the
   * connector changed (disconnected, other URL, mode or client, or another sign-in completed).
   */
  replaceGrant(input: GrantInput): number | null {
    const next = input.epoch + 1;
    const sealed = { ...input, epoch: next };
    // Seal for the epoch the grant will live in; nothing is written unless the CAS below holds.
    const access = this.seal(input.connectorId, next, "access", input.accessToken);
    const refresh = input.refreshToken ? this.seal(input.connectorId, next, "refresh", input.refreshToken) : null;
    const secret = input.clientSecret ? this.seal(input.connectorId, next, "client_secret", input.clientSecret) : null;
    const now = this.now();
    return this.db.transaction(() => {
      // CAS on the epoch and the attempt: a sign-in superseded by a newer start cannot commit.
      if (input.attempt === undefined) return null;
      const moved = this.db.query("UPDATE mcp_connectors SET auth_epoch=?, token_version=1 WHERE id=? AND auth_epoch=? AND oauth_attempt=? AND auth_mode='oauth'").run(next, input.connectorId, input.epoch, input.attempt);
      if (moved.changes !== 1) return null;
      this.db.query("DELETE FROM connector_oauth_pending WHERE connector_id=?").run(input.connectorId);
      this.db.query("DELETE FROM connector_oauth_grants WHERE connector_id=?").run(input.connectorId);
      this.db.query(`INSERT INTO connector_oauth_grants (connector_id,auth_epoch,token_version,status,issuer,resource,client_id,registration,token_endpoint,revocation_endpoint,
          token_auth_method,client_secret,access_token,refresh_token,expires_at,scope,identity,jwks_uri,userinfo_endpoint,oidc_context,connected_since,updated_at)
        VALUES (?,?,1,'connected',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(sealed.connectorId, next, sealed.issuer, sealed.resource, sealed.clientId, sealed.registration, sealed.tokenEndpoint, sealed.revocationEndpoint ?? null,
          sealed.tokenAuthMethod, secret, access, refresh, sealed.expiresAt ?? null, sealed.scope ?? null,
          sealed.identity ? JSON.stringify(sealed.identity) : null, sealed.jwksUri ?? null, sealed.userinfoEndpoint ?? null,
          sealed.oidcContext ? JSON.stringify(sealed.oidcContext) : null, now, now);
      return next;
    })();
  }

  private grantRow(connectorId: string, epoch: number): GrantRow | null {
    if (this.currentEpoch(connectorId) !== epoch) return null;
    return this.db.query("SELECT * FROM connector_oauth_grants WHERE connector_id=? AND auth_epoch=?").get(connectorId, epoch) as GrantRow | null;
  }

  /** The usable grant for this epoch, opened for a request; null when disconnected or reconnect is required. */
  readGrant(connectorId: string, epoch: number): Grant | null {
    const row = this.grantRow(connectorId, epoch);
    if (!row || row.status !== "connected" || !row.access_token) return null;
    return {
      version: row.token_version, issuer: row.issuer, resource: row.resource, clientId: row.client_id, registration: row.registration,
      tokenEndpoint: row.token_endpoint, revocationEndpoint: row.revocation_endpoint, tokenAuthMethod: row.token_auth_method,
      clientSecret: this.open(connectorId, epoch, "client_secret", row.client_secret),
      accessToken: this.open(connectorId, epoch, "access", row.access_token)!,
      refreshToken: this.open(connectorId, epoch, "refresh", row.refresh_token),
      expiresAt: row.expires_at, scope: row.scope, refreshPending: row.refresh_pending === 1, issuedAt: row.updated_at,
      jwksUri: row.jwks_uri, oidcContext: row.oidc_context ? JSON.parse(row.oidc_context) as OidcContext : null,
    };
  }

  /** Durably claims the refresh of exactly this version before the request is sent. */
  beginRefresh(connectorId: string, epoch: number, version: number): boolean {
    if (this.currentEpoch(connectorId) !== epoch) return false;
    // updated_at is left alone: it records when this version's access token was issued.
    return this.db.query("UPDATE connector_oauth_grants SET refresh_pending=1 WHERE connector_id=? AND auth_epoch=? AND token_version=? AND status='connected' AND refresh_pending=0")
      .run(connectorId, epoch, version).changes === 1;
  }

  /** Stores a refreshed token for exactly (epoch, version). A missing refresh token keeps the previous one. */
  rotate(input: { connectorId: string; epoch: number; version: number; accessToken: string; refreshToken?: string | null; expiresAt?: number | null; scope?: string | null }): boolean {
    const { connectorId: id, epoch: e } = input;
    const access = this.seal(id, e, "access", input.accessToken);
    const refresh = input.refreshToken ? this.seal(id, e, "refresh", input.refreshToken) : null;
    return this.db.transaction(() => {
      if (this.currentEpoch(id) !== e) return false;
      const changed = this.db.query(`UPDATE connector_oauth_grants SET token_version=token_version+1, refresh_pending=0, access_token=?, refresh_token=COALESCE(?, refresh_token),
        expires_at=?, scope=COALESCE(?, scope), updated_at=? WHERE connector_id=? AND auth_epoch=? AND token_version=? AND status='connected'`)
        .run(access, refresh, input.expiresAt ?? null, input.scope ?? null, this.now(), id, e, input.version);
      if (changed.changes !== 1) return false;
      this.db.query("UPDATE mcp_connectors SET token_version=? WHERE id=? AND auth_epoch=?").run(input.version + 1, id, e);
      return true;
    })();
  }

  /**
   * The resource rejected the access token of exactly this version: treat it as expired so the
   * next request refreshes first. The rejected request itself is never replayed.
   */
  expireAccess(connectorId: string, epoch: number, version: number): boolean {
    if (this.currentEpoch(connectorId) !== epoch) return false;
    return this.db.query("UPDATE connector_oauth_grants SET expires_at=0, updated_at=? WHERE connector_id=? AND auth_epoch=? AND token_version=? AND status='connected'")
      .run(this.now(), connectorId, epoch, version).changes === 1;
  }

  /** The grant can no longer be used without a new sign-in. Its tokens are dropped; the record stays to report why. */
  markReconnect(connectorId: string, epoch: number, version: number): boolean {
    return this.db.transaction(() => {
      if (this.currentEpoch(connectorId) !== epoch) return false;
      return this.db.query(`UPDATE connector_oauth_grants SET status='reconnect_required', refresh_pending=0, access_token=NULL, refresh_token=NULL, updated_at=?
        WHERE connector_id=? AND auth_epoch=? AND token_version=? AND status='connected'`).run(this.now(), connectorId, epoch, version).changes === 1;
    })();
  }

  status(connectorId: string): OAuthStatus {
    const epoch = this.currentEpoch(connectorId);
    const row = epoch === null ? null : this.grantRow(connectorId, epoch);
    if (!row) return { state: "disconnected", issuer: null, identity: null, connectedSince: null, expiresAt: null, registration: null, scope: null };
    let identity: ConnectorIdentity | null = null;
    try { identity = row.identity ? JSON.parse(row.identity) as ConnectorIdentity : null; } catch { identity = null; }
    return { state: row.status, issuer: row.issuer, identity, connectedSince: row.connected_since, expiresAt: row.expires_at, registration: row.registration, scope: row.scope };
  }
}
