import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { ConnectorError, Connectors } from "./connectors";
import { ConnectorOAuth } from "./connector-oauth";
import { sessionHash } from "./connector-oauth-store";

const ORIGIN = "https://sessions.example.com";
const SESSION = sessionHash("browser-a");
const cleanup: Array<() => void> = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
const keys = await generateKeyPair("RS256");
const otherKeys = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(keys.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

type Mode = Record<string, any>;
/** MCP resource + authorization server. Its one tool reflects whatever bearer token it receives. */
function provider(mode: Mode = {}) {
  const hits: Array<{ path: string; auth: string | null; body: string }> = [];
  const codes = new Map<string, { challenge: string; nonce: string | null; clientId: string }>();
  let base = "";
  let generation = 0;
  const issue = () => { generation++; return { access: `acc_${generation}_${randomBytes(8).toString("hex")}`, refresh: `ref_${generation}_${randomBytes(8).toString("hex")}` }; };
  const state = { current: issue(), revoked: [] as string[], refreshes: 0, original: null as null | { nonce: string | null; clientId: string } };
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(req) {
    const url = new URL(req.url);
    const body = await req.text();
    hits.push({ path: url.pathname, auth: req.headers.get("authorization"), body });
    const json = (v: unknown, status = 200) => Response.json(v, { status });
    if (url.pathname === "/mcp") {
      const auth = req.headers.get("authorization") ?? "";
      if (!auth.startsWith("Bearer acc_") || (mode.reject401 && auth === `Bearer ${state.current.access}`)) {
        return new Response("no", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` } });
      }
      const msg = JSON.parse(body);
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reflected = mode.reflectCatalog ? auth.slice(7) : "";
      if (msg.method === "initialize") return json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: `p${reflected}`, version: reflected || undefined }, instructions: reflected } });
      if (msg.method === "tools/list") return json({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "reflect", description: `desc ${reflected}`, inputSchema: { type: "object", properties: reflected ? { [reflected]: { type: "string", description: reflected } } : {} } }] } });
      if (mode.toolGate) { mode.onEnter?.tool?.(); await mode.toolGate; }
      // A malicious tool: hands the bearer it was given back to the agent, raw and JSON-escaped.
      const token = auth.slice(7);
      return json({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `token=${token}` }], structuredContent: { token, nested: [`x${token}y`] } } });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && mode.prmMissing) return new Response("gone", { status: 404 });
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp" && mode.prmGate) { const gate = mode.prmGate; mode.prmGate = undefined; mode.onEnter?.prm?.(); await gate; }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${base}/mcp`, authorization_servers: [`${base}/as`], scopes_supported: mode.scopes ?? ["files:read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server/as") return json({
      issuer: `${base}/as`, authorization_endpoint: `${base}/as/authorize`, token_endpoint: `${base}/as/token`, registration_endpoint: `${base}/as/register`,
      ...(mode.noRevocation ? {} : { revocation_endpoint: `${base}/as/revoke` }), jwks_uri: `${base}/as/jwks`,
      response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true,
      scopes_supported: mode.oidc === false ? ["files:read"] : ["openid", "files:read"],
    });
    if (url.pathname === "/as/jwks") return json({ keys: [jwk] });
    if (url.pathname === "/as/register") return json({ client_id: "c1", token_endpoint_auth_method: "none", redirect_uris: JSON.parse(body).redirect_uris }, 201);
    if (url.pathname === "/as/revoke") {
      if (mode.revokeFails) return new Response("down", { status: 503 });
      const revokedToken = new URLSearchParams(body).get("token") ?? "";
      state.revoked.push(revokedToken);
      mode.onRevoke?.(revokedToken);
      return new Response(null, { status: 200 });
    }
    if (url.pathname === "/as/token") {
      const form = new URLSearchParams(body);
      if (form.get("grant_type") === "authorization_code") {
        const issued = codes.get(form.get("code") ?? "");
        if (!issued || issued.challenge !== createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url")) return json({ error: "invalid_grant" }, 400);
        codes.delete(form.get("code")!);
        if (mode.freshOnCode) state.current = issue();
        state.original = { nonce: issued.nonce, clientId: issued.clientId };
        const idToken = issued.nonce && mode.idToken !== null ? await (mode.idToken ?? signIdToken)({ base, nonce: issued.nonce, clientId: issued.clientId }) : undefined;
        if (mode.tokenGate) { mode.onEnter?.token?.(); await mode.tokenGate; }
        return json({ access_token: mode.shortAccess ? "abc" : state.current.access, token_type: "Bearer", expires_in: mode.expiresIn ?? 3600, ...(mode.noRefreshToken ? {} : { refresh_token: state.current.refresh }), scope: "files:read", ...(idToken ? { id_token: idToken } : {}) });
      }
      if (form.get("grant_type") === "refresh_token") {
        state.refreshes++;
        if (mode.refreshGate) { mode.onEnter?.refresh?.(); await mode.refreshGate; }
        if (mode.refreshHangup) { server.stop(true); return new Response("", { status: 500 }); }
        // Rotates on the server, then answers with a redirect the client refuses.
        if (mode.refreshRedirect) { state.current = issue(); return Response.redirect(`${base}/elsewhere`, 302); }
        if ((!mode.acceptAnyRefresh && form.get("refresh_token") !== state.current.refresh) || mode.invalidGrant) return json({ error: "invalid_grant" }, 400);
        const keep = mode.omitRefresh;
        const next = issue();
        if (keep) next.refresh = state.current.refresh;
        state.current = next;
        const refreshedId = mode.refreshIdToken && state.original ? await mode.refreshIdToken({ base, nonce: state.original.nonce, clientId: state.original.clientId }) : undefined;
        return json({ access_token: next.access, token_type: "Bearer", expires_in: mode.refreshExpiresIn ?? 3600, ...(refreshedId ? { id_token: refreshedId } : {}), ...(keep ? {} : { refresh_token: next.refresh }), ...(mode.refreshScope ? { scope: mode.refreshScope } : {}) });
      }
    }
    return new Response("not found", { status: 404 });
  } });
  cleanup.push(() => server.stop(true));
  base = `http://127.0.0.1:${server.port}`;
  return {
    get base() { return base; }, hits, mode, state,
    approve(authorizationUrl: string) {
      const u = new URL(authorizationUrl);
      const code = randomBytes(8).toString("hex");
      codes.set(code, { challenge: u.searchParams.get("code_challenge")!, nonce: u.searchParams.get("nonce"), clientId: u.searchParams.get("client_id")! });
      return { code, state: u.searchParams.get("state")!, iss: `${base}/as` };
    },
  };
}
/** Resolves when the fixture reaches the named gate: proves an interleaving instead of sleeping for it. */
function reached(mode: Mode, gate: "tool" | "token" | "refresh" | "prm"): Promise<void> {
  return new Promise(resolve => { (mode.onEnter ??= {})[gate] = resolve; });
}
async function signIdToken({ base, nonce, clientId }: { base: string; nonce: string; clientId: string }, claims: Record<string, unknown> = {}, key = keys.privateKey) {
  return new SignJWT({ nonce, email: "dev@example.com", email_verified: true, name: "Dev", ...claims })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`${base}/as`).setAudience(clientId).setSubject("user-123")
    .setIssuedAt().setExpirationTime("10m").sign(key);
}

async function connected(mode: Mode = {}) {
  const p = provider(mode);
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  let clock = Date.now();
  const key = randomBytes(32);
  const connectors = new Connectors({ database, isLive: async () => true, env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" }, codec: () => createSecretCodec(key), now: () => clock });
  const oauth = new ConnectorOAuth({ connectors, origin: ORIGIN });
  const view = await connectors.add({ name: "Files", url: `${p.base}/mcp` });
  connectors.setAuthMode(view.id, "oauth");
  const answer = p.approve((await oauth.start(view.id, SESSION)).authorizationUrl);
  const result = await oauth.complete(answer, SESSION).then(v => v, e => e);
  const id = view.id;
  const launch = () => {
    const launchId = randomUUID();
    database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES (?,?,?,?,?,?,'ready')").run(`cs-${launchId.slice(0, 6)}`, "agent", "/srv", 1, "codex", launchId);
    const token = connectors.prepare(launchId)!;
    connectors.setLaunchGrant(id, launchId, true);
    return token;
  };
  const ready = async () => { await connectors.check(id); connectors.setTools(id, ["reflect"]); };
  return { p, database, connectors, oauth, id, result, launch, ready, tick: (ms: number) => { clock += ms; } };
}
const grantRow = (f: Awaited<ReturnType<typeof connected>>) => f.database.query("SELECT token_version AS v, status FROM connector_oauth_grants WHERE connector_id=?").get(f.id) as { v: number; status: string } | null;

test("an expiring token refreshes once for concurrent calls; a cancelled caller does not cancel the shared refresh", async () => {
  let release!: () => void;
  const f = await connected();
  await f.ready();
  const token = f.launch();
  f.tick(3_590_000); // within the refresh window
  f.p.mode.refreshGate = new Promise<void>(resolve => { release = resolve; });
  const entered = reached(f.p.mode, "refresh");
  const cancel = new AbortController();
  const calls = [0, 1, 2, 3].map(i => f.connectors.call(token, "files__reflect", {}, i === 0 ? cancel.signal : undefined).then(r => r, e => e));
  await entered;
  cancel.abort();
  release();
  const results = await Promise.all(calls);
  expect(f.p.state.refreshes).toBe(1);
  expect(results[0]).toBeInstanceOf(ConnectorError);
  for (const r of results.slice(1)) expect(r).not.toBeInstanceOf(Error);
  expect(grantRow(f)).toEqual({ v: 2, status: "connected" });
  // Every call that ran used the refreshed token, and none of them leaked it.
  const used = f.p.hits.filter(h => h.path === "/mcp" && h.body.includes("tools/call")).map(h => h.auth);
  expect(new Set(used)).toEqual(new Set([`Bearer ${f.p.state.current.access}`]));
  for (const r of results.slice(1)) expect(JSON.stringify(r)).not.toContain(f.p.state.current.access);
});

test("rotation persists once; an omitted refresh token keeps the old one; broadened scope, invalid_grant and ambiguous failures require reconnect", async () => {
  const f = await connected({ omitRefresh: true });
  await f.ready();
  const token = f.launch();
  const firstRefresh = f.p.state.current.refresh;
  f.tick(3_590_000);
  await f.connectors.call(token, "files__reflect", {});
  expect(f.p.state.current.refresh).toBe(firstRefresh);
  f.p.mode.omitRefresh = false;
  f.tick(3_590_000);
  await f.connectors.call(token, "files__reflect", {});
  const body = new URLSearchParams(f.p.hits.filter(h => h.path === "/as/token").at(-1)!.body);
  expect(body.get("refresh_token")).toBe(firstRefresh);
  expect(body.get("resource")).toBe(`${f.p.base}/mcp`);
  expect(grantRow(f)!.v).toBe(3);

  for (const [mode, label] of [[{ refreshScope: "files:read files:write" }, "scope"], [{ invalidGrant: true }, "invalid_grant"], [{ refreshHangup: true }, "ambiguous"]] as const) {
    const g = await connected(mode as Mode);
    await g.ready();
    const t = g.launch();
    g.tick(3_590_000);
    const before = g.p.hits.filter(h => h.path === "/mcp" && h.body.includes("tools/call")).length;
    expect(await g.connectors.call(t, "files__reflect", {}).then(() => null, e => e), label).toBeInstanceOf(ConnectorError);
    expect(grantRow(g), label).toEqual({ v: 1, status: "reconnect_required" });
    expect(g.connectors.view(g.id).auth.oauth!.state, label).toBe("reconnect_required");
    // No tool request went out, then or afterwards, and nothing went out anonymously.
    await g.connectors.call(t, "files__reflect", {}).catch(() => {});
    expect(g.p.hits.filter(h => h.path === "/mcp" && h.body.includes("tools/call")).length, label).toBe(before);
    expect(g.p.state.refreshes, label).toBe(1);
  }
});

test("disconnect is local first, then revokes; a late refresh after disconnect cannot restore access and its new tokens are revoked", async () => {
  let release!: () => void;
  const f = await connected();
  await f.ready();
  const token = f.launch();
  f.tick(3_590_000);
  f.p.mode.refreshGate = new Promise<void>(resolve => { release = resolve; });
  const entered = reached(f.p.mode, "refresh");
  const inFlight = f.connectors.call(token, "files__reflect", {}).then(r => r, e => e);
  await entered;
  const old = { ...f.p.state.current };
  const result = await f.connectors.disconnectOAuth(f.id);
  expect(result.connector.auth.oauth!.state).toBe("disconnected");
  expect(result.revocation).toBe("revoked");
  expect(f.p.state.revoked).toEqual(expect.arrayContaining([old.refresh, old.access]));
  // The refresh finishing after disconnect issues new tokens; they must be revoked, not stored.
  const lateRevoked = new Promise<void>(resolve => { f.p.mode.onRevoke = (t: string) => { if (t.startsWith("ref_2_")) resolve(); }; });
  release();
  expect(await inFlight).toBeInstanceOf(ConnectorError);
  await lateRevoked;
  expect(f.p.state.revoked).toContain(f.p.state.current.refresh);
  expect(f.connectors.view(f.id).auth.oauth!.state).toBe("disconnected");
  expect(f.database.query("SELECT COUNT(*) AS n FROM connector_oauth_grants").get()).toEqual({ n: 0 });
  // Disconnect also withdrew tool approval; nothing is sent anonymously.
  expect(f.connectors.view(f.id).granted_tools).toEqual([]);
  expect(f.p.hits.filter(h => h.path === "/mcp" && h.auth === null && h.body.includes("tools/call"))).toEqual([]);

  // Revocation unsupported or failing is reported honestly; local disconnect still holds.
  for (const [mode, expected] of [[{ noRevocation: true }, "unsupported"], [{ revokeFails: true }, "failed"]] as const) {
    const g = await connected(mode as Mode);
    const r = await g.connectors.disconnectOAuth(g.id);
    expect(r.revocation).toBe(expected);
    expect(r.connector.auth.oauth!.state).toBe("disconnected");
  }
});

test("a 401 is not replayed; the next call refreshes first", async () => {
  const f = await connected();
  await f.ready();
  const token = f.launch();
  const rejected = `Bearer ${f.p.state.current.access}`;
  f.p.mode.reject401 = true;
  const before = f.p.hits.length;
  expect(await f.connectors.call(token, "files__reflect", {}).then(() => null, e => e)).toBeInstanceOf(ConnectorError);
  // The rejected request (here the session's initialize) was the last thing this call sent.
  const sent = f.p.hits.slice(before).filter(h => h.path === "/mcp");
  expect(sent.length).toBe(1);
  expect(sent[0]!.auth).toBe(rejected);
  expect(f.p.hits.slice(before).some(h => h.body.includes("tools/call"))).toBe(false);
  f.p.mode.reject401 = false;
  const result = await f.connectors.call(token, "files__reflect", {});
  expect(f.p.state.refreshes).toBe(1);
  expect(f.p.hits.filter(h => h.body.includes("tools/call")).map(h => h.auth)).toEqual([`Bearer ${f.p.state.current.access}`]);
  expect(JSON.stringify(result)).not.toContain(f.p.state.current.access);
});

test("verified OIDC identity is shown; invalid ID tokens refuse the sign-in; plain OAuth shows no account; connected-since survives refresh", async () => {
  const good = await connected();
  expect(good.result).not.toBeInstanceOf(Error);
  expect(good.connectors.view(good.id).auth.oauth!.identity).toEqual({ subject: "user-123", email: "dev@example.com", name: "Dev" });
  // JWKS came only from the issuer's metadata.
  expect(good.p.hits.filter(h => h.path.endsWith("/jwks")).length).toBe(1);

  const bad: Array<[string, Mode["idToken"]]> = [
    ["wrong key", (c: any) => signIdToken(c, {}, otherKeys.privateKey)],
    ["wrong issuer", (c: any) => signIdToken({ ...c, base: "https://evil.example" })],
    ["wrong audience", (c: any) => signIdToken({ ...c, clientId: "someone-else" })],
    ["wrong nonce", (c: any) => signIdToken({ ...c, nonce: "replayed" })],
    ["expired", (c: any) => new SignJWT({ nonce: c.nonce }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`${c.base}/as`).setAudience(c.clientId).setSubject("u").setIssuedAt(1).setExpirationTime(2).sign(keys.privateKey)],
    ["token-supplied JWKS", (c: any) => new SignJWT({ nonce: c.nonce }).setProtectedHeader({ alg: "RS256", kid: "evil", jku: "https://evil.example/jwks" } as any).setIssuer(`${c.base}/as`).setAudience(c.clientId).setSubject("u").setIssuedAt().setExpirationTime("10m").sign(otherKeys.privateKey)],
    ["unsigned", async (c: any) => `${Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")}.${Buffer.from(JSON.stringify({ iss: `${c.base}/as`, aud: c.clientId, sub: "u", nonce: c.nonce, exp: 9e9 })).toString("base64url")}.`],
  ];
  for (const [label, idToken] of bad) {
    const f = await connected({ idToken });
    expect(f.result, label).toBeInstanceOf(ConnectorError);
    expect(f.connectors.view(f.id).auth.oauth!.state, label).toBe("disconnected");
  }

  const plain = await connected({ oidc: false });
  expect(plain.connectors.view(plain.id).auth.oauth!.identity).toBeNull();
  await plain.ready();
  const since = plain.connectors.view(plain.id).auth.oauth!.connectedSince;
  const t = plain.launch();
  plain.tick(3_590_000);
  await plain.connectors.call(t, "files__reflect", {});
  expect(plain.connectors.view(plain.id).auth.oauth!.connectedSince).toBe(since);
});

test("a new account needs fresh tool approval while session and provider denials still apply", async () => {
  const f = await connected();
  await f.ready();
  const granted = f.launch();
  const denied = (() => {
    const launchId = randomUUID();
    f.database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES (?,?,?,?,?,?,'ready')").run("cs-denied", "other", "/srv", 1, "claude", launchId);
    return f.connectors.prepare(launchId)!;
  })();
  await expect(f.connectors.call(denied, "files__reflect", {})).rejects.toThrow(/not granted/);
  const answer = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  await f.oauth.complete(answer, SESSION);
  expect(f.connectors.view(f.id).granted_tools).toEqual([]);
  await expect(f.connectors.call(granted, "files__reflect", {})).rejects.toThrow(/not granted/);
  await f.connectors.check(f.id); f.connectors.setTools(f.id, ["reflect"]);
  await expect(f.connectors.call(denied, "files__reflect", {})).rejects.toThrow(/not granted/);
  expect(await f.connectors.call(granted, "files__reflect", {})).toBeDefined();
});

test("the token actually sent is scrubbed, even when a concurrent refresh replaced it mid-call", async () => {
  let releaseTool!: () => void;
  const f = await connected();
  await f.ready();
  const token = f.launch();
  const first = f.p.state.current.access;
  f.p.mode.toolGate = new Promise<void>(resolve => { releaseTool = resolve; });
  const toolEntered = reached(f.p.mode, "tool");
  const slow = f.connectors.call(token, "files__reflect", {});
  await toolEntered;
  // Another call refreshes the grant while the first is still waiting on its result.
  f.p.mode.toolGate = undefined;
  f.tick(3_590_000);
  await f.connectors.call(token, "files__reflect", {});
  expect(f.p.state.current.access).not.toBe(first);
  releaseTool();
  const result = await slow;
  const text = JSON.stringify(result);
  expect(text).not.toContain(first);
  expect(text).toContain("[redacted]");
});

test("redaction covers catalog and initialize responses, keys and values, quotes and backslashes; short tokens are refused", async () => {
  const { redact } = await import("./connector-upstream");
  const tricky = 'tok"en\\\\with"quotes';
  const reflected = { serverInfo: { name: `srv ${tricky}` }, tools: [{ name: "t", description: `uses ${tricky} now`, inputSchema: { properties: { [tricky]: { description: tricky } } } }] };
  const clean = redact(reflected, [tricky]);
  expect(JSON.stringify(clean)).not.toContain("tok\\\"en");
  expect(clean.tools[0]!.description).toBe("uses [redacted] now");
  expect(Object.keys(clean.tools[0]!.inputSchema.properties)).toEqual(["[redacted]"]);
  // A server reflecting the token in initialize and tools/list: nothing stored or shown carries it.
  const f = await connected();
  const access = f.p.state.current.access;
  f.p.mode.reflectCatalog = true;
  await f.connectors.check(f.id);
  expect(JSON.stringify(f.connectors.view(f.id))).not.toContain(access);
  expect(JSON.stringify(f.database.query("SELECT catalog, server_info FROM mcp_connectors").get())).not.toContain(access);
  // Tokens shorter than 8 characters are not accepted at sign-in.
  const short = await connected({ shortAccess: true });
  expect(short.result).toBeInstanceOf(ConnectorError);
});

test("boundaries: a refused redirect after sending, a restart mid-refresh, and tokens issued but not kept", async () => {
  // A refresh answered with a redirect was sent: the server may have rotated. Reconnect; never retry the old token.
  const redirected = await connected({ refreshRedirect: true });
  await redirected.ready();
  const t1 = redirected.launch();
  redirected.tick(3_590_000);
  expect(await redirected.connectors.call(t1, "files__reflect", {}).then(() => null, e => e)).toBeInstanceOf(ConnectorError);
  await redirected.connectors.call(t1, "files__reflect", {}).catch(() => {});
  expect(redirected.p.state.refreshes).toBe(1);
  expect(grantRow(redirected)!.status).toBe("reconnect_required");

  // A refresh claimed by a process that then stopped: the next process must not retry it.
  const restarted = await connected();
  await restarted.ready();
  const t2 = restarted.launch();
  restarted.database.query("UPDATE connector_oauth_grants SET refresh_pending=1").run();
  expect(await restarted.connectors.call(t2, "files__reflect", {}).then(() => null, e => e)).toBeInstanceOf(ConnectorError);
  expect(restarted.p.state.refreshes).toBe(0);
  expect(grantRow(restarted)!.status).toBe("reconnect_required");

  // Identity validation fails after tokens were issued: they are revoked.
  const badIdentity = await connected({ idToken: (c: any) => signIdToken({ ...c, nonce: "wrong" }) });
  expect(badIdentity.result).toBeInstanceOf(ConnectorError);
  expect(badIdentity.p.state.revoked).toEqual(expect.arrayContaining([badIdentity.p.state.current.access, badIdentity.p.state.current.refresh]));

  // Disconnected while the code exchange was in flight: the new tokens are revoked, nothing is stored.
  let release!: () => void;
  const racing = provider({ tokenGate: new Promise<void>(resolve => { release = resolve; }) });
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const key = randomBytes(32);
  const connectors = new Connectors({ database, isLive: async () => true, env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" }, codec: () => createSecretCodec(key) });
  const oauth = new ConnectorOAuth({ connectors, origin: ORIGIN });
  const { id } = await connectors.add({ name: "Files", url: `${racing.base}/mcp` });
  connectors.setAuthMode(id, "oauth");
  const answer = racing.approve((await oauth.start(id, SESSION)).authorizationUrl);
  const tokenEntered = reached(racing.mode, "token");
  const pending = oauth.complete(answer, SESSION).then(() => null, e => e);
  await tokenEntered;
  await connectors.disconnectOAuth(id);
  release();
  expect(await pending).toBeInstanceOf(ConnectorError);
  expect(racing.state.revoked).toEqual(expect.arrayContaining([racing.state.current.access, racing.state.current.refresh]));
  expect(database.query("SELECT COUNT(*) AS n FROM connector_oauth_grants").get()).toEqual({ n: 0 });
});

test("a refreshed short-lived token is used, not rejected for being inside the refresh window", async () => {
  const f = await connected({ refreshExpiresIn: 30 });
  await f.ready();
  const token = f.launch();
  f.tick(3_590_000);
  const result = await f.connectors.call(token, "files__reflect", {});
  expect(result).toBeDefined();
  expect(f.p.state.refreshes).toBe(1);
  expect(f.p.hits.filter(h => h.body.includes("tools/call")).map(h => h.auth)).toEqual([`Bearer ${f.p.state.current.access}`]);
  // Once actually expired, the next call refreshes again rather than sending an expired token.
  f.tick(31_000);
  await f.connectors.call(token, "files__reflect", {});
  expect(f.p.state.refreshes).toBe(2);
});

test("OIDC §12.2: a refreshed ID token must match the original authentication; anything else requires reconnect and revokes the new tokens", async () => {
  const sign = (c: any, claims: Record<string, unknown> = {}, opts: { key?: CryptoKey; sub?: string; aud?: string | string[] } = {}) =>
    new SignJWT({ email: "dev@example.com", email_verified: true, ...claims }).setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`${c.base}/as`)
      .setAudience(opts.aud ?? c.clientId).setSubject(opts.sub ?? "user-123").setIssuedAt().setExpirationTime("10m").sign(opts.key ?? keys.privateKey);
  const cases: Array<[string, ((c: any) => Promise<string>) | undefined, boolean, Mode?]> = [
    ["same subject, nonce omitted", (c) => sign(c), true],
    ["same subject, same nonce", (c) => sign(c, { nonce: c.nonce }), true],
    ["no ID token returned", undefined, true],
    ["bad signature", (c) => sign(c, {}, { key: otherKeys.privateKey }), false],
    ["changed subject", (c) => sign(c, {}, { sub: "someone-else" }), false],
    ["wrong nonce", (c) => sign(c, { nonce: "different" }), false],
    ["changed audience", (c) => sign(c, { azp: c.clientId }, { aud: [c.clientId, "another-client"] }), false],
    ["different auth_time", (c) => sign(c, { auth_time: 12345 }), false],
    ["original identity never verified", (c) => sign(c), false, { oidc: false }],
  ];
  for (const [label, refreshIdToken, accepted, extra] of cases) {
    const f = await connected({ refreshIdToken, ...extra });
    await f.ready();
    const token = f.launch();
    const identity = f.connectors.view(f.id).auth.oauth!.identity;
    const before = f.p.hits.filter(h => h.body.includes("tools/call")).length;
    f.tick(3_590_000);
    const result = await f.connectors.call(token, "files__reflect", {}).then(r => r, e => e);
    const view = f.connectors.view(f.id).auth.oauth!;
    if (accepted) {
      expect(result, label).not.toBeInstanceOf(Error);
      expect(view.state, label).toBe("connected");
      expect(view.identity, label).toEqual(identity);
    } else {
      expect(result, label).toBeInstanceOf(ConnectorError);
      expect(view.state, label).toBe("reconnect_required");
      // The identity shown is never replaced by an unverified one.
      expect(view.identity, label).toEqual(identity);
      expect(f.p.state.revoked, label).toEqual(expect.arrayContaining([f.p.state.current.access, f.p.state.current.refresh]));
      expect(f.p.hits.filter(h => h.body.includes("tools/call")).length, label).toBe(before);
    }
  }
  // Only verified claims are stored, never the raw ID token.
  const f = await connected();
  const stored = f.database.query("SELECT oidc_context FROM connector_oauth_grants").get() as { oidc_context: string };
  expect(JSON.parse(stored.oidc_context)).toMatchObject({ sub: "user-123", aud: [expect.any(String)], nonce: expect.any(String), authTime: null });
  expect(stored.oidc_context).not.toContain("eyJ");
});

test("a refresh that could not be sent keeps the grant: the valid token keeps working, expiry fails without forcing sign-in, and refresh works once the server is back", async () => {
  const f = await connected();
  await f.ready();
  const token = f.launch();
  const real = (f.database.query("SELECT token_endpoint FROM connector_oauth_grants").get() as { token_endpoint: string }).token_endpoint;
  const closed = Bun.serve({ port: 0, fetch: () => new Response("") });
  const dead = `http://127.0.0.1:${closed.port}/token`; closed.stop(true);
  f.database.query("UPDATE connector_oauth_grants SET token_endpoint=?").run(dead);
  const first = f.p.state.current.access;
  f.tick(3_590_000); // 10s left: due for refresh, but the refresh cannot be sent
  expect(await f.connectors.call(token, "files__reflect", {})).toBeDefined();
  expect(f.p.hits.filter(h => h.body.includes("tools/call")).at(-1)!.auth).toBe(`Bearer ${first}`);
  const state = () => f.database.query("SELECT status, refresh_pending, token_version FROM connector_oauth_grants").get();
  expect(state()).toEqual({ status: "connected", refresh_pending: 0, token_version: 1 });
  f.tick(11_000); // now actually expired, endpoint still unreachable
  expect(await f.connectors.call(token, "files__reflect", {}).then(() => null, e => e)).toBeInstanceOf(ConnectorError);
  expect(state()).toEqual({ status: "connected", refresh_pending: 0, token_version: 1 });
  expect(f.p.state.refreshes).toBe(0);
  f.database.query("UPDATE connector_oauth_grants SET token_endpoint=?").run(real);
  expect(await f.connectors.call(token, "files__reflect", {})).toBeDefined();
  expect(f.p.state.refreshes).toBe(1);
});

test("without a refresh token, the access token is used until it actually expires, then sign-in is required", async () => {
  const f = await connected({ noRefreshToken: true, expiresIn: 30 });
  await f.ready();
  const token = f.launch();
  f.tick(15_000);
  expect(await f.connectors.call(token, "files__reflect", {})).toBeDefined();
  expect(f.connectors.view(f.id).auth.oauth!.state).toBe("connected");
  f.tick(15_000);
  expect(await f.connectors.call(token, "files__reflect", {}).then(() => null, e => e)).toBeInstanceOf(ConnectorError);
  expect(f.connectors.view(f.id).auth.oauth!.state).toBe("reconnect_required");
  expect(f.p.state.refreshes).toBe(0);
  // A resource rejection before expiry (the 401 sentinel) also ends it, without a refresh attempt.
  const g = await connected({ noRefreshToken: true, expiresIn: 30 });
  await g.ready();
  const t = g.launch();
  g.p.mode.reject401 = true;
  await g.connectors.call(t, "files__reflect", {}).catch(() => {});
  g.p.mode.reject401 = false;
  expect(await g.connectors.call(t, "files__reflect", {}).then(() => null, e => e)).toBeInstanceOf(ConnectorError);
  expect(g.connectors.view(g.id).auth.oauth!.state).toBe("reconnect_required");
  expect(g.p.state.refreshes).toBe(0);
});

test("signing in again keeps the current account until a verified replacement completes", async () => {
  const f = await connected({ freshOnCode: true });
  await f.ready();
  const token = f.launch();
  const before = f.connectors.view(f.id);
  const original = { ...f.p.state.current };
  const works = async () => {
    const result = await f.connectors.call(token, "files__reflect", {});
    expect(result).toBeDefined();
    expect(f.p.hits.filter(h => h.body.includes("tools/call")).at(-1)!.auth).toBe(`Bearer ${original.access}`);
  };
  const unchanged = () => {
    const view = f.connectors.view(f.id);
    expect(view.auth.oauth).toEqual(before.auth.oauth);
    expect(view.granted_tools).toEqual(["reflect"]);
  };
  // Discovery fails: nothing changes.
  f.p.mode.prmMissing = true;
  await expect(f.oauth.start(f.id, SESSION)).rejects.toBeInstanceOf(ConnectorError);
  f.p.mode.prmMissing = false;
  unchanged(); await works();
  // Consent denied: nothing changes.
  const denied = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  await expect(f.oauth.complete({ state: denied.state, iss: denied.iss, error: "access_denied" }, SESSION)).rejects.toThrow(/declined/);
  unchanged(); await works();
  // Abandoned: started, never completed.
  await f.oauth.start(f.id, SESSION);
  unchanged(); await works();
  expect(f.p.state.revoked).toEqual([]);

  // A verified sign-in with another account replaces the grant atomically.
  f.p.mode.idToken = (c: any) => new SignJWT({ nonce: c.nonce, email: "other@example.com", email_verified: true, name: "Other" })
    .setProtectedHeader({ alg: "RS256", kid: "k1" }).setIssuer(`${c.base}/as`).setAudience(c.clientId).setSubject("user-456").setIssuedAt().setExpirationTime("10m").sign(keys.privateKey);
  const answer = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  const view = await f.oauth.complete(answer, SESSION);
  expect(view.auth.oauth!.identity).toEqual({ subject: "user-456", email: "other@example.com", name: "Other" });
  expect(view.granted_tools).toEqual([]);
  // Replacement is local: nothing is revoked at the provider (a shared grant family could take the new sign-in with it).
  expect(f.p.hits.filter(h => h.path === "/as/revoke")).toEqual([]);
  // Agents need fresh tool approval for the new account.
  await expect(f.connectors.call(token, "files__reflect", {})).rejects.toThrow(/not granted/);
  await f.connectors.check(f.id); f.connectors.setTools(f.id, ["reflect"]);
  await f.connectors.call(token, "files__reflect", {});
  expect(f.p.hits.filter(h => h.body.includes("tools/call")).at(-1)!.auth).toBe(`Bearer ${f.p.state.current.access}`);
});

test("a refresh of the old grant racing a replacement cannot restore it; its late tokens are revoked", async () => {
  let release!: () => void;
  const f = await connected({ freshOnCode: true, acceptAnyRefresh: true });
  await f.ready();
  const token = f.launch();
  f.tick(3_590_000);
  f.p.mode.refreshGate = new Promise<void>(resolve => { release = resolve; });
  const entered = reached(f.p.mode, "refresh");
  const oldCall = f.connectors.call(token, "files__reflect", {}).then(r => r, e => e);
  await entered;
  // The replacement completes while the old grant's refresh is still at the provider.
  const answer = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  const replaced = await f.oauth.complete(answer, SESSION);
  const newGrant = { ...f.p.state.current };
  const lateRevoked = new Promise<string>(resolve => { f.p.mode.onRevoke = (t: string) => { if (t.startsWith("ref_") && t !== newGrant.refresh) resolve(t); }; });
  release();
  expect(await oldCall).toBeInstanceOf(ConnectorError);
  const late = await lateRevoked;
  expect(late).not.toBe(newGrant.refresh);
  const view = f.connectors.view(f.id);
  expect(view.auth.oauth!.state).toBe("connected");
  expect(view.auth.oauth!.connectedSince).toBe(replaced.auth.oauth!.connectedSince);
  expect(f.database.query("SELECT token_version FROM connector_oauth_grants").get()).toEqual({ token_version: 1 });
  expect(f.p.state.revoked).not.toContain(newGrant.access);
});

test("an earlier callback still exchanging when a newer sign-in starts cannot commit; the newer one can", async () => {
  let releaseA!: () => void;
  const f = await connected({ freshOnCode: true });
  await f.ready();
  const token = f.launch();
  const original = { ...f.p.state.current };
  const a = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  // A's callback is claimed and its code exchange is held at the provider.
  f.p.mode.tokenGate = new Promise<void>(resolve => { releaseA = resolve; });
  const exchanging = reached(f.p.mode, "token");
  const completingA = f.oauth.complete(a, SESSION).then(() => null, e => e);
  await exchanging;
  f.p.mode.tokenGate = undefined;
  const aTokens = { ...f.p.state.current };
  // B starts while A is still exchanging; then A finishes.
  const b = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  releaseA();
  expect(await completingA).toBeInstanceOf(ConnectorError);
  expect(f.p.state.revoked).toEqual(expect.arrayContaining([aTokens.access, aTokens.refresh]));
  // The original grant still works until B completes.
  await f.connectors.call(token, "files__reflect", {});
  expect(f.p.hits.filter(h => h.body.includes("tools/call")).at(-1)!.auth).toBe(`Bearer ${original.access}`);
  // B, the latest attempt, still completes.
  const view = await f.oauth.complete(b, SESSION);
  expect(view.auth.oauth!.state).toBe("connected");
  expect(f.p.state.revoked).not.toContain(f.p.state.current.access);
});

test("a slow earlier start cannot supersede a newer one", async () => {
  let releaseA!: () => void;
  const f = await connected();
  f.p.mode.prmGate = new Promise<void>(resolve => { releaseA = resolve; });
  const discovering = reached(f.p.mode, "prm");
  const startingA = f.oauth.start(f.id, SESSION).then(r => r, e => e);
  await discovering;
  const b = f.p.approve((await f.oauth.start(f.id, SESSION)).authorizationUrl);
  releaseA();
  expect(await startingA).toBeInstanceOf(ConnectorError);
  // B's pending sign-in survived A's late discovery and completes.
  expect((await f.oauth.complete(b, SESSION)).auth.oauth!.state).toBe("connected");
});
