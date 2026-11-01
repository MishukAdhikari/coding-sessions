import { createHash, randomBytes } from "node:crypto";
import { ConnectorError, type ConnectorView, type Connectors } from "./connectors";
import { DestinationError, readBounded, validateServerUrl } from "./connector-net";
import type { ConnectorIdentity, FrozenEndpoints, PendingFlow, Registration } from "./connector-oauth-store";
import { requestTokens, revokeTokens, verifyIdToken, type OidcContext } from "./connector-oauth-tokens";

/**
 * Outbound OAuth for MCP connectors (Coding Sessions as an OAuth client). Separate from
 * oauth.ts, which serves the inbound side.
 *
 * Discovery: RFC 9728 protected-resource metadata (from the 401 challenge, else the well-known
 * paths), then RFC 8414 / OIDC authorization-server metadata with an exact issuer match. The
 * resource it names must be this connector's URL; S256 PKCE must be advertised. Every request
 * goes through the vetted transport and never carries the resource's bearer token.
 *
 * Client: a preregistered client first, then CIMD (our public metadata document), then dynamic
 * registration; otherwise the operator is told exactly what to register. Each start begins a new
 * epoch, and the chosen endpoints are frozen with the pending attempt.
 */
const METADATA_MAX = 64 * 1024;
const TIMEOUT_MS = 20_000;
const fail = (message: string): never => { throw new ConnectorError("invalid_request", message); };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const trimSlash = (value: string) => value.replace(/\/+$/, "");

export interface ConnectorOAuthDependencies {
  connectors: Connectors; origin: string;
  /** Test seam for the client-metadata probe. */
  checkClientMetadata?: (url: string, expected: Record<string, unknown>) => Promise<MetadataProbe>;
}
/**
 * Result of fetching our own client metadata from this server, without credentials. It shows
 * whether the public path answers at all; the provider fetches from elsewhere and may still be
 * challenged (by IP, user agent or bot rules) even when this probe succeeds.
 */
export type MetadataProbe = { ok: true } | { ok: false; kind: "unreachable" | "mismatch"; reason: string };
interface AuthorizationServer {
  issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint: string | null; revocationEndpoint: string | null;
  jwksUri: string | null; userinfoEndpoint: string | null; scopes: string[]; cimd: boolean; issParameter: boolean; authMethods: string[] | null;
}

/** Parses `Bearer k="v", k2=v2` without trusting its size or shape. */
export function parseChallenge(header: string | null): Record<string, string> {
  if (!header || header.length > 4096) return {};
  const match = /^\s*Bearer\b(.*)$/i.exec(header);
  if (!match) return {};
  const params: Record<string, string> = {};
  for (const part of match[1]!.matchAll(/([A-Za-z_][A-Za-z0-9_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) {
    params[part[1]!.toLowerCase()] = (part[2] ?? part[3] ?? "").replace(/\\(.)/g, "$1");
  }
  return params;
}

export class ConnectorOAuth {
  private readonly origin: string;
  constructor(private readonly deps: ConnectorOAuthDependencies) {
    this.origin = new URL(deps.origin).origin;
  }

  /** Derived from the configured origin, never a request's Host. */
  callbackUrl(): string { return `${this.origin}/oauth/connectors/callback`; }
  clientMetadataUrl(): string { return `${this.origin}/.well-known/oauth-client/coding-sessions.json`; }
  clientMetadata() {
    return {
      client_id: this.clientMetadataUrl(), client_name: "Coding Sessions", client_uri: this.origin,
      redirect_uris: [this.callbackUrl()], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  private endpoint(value: unknown, what: string): string {
    if (typeof value !== "string") return fail(`The provider's ${what} is missing.`);
    try { return validateServerUrl(value, this.deps.connectors.networkPolicy, "oauth").href; }
    catch (error) { return fail(`The provider's ${what} cannot be used: ${error instanceof DestinationError ? error.message : "invalid URL"}`); }
  }

  private async getJson(url: string, signal: AbortSignal): Promise<Record<string, unknown> | null> {
    let response: Response;
    try { response = await this.deps.connectors.transport("oauth")(url, { method: "GET", headers: { accept: "application/json" }, signal }); }
    catch (error) {
      if (error instanceof DestinationError) fail(error.message);
      return null;
    }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return null; }
    let value: unknown;
    try { value = JSON.parse(await readBounded(response, METADATA_MAX)); }
    catch (error) { return fail(error instanceof DestinationError ? "The provider's metadata is too large." : "The provider's metadata is not valid JSON."); }
    return object(value) ? value : null;
  }

  /** RFC 9728: the challenge's resource_metadata, else the path-specific and root well-known documents. */
  private async protectedResource(resource: URL, signal: AbortSignal): Promise<{ authorizationServers: string[]; scope: string | null }> {
    const probe = await this.deps.connectors.transport("server")(resource.href, {
      method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, signal,
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "coding-sessions", version: "1.0.0" } } }),
    }).catch(error => { if (error instanceof DestinationError) fail(error.message); return null; });
    const challenge = probe?.status === 401 ? parseChallenge(probe.headers.get("www-authenticate")) : {};
    await probe?.body?.cancel().catch(() => {});
    const path = trimSlash(resource.pathname);
    const candidates = challenge.resource_metadata ? [this.endpoint(challenge.resource_metadata, "resource metadata URL")]
      : [`${resource.origin}/.well-known/oauth-protected-resource${path}`, ...(path ? [`${resource.origin}/.well-known/oauth-protected-resource`] : [])];
    for (const candidate of candidates) {
      const metadata = await this.getJson(candidate, signal);
      if (!metadata) continue;
      // Exact match on the canonical URL: /mcp and /mcp/ are different resources.
      let named: string | null = null;
      try { named = typeof metadata.resource === "string" ? new URL(metadata.resource).href : null; } catch { named = null; }
      if (named !== resource.href) return fail("The server's protected-resource metadata names a different resource.");
      const servers = Array.isArray(metadata.authorization_servers) ? metadata.authorization_servers.filter((s): s is string => typeof s === "string") : [];
      if (!servers.length) return fail("The server does not name an authorization server.");
      const scopes = Array.isArray(metadata.scopes_supported) ? metadata.scopes_supported.filter((s): s is string => typeof s === "string") : [];
      return { authorizationServers: servers, scope: challenge.scope ?? (scopes.length ? scopes.join(" ") : null) };
    }
    return fail("The server does not publish OAuth protected-resource metadata, so browser sign-in is not available for it.");
  }

  /**
   * RFC 8414, then OIDC discovery; the document's issuer must equal the one we asked for.
   * Returns null only when no metadata document could be retrieved; any document that fails
   * validation throws, and the caller does not fall back past it.
   */
  private async authorizationServer(issuer: string, signal: AbortSignal): Promise<AuthorizationServer | null> {
    const url = new URL(this.endpoint(issuer, "issuer"));
    if (url.search) fail("The provider's issuer cannot contain a query.");
    const path = trimSlash(url.pathname);
    const candidates = [
      `${url.origin}/.well-known/oauth-authorization-server${path}`,
      `${url.origin}/.well-known/openid-configuration${path}`,
      ...(path ? [`${url.origin}${path}/.well-known/openid-configuration`] : []),
    ];
    for (const candidate of candidates) {
      const m = await this.getJson(candidate, signal);
      if (!m) continue;
      if (m.issuer !== issuer) return fail("The authorization server's metadata names a different issuer.");
      const list = (key: string) => Array.isArray(m[key]) ? (m[key] as unknown[]).filter((v): v is string => typeof v === "string") : null;
      if (!(list("code_challenge_methods_supported") ?? []).includes("S256")) return fail("The authorization server does not advertise S256 PKCE, so sign-in is refused.");
      const responseTypes = list("response_types_supported");
      if (responseTypes && !responseTypes.includes("code")) return fail("The authorization server does not support the authorization code flow.");
      // Mix-up defense (RFC 9700 §4.4.2): with one callback and a shared client across servers,
      // only an issuer-identified response (RFC 9207) proves which server answered. Required.
      if (m.authorization_response_iss_parameter_supported !== true) {
        return fail("This authorization server does not identify itself in sign-in responses (RFC 9207), so browser sign-in is refused. Use a bearer token for this server instead.");
      }
      const optional = (key: string, what: string) => m[key] === undefined ? null : this.endpoint(m[key], what);
      return {
        issuer, authorizationEndpoint: this.endpoint(m.authorization_endpoint, "authorization endpoint"), tokenEndpoint: this.endpoint(m.token_endpoint, "token endpoint"),
        registrationEndpoint: optional("registration_endpoint", "registration endpoint"), revocationEndpoint: optional("revocation_endpoint", "revocation endpoint"),
        jwksUri: optional("jwks_uri", "JWKS URL"), userinfoEndpoint: optional("userinfo_endpoint", "UserInfo endpoint"),
        scopes: list("scopes_supported") ?? [], cimd: m.client_id_metadata_document_supported === true,
        issParameter: m.authorization_response_iss_parameter_supported === true, authMethods: list("token_endpoint_auth_methods_supported"),
      };
    }
    return null;
  }

  /**
   * Whether the authorization server will be able to fetch our client metadata document: a GET
   * without credentials, as the server would make it, must return exactly that JSON. A login
   * redirect or bot challenge (e.g. Cloudflare Access in front of the app) is reported, never hidden.
   */
  async clientMetadataReachable(signal: AbortSignal = AbortSignal.timeout(TIMEOUT_MS)): Promise<MetadataProbe> {
    const url = this.clientMetadataUrl();
    const expected = this.clientMetadata();
    if (this.deps.checkClientMetadata) return this.deps.checkClientMetadata(url, expected);
    const unreachable = (reason: string): MetadataProbe => ({ ok: false, kind: "unreachable", reason });
    let response: Response;
    try { response = await this.deps.connectors.transport("oauth")(url, { method: "GET", headers: { accept: "application/json" }, signal }); }
    catch (error) {
      if (error instanceof DestinationError) return unreachable(/redirect/.test(error.message) ? "it redirects (often a login page such as Cloudflare Access)" : error.message);
      return unreachable("it could not be reached");
    }
    if (response.status !== 200) { await response.body?.cancel().catch(() => {}); return unreachable(`it answers HTTP ${response.status} (often a login or bot challenge)`); }
    let body: unknown;
    try { body = JSON.parse(await readBounded(response, METADATA_MAX)); } catch { return unreachable("it does not return JSON (often a challenge page)"); }
    // Valid JSON that is not our document is a configuration error, not a reachability problem.
    if (!object(body) || body.client_id !== expected.client_id || JSON.stringify(body.redirect_uris) !== JSON.stringify(expected.redirect_uris)) {
      return { ok: false, kind: "mismatch", reason: "it returns different client metadata than this instance publishes" };
    }
    return { ok: true };
  }

  /** Preregistered, then CIMD (only when our metadata is publicly reachable), then dynamic registration. */
  private async client(server: AuthorizationServer, preregistered: { id: string; secret: string | null } | null, signal: AbortSignal):
    Promise<{ id: string; secret: string | null; registration: Registration; method: FrozenEndpoints["tokenAuthMethod"]; notice?: string }> {
    // When the server lists its token-endpoint auth methods, the chosen one must be among them.
    const allowed = (method: string) => !server.authMethods || server.authMethods.includes(method);
    if (preregistered) {
      const method = !preregistered.secret ? (allowed("none") ? "none" : fail("The authorization server requires a client secret for this client."))
        : allowed("client_secret_basic") ? "client_secret_basic"
        : allowed("client_secret_post") ? "client_secret_post" : fail("The authorization server accepts no client authentication this app supports.");
      return { id: preregistered.id, secret: preregistered.secret, registration: "preregistered", method };
    }
    let notice: string | undefined;
    if (server.cimd && this.origin.startsWith("https://") && allowed("none")) {
      const probe = await this.clientMetadataReachable(signal);
      if (probe.ok) return { id: this.clientMetadataUrl(), secret: null, registration: "cimd", method: "none" };
      if (probe.kind === "mismatch") {
        return fail(`This app's client metadata at ${this.clientMetadataUrl()} does not match this instance: ${probe.reason}. Check that ORIGIN and any proxy in front of the app serve this instance's document, then try again.`);
      }
      // Unreachable from here: fall back to registration when the server offers it, and say why.
      notice = `A check from this server could not fetch this app's client metadata at ${this.clientMetadataUrl()}: ${probe.reason}.`;
      if (!server.registrationEndpoint) {
        return fail(`${notice} Make exactly that path public (no login or challenge), or register an OAuth client with redirect URI ${this.callbackUrl()} and enter its client ID.`);
      }
      notice += " Registered this app with the provider instead.";
    }
    if (server.registrationEndpoint) {
      const { client_id: _unused, ...metadata } = this.clientMetadata();
      const response = await this.deps.connectors.transport("oauth")(server.registrationEndpoint, {
        method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, signal,
        body: JSON.stringify({ ...metadata, application_type: "web" }),
      }).catch(error => fail(error instanceof DestinationError ? error.message : "The authorization server's registration endpoint is unavailable."));
      if (response.status !== 200 && response.status !== 201) { await response.body?.cancel().catch(() => {}); return fail("The authorization server refused to register this app."); }
      let body: unknown;
      try { body = JSON.parse(await readBounded(response, METADATA_MAX)); } catch { return fail("The authorization server's registration response is invalid."); }
      if (!object(body) || typeof body.client_id !== "string" || !/^[\x21-\x7e]{1,512}$/.test(body.client_id)) return fail("The authorization server's registration response is invalid.");
      if (Array.isArray(body.redirect_uris) && !body.redirect_uris.includes(this.callbackUrl())) return fail("The authorization server registered a different callback URL.");
      // The registered method is what the server says it registered (we asked for "none"), never
      // inferred from whether a secret came back; it must be one we support and the server allows.
      const method = body.token_endpoint_auth_method === undefined ? "none" : body.token_endpoint_auth_method;
      if (method !== "none" && method !== "client_secret_basic" && method !== "client_secret_post") return fail("The authorization server registered an unsupported client authentication method.");
      if (!allowed(method)) return fail("The authorization server registered a client authentication method it does not advertise.");
      const secret = typeof body.client_secret === "string" && /^[\x21-\x7e]{1,4096}$/.test(body.client_secret) ? body.client_secret : null;
      if (method !== "none" && !secret) return fail("The authorization server registered a confidential client without a usable secret.");
      return { id: body.client_id, secret: method === "none" ? null : secret, registration: "dcr", method, ...(notice ? { notice } : {}) };
    }
    return fail(`This provider needs a registered client. Register an OAuth client with redirect URI ${this.callbackUrl()}`
      + `${this.origin.startsWith("https://") ? ` (or use the client ID ${this.clientMetadataUrl()} if it accepts client metadata documents)` : ""}, then enter its client ID here.`);
  }

  /** Starts a sign-in for this browser session; returns the provider URL to open. */
  async start(connectorId: string, session: string): Promise<{ authorizationUrl: string; notice?: string }> {
    const connectors = this.deps.connectors;
    // Fail on a missing key before any network traffic.
    connectors.oauth.assertWritable();
    const target = connectors.oauthTarget(connectorId);
    const { epoch, attempt } = connectors.beginOAuthAttempt(connectorId);
    const signal = AbortSignal.timeout(TIMEOUT_MS);
    const resource = await this.protectedResource(target.url, signal);
    // Try the next listed issuer only when one's metadata is unavailable; a validation failure stops here.
    let server: AuthorizationServer | null = null;
    // A preregistered client pinned to an issuer only ever talks to that issuer.
    const pinned = target.client?.issuer ?? null;
    if (pinned && !resource.authorizationServers.includes(pinned)) {
      return fail(`The server no longer names the authorization server this client is registered with (${pinned}). Replace the client details to continue.`);
    }
    for (const issuer of pinned ? [pinned] : resource.authorizationServers.slice(0, 3)) {
      server = await this.authorizationServer(issuer, signal);
      if (server) break;
    }
    if (!server) return fail("The authorization server's metadata could not be found.");
    const client = await this.client(server, target.client, signal);
    if (client.registration === "preregistered") this.deps.connectors.pinOAuthClientIssuer(connectorId, epoch, client.id, server.issuer);
    const scopes = (resource.scope ?? "").split(/\s+/).filter(Boolean);
    if (server.scopes.includes("openid") && !scopes.includes("openid")) scopes.push("openid");
    const scope = scopes.length ? scopes.join(" ") : null;
    const verifier = randomBytes(32).toString("base64url");
    const nonce = scopes.includes("openid") ? randomBytes(16).toString("base64url") : null;
    const state = connectors.oauth.createPending({
      connectorId, epoch, attempt, sessionHash: session, issuer: server.issuer, resource: target.url.href, clientId: client.id, clientSecret: client.secret,
      redirectUri: this.callbackUrl(), verifier, nonce, registration: client.registration, tokenEndpoint: server.tokenEndpoint,
      revocationEndpoint: server.revocationEndpoint, tokenAuthMethod: client.method, scope, issParameter: server.issParameter,
      jwksUri: server.jwksUri, userinfoEndpoint: server.userinfoEndpoint,
    });
    const url = new URL(server.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.id);
    url.searchParams.set("redirect_uri", this.callbackUrl());
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", createHash("sha256").update(verifier).digest("base64url"));
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("resource", target.url.href);
    if (scope) url.searchParams.set("scope", scope);
    if (nonce) url.searchParams.set("nonce", nonce);
    return { authorizationUrl: url.href, ...(client.notice ? { notice: client.notice } : {}) };
  }

  /**
   * Completes a sign-in from the callback, in the browser session that started it. The attempt
   * is claimed exactly once (state alone never suffices), the epoch must be unchanged, and the
   * grant commits only if the connector is still on that epoch when the token arrives.
   */
  async complete(input: { state?: unknown; code?: unknown; iss?: unknown; error?: unknown }, session: string): Promise<ConnectorView> {
    const flow = this.deps.connectors.oauth.consumePending(input.state, session);
    if (!flow) return fail("This sign-in link is no longer valid. Start the sign-in again.");
    // Mix-up defense applies to error responses too: the issuer must be present and match
    // before anything else, and before any code is sent anywhere.
    if (input.iss !== flow.issuer) return fail("The sign-in response did not come from the expected issuer, so it was refused.");
    if (input.error !== undefined) return fail("The provider declined the sign-in.");
    if (typeof input.code !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(input.code)) return fail("The sign-in response is missing its code.");
    const tokens = await this.exchange(flow, input.code);
    const discard = () => revokeTokens(this.deps.connectors.transport("oauth"), flow.revocationEndpoint, flow,
      [{ token: tokens.refreshToken, hint: "refresh_token" }, { token: tokens.accessToken, hint: "access_token" }]).catch(() => "failed");
    let identity: ConnectorIdentity | null = null;
    let oidcContext: OidcContext | null = null;
    try {
      if (tokens.idToken && flow.nonce && flow.jwksUri) {
        ({ identity, context: oidcContext } = await verifyIdToken(this.deps.connectors.transport("oauth"),
          { idToken: tokens.idToken, jwksUri: flow.jwksUri, issuer: flow.issuer, clientId: flow.clientId, nonce: flow.nonce, nonceRequired: true }));
      }
    } catch (error) { await discard(); throw error; }
    const replaced = this.deps.connectors.replaceOAuthGrant({
      connectorId: flow.connectorId, epoch: flow.epoch, attempt: flow.attempt, issuer: flow.issuer, resource: flow.resource, clientId: flow.clientId, clientSecret: flow.clientSecret,
      registration: flow.registration, tokenEndpoint: flow.tokenEndpoint, revocationEndpoint: flow.revocationEndpoint, tokenAuthMethod: flow.tokenAuthMethod,
      scope: tokens.scope ?? flow.scope, jwksUri: flow.jwksUri, userinfoEndpoint: flow.userinfoEndpoint,
      accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, identity, oidcContext,
    });
    // Superseded by a newer sign-in, or the connector changed: these new tokens are not kept.
    if (!replaced) { await discard(); return fail("This connector changed, or a newer sign-in was started, while signing in. Use the latest sign-in."); }
    return replaced;
  }

  private async exchange(flow: PendingFlow, code: string) {
    const fetcher = this.deps.connectors.transport("oauth");
    const outcome = await requestTokens(fetcher, flow.tokenEndpoint, flow,
      { grant_type: "authorization_code", code, redirect_uri: flow.redirectUri, code_verifier: flow.verifier, resource: flow.resource });
    if (outcome.kind === "not_sent") return fail(outcome.message);
    // Upstream error bodies are never echoed: they can reflect submitted values.
    if (outcome.kind === "rejected") return fail("The authorization server did not accept the sign-in.");
    if (outcome.kind === "uncertain") return fail("The authorization server's token response is invalid or did not arrive. Start the sign-in again.");
    const tokens = outcome.tokens;
    return { ...tokens, expiresAt: tokens.expiresIn ? this.deps.connectors.clock() + tokens.expiresIn * 1000 : null };
  }
}
