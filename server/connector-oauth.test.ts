import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { ConnectorError, Connectors } from "./connectors";
import { ConnectorOAuth, type MetadataProbe } from "./connector-oauth";
import { sessionHash } from "./connector-oauth-store";

const ORIGIN = "https://sessions.example.com";
const CALLBACK = `${ORIGIN}/oauth/connectors/callback`;
const CANARY = { access: "oauth_access_CANARY_51e2", refresh: "oauth_refresh_CANARY_77aa", secret: "dcr_secret_CANARY_0b19" };
const SESSION = sessionHash("browser-a");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });

type Mode = Record<string, unknown>;
/** One loopback server playing the protected MCP resource and its authorization server. */
function provider(mode: Mode = {}) {
  const hits: Array<{ method: string; path: string; auth: string | null; body: string }> = [];
  const codes = new Map<string, { challenge: string; redirect: string; resource: string; clientId: string }>();
  let base = "";
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    hits.push({ method: req.method, path: url.pathname + url.search, auth: req.headers.get("authorization"), body });
    const json = (value: unknown, status = 200) => Response.json(value, { status });
    if (url.pathname === "/mcp") {
      if (req.headers.get("authorization") === `Bearer ${CANARY.access}`) {
        const msg = JSON.parse(body);
        if (msg.id === undefined) return new Response(null, { status: 202 });
        const result = msg.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "protected" } }
          : { tools: [{ name: "read_file", inputSchema: { type: "object" } }] };
        return json({ jsonrpc: "2.0", id: msg.id, result });
      }
      const header = mode.noChallenge ? {} : { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="files:read"` };
      return new Response("unauthorized", { status: 401, headers: header });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      const servers = mode.servers ? (mode.servers as (b: string) => string[])(base) : [(mode.issuerRef as string) ?? `${base}/as`];
      return json({ resource: (mode.resource as string) ?? `${base}/mcp${mode.resourceSlash ? "/" : ""}`, authorization_servers: servers, scopes_supported: ["files:read"] });
    }
    const asMatch = /^\/\.well-known\/oauth-authorization-server\/(as|as2|asbad)$/.exec(url.pathname);
    if (asMatch) {
      const name = asMatch[1]!;
      if (mode.hugeMetadata) return new Response("x".repeat(200_000), { headers: { "content-type": "application/json" } });
      return json({
        issuer: name === "asbad" ? "https://evil.example/as" : (name === "as" ? (mode.issuer as string) ?? `${base}/as` : `${base}/${name}`),
        authorization_endpoint: `${base}/${name}/authorize?tenant=t1`,
        token_endpoint: name === "as" ? (mode.tokenEndpoint as string) ?? `${base}/as/token` : `${base}/${name}/token`,
        revocation_endpoint: `${base}/${name}/revoke`,
        jwks_uri: `${base}/${name}/jwks`, userinfo_endpoint: `${base}/${name}/userinfo`,
        ...(mode.authMethods ? { token_endpoint_auth_methods_supported: mode.authMethods } : {}),
        ...(mode.noDcr ? {} : { registration_endpoint: `${base}/${name}/register` }),
        response_types_supported: ["code"],
        ...(mode.noS256 ? { code_challenge_methods_supported: ["plain"] } : { code_challenge_methods_supported: ["S256"] }),
        scopes_supported: ["openid", "files:read"],
        ...(mode.noIssParam ? {} : { authorization_response_iss_parameter_supported: true }),
        ...(mode.cimd ? { client_id_metadata_document_supported: true } : {}),
      });
    }
    if (/^\/as2?\/register$/.test(url.pathname) && req.method === "POST") {
      const meta = JSON.parse(body);
      return json({ client_id: "dcr-client", ...(mode.dcrNoSecret ? {} : { client_secret: CANARY.secret }),
        token_endpoint_auth_method: (mode.dcrMethod as string) ?? "client_secret_basic", redirect_uris: meta.redirect_uris }, 201);
    }
    if (url.pathname === "/as/token" && req.method === "POST") {
      const form = new URLSearchParams(body);
      const issued = codes.get(form.get("code") ?? "");
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (!issued || issued.challenge !== challenge || issued.redirect !== form.get("redirect_uri") || issued.resource !== form.get("resource")) {
        return json({ error: "invalid_grant", error_description: `bad ${CANARY.secret}` }, 400);
      }
      codes.delete(form.get("code")!);
      if (mode.slowToken) { (mode.onEnter as (() => void) | undefined)?.(); await mode.slowToken; }
      return json({ access_token: CANARY.access, token_type: (mode.tokenType as string) ?? "Bearer", expires_in: 3600, refresh_token: CANARY.refresh, scope: "files:read",
        ...(mode.tokenFields as Record<string, unknown> ?? {}) });
    }
    return new Response("not found", { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  base = `http://127.0.0.1:${server.port}`;
  return {
    base, hits, mode,
    /** What the authorization server does after the user approves: remember the challenge, hand back a code. */
    approve(authorizationUrl: string) {
      const url = new URL(authorizationUrl);
      const code = randomBytes(12).toString("hex");
      codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, resource: url.searchParams.get("resource")!, clientId: url.searchParams.get("client_id")! });
      return { code, state: url.searchParams.get("state")!, iss: `${url.origin}${url.pathname.replace(/\/authorize$/, "")}` };
    },
  };
}

function fixture(p: ReturnType<typeof provider>, options: { keyless?: boolean; origin?: string; cimdProbe?: MetadataProbe } = {}) {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const key = randomBytes(32);
  const connectors = new Connectors({
    database, isLive: async () => true, env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" },
    codec: () => { if (options.keyless) throw new ConnectorError("storage", "Connector credentials need this server's token-encryption key."); return createSecretCodec(key); },
  });
  const checks: string[] = [];
  const oauth = new ConnectorOAuth({ connectors, origin: options.origin ?? ORIGIN,
    checkClientMetadata: async url => { checks.push(url); return options.cimdProbe ?? { ok: true }; } });
  return { database, connectors, oauth, checks };
}
async function oauthConnector(f: ReturnType<typeof fixture>, p: ReturnType<typeof provider>) {
  const view = await f.connectors.add({ name: "Files", url: `${p.base}/mcp` });
  f.connectors.setAuthMode(view.id, "oauth");
  return view.id;
}

test("challenge discovery, DCR and a browser-bound PKCE authorization URL with frozen endpoints", async () => {
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  f.connectors.setTools(id, []);
  const { authorizationUrl } = await f.oauth.start(id, SESSION);
  const url = new URL(authorizationUrl);
  expect(url.origin + url.pathname).toBe(`${p.base}/as/authorize`);
  expect(url.searchParams.get("tenant")).toBe("t1");
  expect(Object.fromEntries([...url.searchParams].filter(([k]) => !["state", "code_challenge", "nonce"].includes(k)))).toEqual({
    tenant: "t1", response_type: "code", client_id: "dcr-client", redirect_uri: CALLBACK, code_challenge_method: "S256",
    resource: `${p.base}/mcp`, scope: "files:read openid",
  });
  expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const pending = f.database.query("SELECT * FROM connector_oauth_pending").get() as Record<string, unknown>;
  expect(pending).toMatchObject({ issuer: `${p.base}/as`, resource: `${p.base}/mcp`, client_id: "dcr-client", redirect_uri: CALLBACK, registration: "dcr",
    token_endpoint: `${p.base}/as/token`, revocation_endpoint: `${p.base}/as/revoke`, token_auth_method: "client_secret_basic", scope: "files:read openid",
    iss_parameter: 1, jwks_uri: `${p.base}/as/jwks`, userinfo_endpoint: `${p.base}/as/userinfo`, session_hash: SESSION });
  expect(JSON.stringify(pending)).not.toContain(CANARY.secret);
  // Discovery never carried a credential.
  expect(p.hits.every(hit => hit.auth === null)).toBe(true);
  // DCR registered exactly our callback.
  expect(JSON.parse(p.hits.find(hit => hit.path === "/as/register")!.body).redirect_uris).toEqual([CALLBACK]);
});

test("completion in the initiating browser exchanges the code once and connects; the connector then works with its grant", async () => {
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  const { authorizationUrl } = await f.oauth.start(id, SESSION);
  const answer = p.approve(authorizationUrl);
  // Another browser cannot redeem it, and does not burn it.
  await expect(f.oauth.complete(answer, sessionHash("browser-b"))).rejects.toThrow(/no longer valid/);
  const view = await f.oauth.complete(answer, SESSION);
  expect(view.auth).toMatchObject({ mode: "oauth", oauth: { state: "connected", issuer: `${p.base}/as`, registration: "dcr", identity: null } });
  const token = p.hits.find(hit => hit.path === "/as/token")!;
  expect(token.auth).toBe(`Basic ${Buffer.from("dcr-client:" + CANARY.secret).toString("base64")}`);
  expect(new URLSearchParams(token.body).get("redirect_uri")).toBe(CALLBACK);
  // Replay of the same callback fails.
  await expect(f.oauth.complete(answer, SESSION)).rejects.toThrow(/no longer valid/);
  // The grant authenticates the connector's own requests.
  expect((await f.connectors.check(id)).state).toBe("connected");
  const text = JSON.stringify([view, f.connectors.list()]);
  for (const secret of Object.values(CANARY)) expect(text).not.toContain(secret);
});

test("well-known fallback, CIMD and preregistered clients are chosen in order; no option gives actionable details", async () => {
  const noHeader = provider({ noChallenge: true, cimd: true });
  const f = fixture(noHeader);
  const id = await oauthConnector(f, noHeader);
  // CIMD is advertised and our origin is HTTPS: the client id is our metadata URL, no registration call.
  const cimd = new URL((await f.oauth.start(id, SESSION)).authorizationUrl);
  expect(cimd.searchParams.get("client_id")).toBe(`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`);
  expect(noHeader.hits.some(hit => hit.path === "/as/register")).toBe(false);
  expect(noHeader.hits.some(hit => hit.path === "/.well-known/oauth-protected-resource/mcp")).toBe(true);
  // A preregistered client wins over everything.
  f.connectors.setOAuthClient(id, { client_id: "prereg-client", client_secret: "prereg-secret-0001" });
  const prereg = new URL((await f.oauth.start(id, SESSION)).authorizationUrl);
  expect(prereg.searchParams.get("client_id")).toBe("prereg-client");
  expect(JSON.stringify(f.connectors.view(id))).not.toContain("prereg-secret-0001");
  // Neither CIMD nor DCR nor a preregistered client: say exactly what to register.
  const manual = provider({ noDcr: true });
  const g = fixture(manual);
  const other = await oauthConnector(g, manual);
  const error = await g.oauth.start(other, SESSION).catch(e => e);
  expect(error).toBeInstanceOf(ConnectorError);
  expect(error.message).toContain(CALLBACK);
});

test("hostile or insecure metadata fails closed before any authorization URL is issued", async () => {
  for (const mode of [
    { issuer: "https://evil.example/as" },
    { resource: "https://other.example/mcp" },
    { noS256: true },
    { tokenEndpoint: "http://10.0.0.1/token" },
    { issuerRef: "http://169.254.169.254/as" },
    { hugeMetadata: true },
  ]) {
    const p = provider(mode);
    const f = fixture(p);
    const id = await oauthConnector(f, p);
    await expect(f.oauth.start(id, SESSION), JSON.stringify(mode)).rejects.toBeInstanceOf(ConnectorError);
    expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 0 });
  }
});

test("a changed connector, a wrong issuer response, a provider error or a bad token response cannot connect", async () => {
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  // The connector changes between start and completion.
  const first = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  f.connectors.setAuthMode(id, "none"); f.connectors.setAuthMode(id, "oauth");
  await expect(f.oauth.complete(first, SESSION)).rejects.toThrow(/no longer valid/);
  // Mix-up defense: the issuer in the response must be the one we asked.
  const second = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  await expect(f.oauth.complete({ ...second, iss: "https://evil.example/as" }, SESSION)).rejects.toThrow(/issuer/);
  await expect(f.oauth.complete(second, SESSION)).rejects.toThrow(/no longer valid/);
  // The user declined: the attempt is consumed, nothing connects.
  const third = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  await expect(f.oauth.complete({ state: third.state, iss: third.iss, error: "access_denied" }, SESSION)).rejects.toThrow(/declined/);
  // A token response with the wrong type is refused, and upstream error text never comes back.
  p.mode.tokenType = "mac";
  const fourth = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  await expect(f.oauth.complete(fourth, SESSION)).rejects.toThrow(ConnectorError);
  p.mode.tokenType = undefined;
  const fifth = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  const bad = await f.oauth.complete({ ...fifth, code: "wrong" }, SESSION).catch(e => e);
  expect(bad.message).not.toContain(CANARY.secret);
  expect(f.connectors.view(id).auth.oauth!.state).toBe("disconnected");
});

test("disconnect while the token exchange is in flight keeps the connector disconnected", async () => {
  let release!: () => void;
  const p = provider({ slowToken: new Promise<void>(resolve => { release = resolve; }) });
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  const answer = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  const entered = new Promise<void>(resolve => { p.mode.onEnter = resolve; });
  const pending = f.oauth.complete(answer, SESSION).catch(e => e);
  await entered;
  f.connectors.setAuthMode(id, "none"); f.connectors.setAuthMode(id, "oauth");
  release();
  expect(await pending).toBeInstanceOf(ConnectorError);
  expect(f.connectors.view(id).auth.oauth!.state).toBe("disconnected");
  expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_grants").get()).toEqual({ n: 0 });
});

test("concurrent completions of one callback connect at most once", async () => {
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  const answer = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  const results = await Promise.allSettled([f.oauth.complete(answer, SESSION), f.oauth.complete(answer, SESSION), f.oauth.complete(answer, SESSION)]);
  expect(results.filter(r => r.status === "fulfilled").length).toBe(1);
  expect(p.hits.filter(hit => hit.path === "/as/token").length).toBe(1);
});

test("a missing encryption key stops sign-in before any network traffic; starting keeps the epoch and only the latest attempt can complete", async () => {
  const p = provider();
  const keyless = fixture(p, { keyless: true });
  const view = await keyless.connectors.add({ name: "Files", url: `${p.base}/mcp` });
  keyless.connectors.setAuthMode(view.id, "oauth");
  await expect(keyless.oauth.start(view.id, SESSION)).rejects.toThrow(/encryption key/);
  expect(p.hits.length).toBe(0);
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  const epoch = () => (f.database.query("SELECT auth_epoch FROM mcp_connectors WHERE id=?").get(id) as { auth_epoch: number }).auth_epoch;
  const before = epoch();
  // Starting changes nothing; only the latest attempt can complete.
  const first = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  expect(epoch()).toBe(before);
  const second = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  expect(epoch()).toBe(before);
  expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 1 });
  await expect(f.oauth.complete(first, SESSION)).rejects.toThrow(/no longer valid/);
  await f.oauth.complete(second, SESSION);
  // A verified replacement moves to a new epoch exactly once.
  expect(epoch()).toBe(before + 1);
  // Only OAuth connectors can start.
  f.connectors.setAuthMode(id, "none");
  await expect(f.oauth.start(id, SESSION)).rejects.toThrow(/OAuth/);
});

test("client metadata is the public, secret-free CIMD document for this instance", () => {
  const p = provider();
  const f = fixture(p);
  expect(f.oauth.clientMetadata()).toEqual({
    client_id: `${ORIGIN}/.well-known/oauth-client/coding-sessions.json`, client_name: "Coding Sessions", client_uri: ORIGIN,
    redirect_uris: [CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none",
  });
});

test("review regressions: exact resource, issuer before error, DCR methods, strict token fields, no fallback past invalid metadata", async () => {
  // /mcp/ is not /mcp.
  const slash = provider({ resourceSlash: true });
  const a = fixture(slash);
  await expect(a.oauth.start(await oauthConnector(a, slash), SESSION)).rejects.toThrow(/different resource/);
  // A declined response from the wrong issuer is reported as the issuer problem.
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  const answer = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
  await expect(f.oauth.complete({ state: answer.state, error: "access_denied", iss: "https://evil.example/as" }, SESSION)).rejects.toThrow(/issuer/);
  // DCR asks as a web application, and the registered method is validated, not guessed.
  expect(JSON.parse(p.hits.find(hit => hit.path === "/as/register")!.body).application_type).toBe("web");
  for (const mode of [{ dcrMethod: "private_key_jwt" }, { dcrMethod: "client_secret_post", dcrNoSecret: true }, { dcrMethod: "client_secret_post", authMethods: ["client_secret_basic", "none"] }]) {
    const q = provider(mode);
    const g = fixture(q);
    await expect(g.oauth.start(await oauthConnector(g, q), SESSION), JSON.stringify(mode)).rejects.toThrow(/client authentication|secret/);
  }
  // A public preregistered client is refused when the server only lists secret methods.
  const strict = provider({ authMethods: ["client_secret_basic"] });
  const h = fixture(strict);
  const hid = await oauthConnector(h, strict);
  h.connectors.setOAuthClient(hid, { client_id: "public-client" });
  await expect(h.oauth.start(hid, SESSION)).rejects.toThrow(/requires a client secret/);
  // Present but malformed token fields reject the response; nothing connects.
  for (const fields of [{ expires_in: "3600" }, { refresh_token: 5 }, { scope: 7 }, { expires_in: -1 }]) {
    p.mode.tokenFields = fields;
    const next = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
    await expect(f.oauth.complete(next, SESSION), JSON.stringify(fields)).rejects.toThrow(/token response is invalid/);
  }
  p.mode.tokenFields = undefined;
  expect(f.connectors.view(id).auth.oauth!.state).toBe("disconnected");
  // Unavailable metadata falls back to the next listed issuer; invalid metadata does not.
  const fallback = provider({ servers: (base: string) => [`${base}/as-missing`, `${base}/as2`] });
  const i = fixture(fallback);
  expect(new URL((await i.oauth.start(await oauthConnector(i, fallback), SESSION)).authorizationUrl).pathname).toBe("/as2/authorize");
  const invalid = provider({ servers: (base: string) => [`${base}/asbad`, `${base}/as2`] });
  const j = fixture(invalid);
  await expect(j.oauth.start(await oauthConnector(j, invalid), SESSION)).rejects.toThrow(/different issuer/);
  expect(invalid.hits.some(hit => hit.path.startsWith("/.well-known/oauth-authorization-server/as2"))).toBe(false);
});

test("a preregistered client is pinned to its issuer; a changed issuer gets no credential-bearing request", async () => {
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  f.connectors.setOAuthClient(id, { client_id: "prereg", client_secret: "prereg-secret-CANARY-31" });
  expect(f.connectors.view(id).oauth_client).toEqual({ client_id: "prereg", secret_set: true, issuer: null });
  await f.oauth.start(id, SESSION);
  expect(f.connectors.view(id).oauth_client!.issuer).toBe(`${p.base}/as`);
  // The resource now points at a different authorization server.
  p.mode.servers = (base: string) => [`${base}/as2`];
  await expect(f.oauth.start(id, SESSION)).rejects.toThrow(/Replace the client details/);
  expect(p.hits.filter(hit => hit.path.startsWith("/as2/") || hit.auth?.startsWith("Basic"))).toEqual([]);
  // An explicit pin that does not match is refused the same way.
  f.connectors.setOAuthClient(id, { client_id: "prereg", issuer: "https://other.example/as" });
  await expect(f.oauth.start(id, SESSION)).rejects.toThrow(/Replace the client details/);
});

test("client details accept only explicit, well-typed actions and never silently erase a secret", async () => {
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  f.connectors.setOAuthClient(id, { client_id: "prereg", client_secret: "secret-one-0001", issuer: `${p.base}/as` });
  const stored = () => f.database.query("SELECT oauth_client_id AS id, oauth_client_secret AS secret, oauth_client_issuer AS issuer FROM mcp_connectors WHERE id=?").get(id) as { id: string | null; secret: string | null; issuer: string | null };
  expect(stored().secret!.startsWith("xcs:secret:v1:")).toBe(true);
  const before = stored();
  for (const input of [{}, { client_secret: "x" }, { client_id: 5 }, { client_id: "prereg", client_secret: 7 }, { client_id: "prereg", issuer: 9 },
    { client_id: "has space" }, { client_id: "prereg", issuer: "http://10.0.0.1/as" }]) {
    expect(() => f.connectors.setOAuthClient(id, input as Record<string, unknown>), JSON.stringify(input)).toThrow(ConnectorError);
    expect(stored()).toEqual(before);
  }
  // Same client, secret omitted: kept. Issuer omitted: kept.
  f.connectors.setOAuthClient(id, { client_id: "prereg" });
  expect(stored()).toEqual(before);
  // Explicit clear of the secret.
  f.connectors.setOAuthClient(id, { client_id: "prereg", client_secret: null });
  expect(stored()).toMatchObject({ id: "prereg", secret: null, issuer: `${p.base}/as` });
  // A different client never inherits the old secret or issuer pin.
  f.connectors.setOAuthClient(id, { client_id: "prereg", client_secret: "secret-two-0002" });
  f.connectors.setOAuthClient(id, { client_id: "other" });
  expect(stored()).toEqual({ id: "other", secret: null, issuer: null });
  // null removes the client.
  f.connectors.setOAuthClient(id, { client_id: null });
  expect(stored()).toEqual({ id: null, secret: null, issuer: null });
  expect(f.connectors.view(id).oauth_client).toBeNull();
});

test("RFC 9207 is required: no advertised iss support refuses sign-in; a callback without the matching iss never reaches the token endpoint", async () => {
  const legacy = provider({ noIssParam: true });
  const a = fixture(legacy);
  const aid = await oauthConnector(a, legacy);
  await expect(a.oauth.start(aid, SESSION)).rejects.toThrow(/RFC 9207.*bearer token/);
  expect(a.database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 0 });
  expect(legacy.hits.some(hit => hit.path.endsWith("/register"))).toBe(false);

  // Malicious endpoint pairing: the trusted resource lists the issuer, whose metadata pairs another
  // party's authorization endpoint with its own token endpoint. Everything else is valid; the other
  // party answers without iss. Nothing may be exchanged.
  const p = provider();
  const f = fixture(p);
  const id = await oauthConnector(f, p);
  const tokenHits = () => p.hits.filter(hit => hit.path === "/as/token").length;
  for (const tamper of [
    (answer: { code: string; state: string; iss: string }) => ({ code: answer.code, state: answer.state }),
    (answer: { code: string; state: string; iss: string }) => ({ code: answer.code, state: answer.state, iss: `${p.base}/as2` }),
    (answer: { code: string; state: string; iss: string }) => ({ state: answer.state, error: "access_denied" }),
  ]) {
    const answer = p.approve((await f.oauth.start(id, SESSION)).authorizationUrl);
    await expect(f.oauth.complete(tamper(answer), SESSION)).rejects.toThrow(/expected issuer/);
    // The attempt was consumed; it cannot be retried with a forged iss either.
    await expect(f.oauth.complete(answer, SESSION)).rejects.toThrow(/no longer valid/);
  }
  expect(tokenHits()).toBe(0);
  expect(f.connectors.view(id).auth.oauth!.state).toBe("disconnected");
});

test("CIMD is used only when our metadata is publicly reachable; otherwise registration is used with a notice, or the exact alternatives are named", async () => {
  const reachable = provider({ cimd: true });
  const a = fixture(reachable);
  const started = await a.oauth.start(await oauthConnector(a, reachable), SESSION);
  expect(new URL(started.authorizationUrl).searchParams.get("client_id")).toBe(`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`);
  expect(started.notice).toBeUndefined();
  expect(a.checks).toEqual([`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`]);

  // Behind Cloudflare Access the document answers with a login redirect: fall back to DCR and say so.
  const challenged = provider({ cimd: true });
  const b = fixture(challenged, { cimdProbe: { ok: false, kind: "unreachable", reason: "it redirects (often a login page such as Cloudflare Access)" } });
  const fallback = await b.oauth.start(await oauthConnector(b, challenged), SESSION);
  expect(new URL(fallback.authorizationUrl).searchParams.get("client_id")).toBe("dcr-client");
  expect(fallback.notice).toContain(`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`);
  expect(fallback.notice).toContain("Registered this app with the provider instead");

  // No DCR either: refuse, naming the exact public URL and the callback to register.
  const stuck = provider({ cimd: true, noDcr: true });
  const c = fixture(stuck, { cimdProbe: { ok: false, kind: "unreachable", reason: "it answers HTTP 403 (often a login or bot challenge)" } });
  const error = await c.oauth.start(await oauthConnector(c, stuck), SESSION).catch(e => e);
  expect(error).toBeInstanceOf(ConnectorError);
  expect(error.message).toContain(`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`);
  expect(error.message).toContain(CALLBACK);
  expect(c.database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 0 });

  // Valid JSON that is not this instance's document: a configuration error, refused without registering.
  const mismatched = provider({ cimd: true });
  const d = fixture(mismatched, { cimdProbe: { ok: false, kind: "mismatch", reason: "it returns different client metadata than this instance publishes" } });
  await expect(d.oauth.start(await oauthConnector(d, mismatched), SESSION)).rejects.toThrow(/does not match this instance.*ORIGIN/);
  expect(mismatched.hits.some(hit => hit.path.endsWith("/register"))).toBe(false);
  expect(d.database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 0 });
});

test("the client-metadata probe classifies challenges as unreachable and foreign JSON as a mismatch", async () => {
  let mode = "ok";
  let origin = "";
  const site = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch() {
    if (mode === "redirect") return Response.redirect(`${origin}/cdn-cgi/access/login`, 302);
    if (mode === "forbidden") return new Response("blocked", { status: 403 });
    if (mode === "html") return new Response("<html>Just a moment...</html>", { headers: { "content-type": "text/html" } });
    if (mode === "foreign") return Response.json({ client_id: "https://someone-else.example/client.json", redirect_uris: ["https://someone-else.example/cb"] });
    return Response.json(probe.clientMetadata());
  } });
  cleanup.push(() => site.stop(true));
  origin = `http://127.0.0.1:${site.port}`;
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const connectors = new Connectors({ database, isLive: async () => true, env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" }, codec: () => createSecretCodec(randomBytes(32)) });
  const probe = new ConnectorOAuth({ connectors, origin });
  const results: Record<string, unknown> = {};
  for (mode of ["ok", "redirect", "forbidden", "html", "foreign"]) {
    const r = await probe.clientMetadataReachable();
    results[mode] = r.ok ? "ok" : r.kind;
  }
  expect(results).toEqual({ ok: "ok", redirect: "unreachable", forbidden: "unreachable", html: "unreachable", foreign: "mismatch" });
});
