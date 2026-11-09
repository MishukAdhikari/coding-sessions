import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { createSecretStore, type SourceDependencies } from "./secret-store";
import { cleanReason, REQUEST_TTL_MS, SecretRequestError, SecretRequests, type ConnectorPort, type Requester } from "./secret-requests";
import { Connectors, type ConnectorView } from "./connectors";
import { handleSecretRequestsRoute } from "./secret-requests-route";
import { createStepUpGrants } from "./step-up";

const VALUE = "sk-live-VERY-SECRET-value-123";
const noSources: SourceDependencies = {
  fetch: (async () => { throw new Error("no network"); }) as unknown as typeof fetch,
  runBws: async () => ({ code: 127, out: "" }),
};
const session = (screen = "cs-alpha", launchId = "launch-a", agent = "claude"): Requester =>
  ({ by: "session", launchId, screen, sessionName: screen.slice(3), agent });

function fixture(over: { connectors?: ConnectorPort } = {}) {
  let clock = 1_000_000;
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const store = createSecretStore({ database, codec: createSecretCodec(randomBytes(32)), sources: noSources, now: () => clock });
  const logs: string[] = [];
  let changed = 0;
  const requests = new SecretRequests({
    database, origin: "https://cs.example.com", secrets: () => store, connectors: over.connectors,
    now: () => clock, log: line => logs.push(line), onSecretsChanged: () => { changed++; },
    secretsFile: id => `/run/cs/${id}.env`,
    inLaunchEnvironment: async () => "missing",
  });
  return { database, store, requests, logs, tick: (ms: number) => { clock += ms; }, changes: () => changed };
}
const tokenOf = (url: string) => url.split("#secret-request=")[1]!;

test("a request returns a one-time link on the configured origin and stores only the token's hash", async () => {
  const f = fixture();
  const created = await f.requests.create({ name: "KAZTRACK_TOKEN", reason: "Call the KazTrack API for the sprint report." }, session());
  expect(created.url).toMatch(/^https:\/\/cs\.example\.com\/#secret-request=csreq_[A-Za-z0-9_-]{43}$/);
  const token = tokenOf(created.url);
  const row = f.database.query("SELECT * FROM secret_requests").get() as Record<string, unknown>;
  expect(JSON.stringify(row)).not.toContain(token);
  expect(row.token_hash).toBe(createHash("sha256").update(token).digest("hex"));
  expect(row.state).toBe("pending");
  expect(row.expires_at).toBe(1_000_000 + REQUEST_TTL_MS);
});

test("lookup shows who asks and why; fulfil stores a sealed secret, burns the link and refreshes running sessions", async () => {
  const f = fixture();
  const { url } = await f.requests.create({ name: "KAZTRACK_TOKEN", reason: "Sprint report" }, session());
  const token = tokenOf(url);
  const view = f.requests.lookup({ token });
  expect(view).toMatchObject({ name: "KAZTRACK_TOKEN", reason: "Sprint report", requested_by: "session", session: { name: "alpha", agent: "claude", id: "m:cs-alpha" }, existing: { set: false } });
  const done = f.requests.fulfilSecret({ token }, VALUE, { stepUp: () => { throw new Error("not needed"); } });
  expect(done).toEqual({ ok: true, name: "KAZTRACK_TOKEN", state: "fulfilled" });
  expect(await f.store.sessionEnv()).toEqual({ KAZTRACK_TOKEN: VALUE });
  expect(f.changes()).toBe(1);
  const row = f.database.query("SELECT state, token_hash FROM secret_requests").get() as Record<string, unknown>;
  expect(row).toEqual({ state: "fulfilled", token_hash: null });
  expect(() => f.requests.lookup({ token })).toThrow(/expired or was already used/);
  expect(() => f.requests.fulfilSecret({ token }, "again", { stepUp: () => true })).toThrow(SecretRequestError);
});

test("decline ends the request and clears its hash; the link no longer works", async () => {
  const f = fixture();
  const { url } = await f.requests.create({ name: "API_KEY", reason: "Testing the client" }, session());
  expect(f.requests.decline({ token: tokenOf(url) })).toEqual({ ok: true, state: "declined" });
  expect(f.database.query("SELECT state, token_hash FROM secret_requests").get()).toEqual({ state: "declined", token_hash: null });
  expect(() => f.requests.fulfilSecret({ token: tokenOf(url) }, VALUE, { stepUp: () => true })).toThrow(/expired or was already used/);
  expect(await f.store.sessionEnv()).toEqual({});
});

test("a link expires after 15 minutes", async () => {
  const f = fixture();
  const { url } = await f.requests.create({ name: "API_KEY", reason: "Testing the client" }, session());
  f.tick(REQUEST_TTL_MS);
  expect(() => f.requests.lookup({ token: tokenOf(url) })).toThrow(/expired/);
  expect(f.database.query("SELECT state, token_hash FROM secret_requests").get()).toEqual({ state: "expired", token_hash: null });
  expect((await f.requests.secretStatus("API_KEY", { launchId: "launch-a", screen: "cs-alpha" })).request).toMatchObject({ state: "expired" });
});

test("unknown, malformed and guessed tokens are refused the same way", async () => {
  const f = fixture();
  await f.requests.create({ name: "API_KEY", reason: "Testing the client" }, session());
  for (const token of ["", "csreq_short", `csreq_${"A".repeat(43)}`, 42, null]) {
    expect(() => f.requests.lookup({ token })).toThrow(/expired or was already used/);
  }
  // A token, when present, is the only key: an id alongside a bad token does not open it.
  const id = (f.database.query("SELECT id FROM secret_requests").get() as { id: string }).id;
  expect(() => f.requests.lookup({ token: "bad", id })).toThrow(/expired/);
  expect(f.requests.lookup({ id }).name).toBe("API_KEY");
});

test("names follow the Secrets rules and reasons are bounded plain text", async () => {
  const f = fixture();
  for (const name of ["lower", "1ABC", "WITH-DASH", "PATH", "LD_PRELOAD", "CS_COMMUNICATOR_TOKEN", "A".repeat(65), undefined]) {
    await expect(f.requests.create({ name, reason: "A good reason" }, session())).rejects.toThrow(SecretRequestError);
  }
  await expect(f.requests.create({ name: "OK_NAME", reason: "x" }, session())).rejects.toThrow(/reason/);
  await expect(f.requests.create({ name: "OK_NAME", reason: "y".repeat(501) }, session())).rejects.toThrow(/under 500/);
  expect(cleanReason("Use‮evil\u0007 this\r\n\n\n\nplease")).toBe("Useevil this\n\nplease");
});

test("replacing an existing value needs Replace and a step-up; a secret-manager name counts as existing", async () => {
  const f = fixture();
  f.store.set("GITHUB_TOKEN", "old-value");
  const { url } = await f.requests.create({ name: "GITHUB_TOKEN", reason: "Open the pull request" }, session());
  const token = tokenOf(url);
  expect(f.requests.lookup({ token }).existing).toMatchObject({ set: true, source: "Coding Sessions" });
  let spent = 0;
  expect(() => f.requests.fulfilSecret({ token }, VALUE, { stepUp: () => { spent++; return true; } })).toThrow(/Choose Replace/);
  expect(spent).toBe(0);
  expect(() => f.requests.fulfilSecret({ token }, VALUE, { replace: true, stepUp: () => false })).toThrow(/Confirm it's you/);
  expect(await f.store.sessionEnv()).toEqual({ GITHUB_TOKEN: "old-value" });
  f.requests.fulfilSecret({ token }, VALUE, { replace: true, stepUp: () => true });
  expect(await f.store.sessionEnv()).toEqual({ GITHUB_TOKEN: VALUE });

  f.database.query("INSERT INTO secret_sources (kind,label,config,credential,names,last_sync_at,created_at) VALUES ('vault','Team Vault','{}','x',?,5,1)").run(JSON.stringify(["VAULT_ONLY"]));
  const second = await f.requests.create({ name: "VAULT_ONLY", reason: "Deploy key" }, session());
  expect(f.requests.lookup({ token: tokenOf(second.url) }).existing).toMatchObject({ set: true, source: "Team Vault" });
  expect(() => f.requests.fulfilSecret({ token: tokenOf(second.url) }, VALUE, { stepUp: () => true })).toThrow(/from Team Vault/);
});

test("rate limits per session and in total; a repeat request replaces the older link", async () => {
  const f = fixture();
  const first = await f.requests.create({ name: "ONE", reason: "first try" }, session());
  const again = await f.requests.create({ name: "ONE", reason: "second try" }, session());
  expect(() => f.requests.lookup({ token: tokenOf(first.url) })).toThrow(/expired/);
  expect(f.requests.lookup({ token: tokenOf(again.url) }).reason).toBe("second try");
  await f.requests.create({ name: "TWO", reason: "needed" }, session());
  await f.requests.create({ name: "THREE", reason: "needed" }, session());
  await expect(f.requests.create({ name: "FOUR", reason: "needed" }, session())).rejects.toThrow(/already has 3 requests/);
  // Another session is unaffected; the total cap still applies across everyone.
  for (let i = 0; i < 3; i++) await f.requests.create({ name: `OTHER_${i}`, reason: "needed" }, session("cs-beta", "launch-b"));
  for (let i = 0; i < 14; i++) await f.requests.create({ name: `OP_${i}`, reason: "needed" }, { by: "operator", launchId: null, screen: null, sessionName: null, agent: null });
  await expect(f.requests.create({ name: "OP_X", reason: "needed" }, { by: "operator", launchId: null, screen: null, sessionName: null, agent: null })).rejects.toThrow(/20 requests/);
  // Ten created in ten minutes from one session, even when they were answered.
  const g = fixture();
  for (let i = 0; i < 10; i++) {
    const { url } = await g.requests.create({ name: `N_${i}`, reason: "needed" }, session());
    g.requests.decline({ token: tokenOf(url) });
  }
  await expect(g.requests.create({ name: "N_X", reason: "needed" }, session())).rejects.toThrow(/wait ten minutes/);
  g.tick(10 * 60_000 + 1);
  await g.requests.create({ name: "N_X", reason: "needed" }, session());
});

test("status and list report names, sources and states, never values", async () => {
  const f = fixture();
  f.store.set("STORED_BEFORE", VALUE);
  const caller = { launchId: "launch-a", screen: "cs-alpha" };
  const status = await f.requests.secretStatus("STORED_BEFORE", caller);
  expect(status).toMatchObject({ name: "STORED_BEFORE", set: true, source: "Coding Sessions", secrets_file: "/run/cs/launch-a.env", available_in_secrets_file: true });
  expect(String(status.next)).toContain("CS_SECRETS_FILE");
  const missing = await f.requests.secretStatus("NOT_THERE", caller);
  expect(missing).toMatchObject({ set: false, request: null });
  expect(String(missing.next)).toContain("request_secret");
  const list = await f.requests.listSecrets({ launchId: "launch-a" });
  expect(list.secrets).toEqual([{ name: "STORED_BEFORE", source: "Coding Sessions", updated_at: new Date(1_000_000).toISOString(), in_launch_environment: "missing" }]);
  // Requests made by one session are not visible in another's status.
  await f.requests.create({ name: "SCOPED", reason: "only mine" }, session());
  expect((await f.requests.secretStatus("SCOPED", caller)).request).toMatchObject({ state: "pending" });
  expect((await f.requests.secretStatus("SCOPED", { launchId: "launch-b", screen: "cs-beta" })).request).toBeNull();
  for (const text of [JSON.stringify(status), JSON.stringify(list), ...f.logs]) expect(text).not.toContain(VALUE);
});

test("audit lines carry ids, names and outcomes, never values, tokens or reasons", async () => {
  const f = fixture();
  const { url } = await f.requests.create({ name: "AUDITED", reason: "private context here" }, session());
  f.requests.fulfilSecret({ token: tokenOf(url) }, VALUE, { stepUp: () => true });
  expect(f.logs).toHaveLength(2);
  expect(f.logs[0]).toMatch(/^secret-request [0-9a-f-]{36} secret AUDITED by=session session=cs-alpha created$/);
  expect(f.logs[1]).toMatch(/fulfilled$/);
  for (const line of f.logs) for (const hidden of [VALUE, tokenOf(url), "private context"]) expect(line).not.toContain(hidden);
});

/* ---------- connectors ---------- */

function connectorView(over: Partial<ConnectorView> = {}): ConnectorView {
  return {
    id: "11111111-1111-4111-8111-111111111111", name: "KazTrack", namespace: "kaztrack", url: "https://mcp.kaztrack.example/mcp", host: "mcp.kaztrack.example",
    auth: { mode: "bearer", oauth: null }, oauth_client: null, enabled: true, state: "not_checked", credential: { set: false, set_at: null },
    server: null, checked_at: null, last_ok_at: null, check_detail: null, tools: [], discovered_count: 0, granted_tools: [], default_providers: [], launches: [],
    ...over,
  };
}

function fakeConnectors(checkState: ConnectorView["state"] = "connected") {
  let current: ConnectorView | null = null;
  const calls: Array<[string, ...unknown[]]> = [];
  const port: ConnectorPort = {
    list: () => current ? [current] : [],
    view: () => current!,
    add: async (input) => { calls.push(["add", input.name, input.url, typeof input.token]); current = connectorView({ auth: { mode: input.token ? "bearer" : "none", oauth: null }, credential: { set: !!input.token, set_at: 1 } }); return current; },
    setCredential: (_id, value) => { calls.push(["setCredential", typeof value]); current = { ...current!, credential: { set: true, set_at: 2 } }; return current; },
    setAuthMode: (_id, mode) => { calls.push(["setAuthMode", mode]); current = { ...current!, auth: { mode: mode as "oauth", oauth: null } }; return current; },
    setDefaultProviders: (_id, providers) => { calls.push(["setDefaultProviders", providers]); current = { ...current!, default_providers: providers as never }; return current; },
    setLaunchGrant: (_id, launchId, granted) => { calls.push(["setLaunchGrant", launchId, granted]); return current!; },
    setTools: (_id, tools) => { calls.push(["setTools", tools]); current = { ...current!, granted_tools: tools as string[] }; return current; },
    check: async () => {
      calls.push(["check"]);
      current = { ...current!, state: checkState, tools: checkState === "connected" ? [
        { name: "list_issues", exposed: "kaztrack__list_issues", title: null, description: null, hints: {}, granted: false, offered: true },
        { name: "clash", exposed: null, title: null, description: null, hints: {}, granted: false, offered: true },
      ] : [] };
      return current;
    },
  };
  return { port, calls };
}

test("a bearer connector request stores the token through Connectors, grants the agent and tools after a good check", async () => {
  const fake = fakeConnectors();
  const f = fixture({ connectors: fake.port });
  const { url } = await f.requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Read sprint issues" }, session());
  const token = tokenOf(url);
  expect(f.requests.lookup({ token })).toMatchObject({ kind: "connector", host: "mcp.kaztrack.example", auth: "bearer", connector: null });
  await expect(f.requests.connectorBearer({ token }, VALUE, { stepUp: () => false })).rejects.toThrow(/Confirm it's you/);
  const result = await f.requests.connectorBearer({ token }, VALUE, { stepUp: () => true });
  expect(result).toMatchObject({ ok: true, state: "fulfilled", connector: { tools: 1 } });
  expect(fake.calls).toEqual([
    ["add", "KazTrack", "https://mcp.kaztrack.example/mcp", "string"], ["check"],
    ["setDefaultProviders", ["claude"]], ["setLaunchGrant", "launch-a", true], ["setTools", ["list_issues"]],
  ]);
  expect(JSON.stringify(result)).not.toContain(VALUE);
  expect(() => f.requests.lookup({ token })).toThrow(/expired/);
});

test("a failed check keeps the connector request pending with the reason, so the same link can retry", async () => {
  const fake = fakeConnectors("auth_failed");
  const f = fixture({ connectors: fake.port });
  const { url } = await f.requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Read sprint issues" }, session());
  const result = await f.requests.connectorBearer({ token: tokenOf(url) }, "wrong", { stepUp: () => true });
  expect(result).toMatchObject({ ok: false, state: "pending", connector_state: "auth_failed", detail: "The server refused the credential." });
  expect(f.requests.lookup({ token: tokenOf(url) }).detail).toBe("The server refused the credential.");
  expect(fake.calls.some(([name]) => name === "setTools")).toBe(false);
});

test("a connector name already pointing elsewhere is refused", async () => {
  const fake = fakeConnectors();
  const f = fixture({ connectors: fake.port });
  await fake.port.add({ name: "KazTrack", url: "https://mcp.kaztrack.example/mcp" });
  const { url } = await f.requests.create({ kind: "connector", name: "kaztrack", url: "https://evil.example/mcp", reason: "trust me" }, session());
  expect(f.requests.lookup({ token: tokenOf(url) }).connector).toMatchObject({ url_matches: false });
  await expect(f.requests.connectorBearer({ token: tokenOf(url) }, VALUE, { stepUp: () => true })).rejects.toThrow(/already points to mcp\.kaztrack\.example/);
});

test("an OAuth connector request switches the connector to OAuth and finishes when sign-in completes", async () => {
  const fake = fakeConnectors();
  const f = fixture({ connectors: fake.port });
  const { url } = await f.requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Read sprint issues", auth: "oauth" }, session("cs-alpha", "launch-a", "cmd:gemini"));
  const started = await f.requests.connectorOAuth({ token: tokenOf(url) });
  expect(started).toEqual({ ok: true, state: "pending", connector_id: "11111111-1111-4111-8111-111111111111", next: "oauth" });
  expect(fake.calls).toContainEqual(["setAuthMode", "oauth"]);
  await f.requests.oauthConnected("11111111-1111-4111-8111-111111111111");
  expect(fake.calls).toContainEqual(["setDefaultProviders", ["presets"]]);
  expect(f.requests.connectorStatus("KazTrack", { launchId: "launch-a", screen: "cs-alpha" })).toMatchObject({
    exists: true, state: "connected", granted_tools: 1, this_session: { has_connectors_gateway: false }, request: { state: "fulfilled" },
  });
});

test("an OAuth request never wipes an existing connector's token without a step-up, and a stale connection falls through to sign-in", async () => {
  const fake = fakeConnectors("auth_failed");
  const f = fixture({ connectors: fake.port });
  await fake.port.add({ name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", token: "existing" });
  const { url } = await f.requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Sign in instead", auth: "oauth" }, session());
  await expect(f.requests.connectorOAuth({ token: tokenOf(url) }, { stepUp: () => false })).rejects.toThrow(/Confirm it's you/);
  expect(fake.calls.some(([name]) => name === "setAuthMode")).toBe(false);
  const started = await f.requests.connectorOAuth({ token: tokenOf(url) }, { stepUp: () => true });
  expect(started).toMatchObject({ ok: true, state: "pending", next: "oauth", connector_id: "11111111-1111-4111-8111-111111111111" });
  expect(fake.calls).toContainEqual(["setAuthMode", "oauth"]);
});

test("a working existing connector is granted without switching modes, and keeps tools the member narrowed", async () => {
  const fake = fakeConnectors("connected");
  const f = fixture({ connectors: fake.port });
  await fake.port.add({ name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", token: "existing" });
  fake.port.setTools("x", ["only_this"]);
  const { url } = await f.requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Use it", auth: "oauth" }, session());
  const done = await f.requests.connectorOAuth({ token: tokenOf(url) }, { stepUp: () => { throw new Error("not needed"); } });
  expect(done).toMatchObject({ ok: true, state: "fulfilled" });
  expect(fake.calls.filter(([name]) => name === "setTools")).toEqual([["setTools", ["only_this"]]]);
  expect(fake.calls.some(([name]) => name === "setAuthMode")).toBe(false);
});

test("a request that ends while the connection check runs grants nothing", async () => {
  const fake = fakeConnectors("connected");
  const f = fixture({ connectors: fake.port });
  const { url } = await f.requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Use it" }, session());
  const check = fake.port.check;
  fake.port.check = async (id) => { f.requests.decline({ token: tokenOf(url) }); return check(id); };
  await expect(f.requests.connectorBearer({ token: tokenOf(url) }, VALUE, { stepUp: () => true })).rejects.toThrow(/expired or was already used/);
  expect(fake.calls.some(([name]) => name === "setTools" || name === "setDefaultProviders" || name === "setLaunchGrant")).toBe(false);
});

test("invalid connector requests are refused before anything is stored", async () => {
  const f = fixture({ connectors: fakeConnectors().port });
  for (const input of [
    { kind: "connector", name: "X", url: "http://insecure.example/mcp", reason: "needed" },
    { kind: "connector", name: "X", url: "https://10.0.0.1/mcp", reason: "needed" },
    { kind: "connector", name: "", url: "https://ok.example/mcp", reason: "needed" },
    { kind: "connector", name: "X", url: "https://ok.example/mcp", reason: "needed", auth: "basic" },
  ]) await expect(f.requests.create(input, session())).rejects.toThrow(SecretRequestError);
  expect((f.database.query("SELECT COUNT(*) AS n FROM secret_requests").get() as { n: number }).n).toBe(0);
});

test("with the real connector store, a bearer token is sealed in the connector row and an unreachable server keeps the request open", async () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const codec = createSecretCodec(randomBytes(32));
  const connectors = new Connectors({
    database, isLive: async () => true, codec: () => codec,
    resolver: async () => [{ address: "93.184.216.34", family: 4 }],
    fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch,
  });
  const store = createSecretStore({ database, codec, sources: noSources, now: () => 1 });
  const requests = new SecretRequests({ database, origin: "https://cs.example", secrets: () => store, connectors });
  const { url } = await requests.create({ kind: "connector", name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Sprint tools" }, session());
  const result = await requests.connectorBearer({ token: tokenOf(url) }, VALUE, { stepUp: () => true });
  expect(result).toMatchObject({ ok: false, state: "pending" });
  const row = database.query("SELECT credential, auth_mode FROM mcp_connectors").get() as { credential: string; auth_mode: string };
  expect(row.auth_mode).toBe("bearer");
  expect(row.credential).toStartWith("cs:secret:v1:");
  expect(row.credential).not.toContain(VALUE);
  expect(JSON.stringify(connectors.list())).not.toContain(VALUE);
  expect(requests.lookup({ token: tokenOf(url) }).connector).toMatchObject({ credential_set: true, url_matches: true });
});

/* ---------- route ---------- */

function routeFixture() {
  const f = fixture();
  const grants = createStepUpGrants();
  const deps = (browser = true, bearer = false) => ({
    cookieName: "cs", origin: "https://cs.example.com", checkBrowserSession: () => browser,
    isAuthenticated: () => browser || bearer, requests: () => f.requests, grants,
  });
  const post = (path: string, body: unknown, options: { origin?: string; browser?: boolean; bearer?: boolean } = {}) =>
    handleSecretRequestsRoute(new Request(`https://cs.example.com/api/secret-requests/${path}`, {
      method: "POST", body: JSON.stringify(body),
      headers: { cookie: "cs=session-token", origin: options.origin ?? "https://cs.example.com", "content-type": "application/json" },
    }), deps(options.browser ?? true, options.bearer ?? false));
  return { ...f, grants, deps, post };
}

test("the route answers only a browser session from this origin, and never returns a value", async () => {
  const r = routeFixture();
  const { url } = await r.requests.create({ name: "ROUTE_TOKEN", reason: "Route test" }, session());
  const token = tokenOf(url);
  expect((await r.post("lookup", { token }, { browser: false }))!.status).toBe(401);
  expect((await r.post("lookup", { token }, { browser: false, bearer: true }))!.status).toBe(403);
  expect((await r.post("fulfil", { token, value: VALUE }, { origin: "https://evil.example" }))!.status).toBe(403);
  expect(await handleSecretRequestsRoute(new Request("https://cs.example.com/api/other"), r.deps())).toBeNull();

  const looked = await r.post("lookup", { token });
  expect((await looked!.json() as any).request).toMatchObject({ name: "ROUTE_TOKEN", reason: "Route test" });
  const listed = await handleSecretRequestsRoute(new Request("https://cs.example.com/api/secret-requests", { headers: { cookie: "cs=session-token" } }), r.deps());
  expect((await listed!.json() as any).requests).toHaveLength(1);

  const saved = await r.post("fulfil", { token, value: VALUE });
  expect(saved!.status).toBe(200);
  const text = await saved!.text();
  expect(text).not.toContain(VALUE);
  expect(JSON.parse(text)).toEqual({ ok: true, name: "ROUTE_TOKEN", state: "fulfilled" });
  const again = await r.post("fulfil", { token, value: VALUE });
  expect(again!.status).toBe(410);
});

test("Replace through the route spends a step-up grant bound to this browser session", async () => {
  const r = routeFixture();
  r.store.set("REPLACE_ME", "old");
  const { url } = await r.requests.create({ name: "REPLACE_ME", reason: "Rotate the key" }, session());
  const token = tokenOf(url);
  expect((await r.post("fulfil", { token, value: VALUE }))!.status).toBe(409);
  expect((await (await r.post("fulfil", { token, value: VALUE, replace: true }))!.json() as any).code).toBe("step_up");
  const otherSessionGrant = r.grants.issue("another-session");
  expect((await r.post("fulfil", { token, value: VALUE, replace: true, grant: otherSessionGrant }))!.status).toBe(403);
  const grant = r.grants.issue("session-token");
  expect((await r.post("fulfil", { token, value: VALUE, replace: true, grant }))!.status).toBe(200);
  expect(await r.store.sessionEnv()).toEqual({ REPLACE_ME: VALUE });
});

test("decline and connector auth choice go through the route; settings can act by id", async () => {
  const r = routeFixture();
  const { url } = await r.requests.create({ name: "DECLINED", reason: "Not today" }, session());
  const id = (r.database.query("SELECT id FROM secret_requests").get() as { id: string }).id;
  expect((await r.post("lookup", { id }))!.status).toBe(200);
  expect(await (await r.post("decline", { id }))!.json()).toEqual({ ok: true, state: "declined" });
  expect((await r.post("lookup", { token: tokenOf(url) }))!.status).toBe(410);
  expect((await r.post("connector", { id, auth: "basic" }))!.status).toBe(400);
  expect((await r.post("unknown", { id }))!.status).toBe(404);
});
