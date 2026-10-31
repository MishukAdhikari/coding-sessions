import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { ConnectorError, Connectors, validateArguments } from "./connectors";
import { handleConnectorRequest } from "./connector-mcp";
import { handleConnectorsRoute } from "./connectors-route";
import { PRESETS, presetEndpoint } from "./connector-presets";
import { UpstreamClient } from "./connector-upstream";

const CANARY = "xcdev_tok_CANARY_9f8e7d6c5b4a3210";
const INSTRUCTIONS = "You are connected to the xcdev lab (disposable xCloud control planes and real servers) as lab-agent (qa).\n\nStart with lab_list.";
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const BASE_TOOLS = [
  { name: "lab_list", description: "List labs", inputSchema: schema({ mine: { type: "boolean" } }) },
  { name: "env_status", description: "Env status", inputSchema: schema({ environment: { type: "string" } }, ["environment"]) },
  { name: "qa_guide", description: "Guide", inputSchema: schema() },
  { name: "server_exec", description: "Run a shell command", inputSchema: schema({ command: { type: "string" } }) },
];

interface Mock {
  url: string;
  seen: Array<{ method: string; auth: string | null; id: unknown; params: any; session: string | null; version: string | null }>;
  tools: typeof BASE_TOOLS;
  mode: Record<string, unknown>;
  gate: { wait?: Promise<void> };
  stop(): void;
}
const servers: Array<{ stop(): void }> = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(); });

function mockUpstream(): Mock {
  const mock: Mock = { url: "", seen: [], tools: [...BASE_TOOLS], mode: {}, gate: {}, stop() {} };
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const auth = req.headers.get("authorization");
      if (mock.mode.redirect) return Response.redirect("http://169.254.169.254/latest", 302);
      if (mock.mode.status) return new Response(`denied for ${auth}`, { status: mock.mode.status as number });
      if (auth !== `Bearer ${CANARY}` && auth !== "Bearer second-credential-0000") return new Response(`bad token ${auth}`, { status: 401 });
      const msg = await req.json() as any;
      mock.seen.push({ method: msg.method, auth, id: msg.id, params: msg.params, session: req.headers.get("mcp-session-id"), version: req.headers.get("mcp-protocol-version") });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      const reply = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
      let body: unknown;
      if (msg.method === "initialize") {
        if (mock.mode.slowInit) await mock.mode.slowInit;
        body = reply({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mock" }, instructions: (mock.mode.instructions as string) ?? INSTRUCTIONS });
      } else if (msg.method === "tools/list") body = reply({ tools: mock.tools });
      else if (msg.method === "tools/call") {
        if (mock.gate.wait) await mock.gate.wait;
        if (mock.mode.rpcError) body = { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `invalid: header was Bearer ${CANARY}` } };
        else if (mock.mode.huge) body = reply({ content: [{ type: "text", text: "x".repeat(5 * 1024 * 1024) }] });
        else body = reply({ content: [{ type: "text", text: mock.mode.echo ? `token ${CANARY}` : `ok ${msg.params.name}` }], structuredContent: { tool: msg.params.name, args: msg.params.arguments } });
      } else body = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "nope" } };
      if (mock.mode.sse) {
        const events = [
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" })}\n\n`,
          `: keep-alive\n\nevent: message\ndata: ${JSON.stringify(body)}\n\n`,
        ];
        return new Response(events.join(""), { headers: { "content-type": "text/event-stream" } });
      }
      return Response.json(body, { headers: mock.mode.sessionId ? { "mcp-session-id": mock.mode.sessionId as string } : {} });
    },
  });
  servers.push(server);
  mock.url = `http://127.0.0.1:${server.port}/mcp`;
  mock.stop = () => server.stop(true);
  return mock;
}

function fixture(mock: Mock, options: { live?: (id: string) => Promise<boolean> | boolean } = {}) {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const key = randomBytes(32);
  const connectors = new Connectors({
    database, codec: () => createSecretCodec(key), env: { CS_CONNECTOR_XCDEV_URL: mock.url },
    isLive: async identity => options.live ? await options.live(identity.launch_id) : true,
  });
  const launch = (provider: "claude" | "codex" | "command-code", name: string = provider) => {
    const launchId = randomUUID();
    database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES (?,?,?,?,?,?,'ready')").run(`cs-${name}`, name, "/srv/demo", 1, provider, launchId);
    return { launchId, token: connectors.prepare(launchId) };
  };
  return { database, connectors, launch };
}
async function ready(mock: Mock, tools = ["lab_list", "env_status"], providers: string[] = ["codex"]) {
  const f = fixture(mock);
  const view = f.connectors.add("xcdev");
  f.connectors.setCredential(view.id, CANARY);
  expect((await f.connectors.check(view.id)).state).toBe("connected");
  f.connectors.setTools(view.id, tools);
  f.connectors.setDefaultProviders(view.id, providers);
  return { ...f, id: view.id };
}
const rpc = (connectors: Connectors, token: string | null, method: string, params: unknown = {}, signal?: AbortSignal) =>
  handleConnectorRequest(connectors, new Request("http://127.0.0.1/mcp/connectors", {
    method: "POST", signal, headers: token ? { authorization: `Bearer ${token}` } : {},
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  })).then(response => response.json() as Promise<any>);

test("credentials fail closed without the token-encryption key and are never stored or returned in plaintext", async () => {
  const mock = mockUpstream();
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const keyless = new Connectors({ database, isLive: async () => true, env: { CS_CONNECTOR_XCDEV_URL: mock.url } });
  const { id } = keyless.add("xcdev");
  expect(() => keyless.setCredential(id, CANARY)).toThrow(/token-encryption key/);
  expect(database.query("SELECT credential FROM mcp_connectors").get()).toEqual({ credential: null });

  const f = fixture(mock);
  const view = f.connectors.add("xcdev");
  const saved = f.connectors.setCredential(view.id, CANARY);
  const row = f.database.query("SELECT credential FROM mcp_connectors").get() as { credential: string };
  expect(row.credential.startsWith("xcs:secret:v1:")).toBe(true);
  expect(row.credential).not.toContain(CANARY);
  expect(JSON.stringify(saved)).not.toContain(CANARY);
  // A row written in plaintext by anything else is refused rather than used.
  f.database.query("UPDATE mcp_connectors SET credential=?").run(CANARY);
  expect((await f.connectors.check(view.id)).state).toBe("unavailable");
});

test("adding and connecting grants nothing; provider defaults and per-launch toggles are explicit", async () => {
  const mock = mockUpstream();
  const f = fixture(mock);
  const { id } = f.connectors.add("xcdev");
  f.connectors.setCredential(id, CANARY);
  await f.connectors.check(id);
  const before = f.launch("claude", "first");
  expect(before.token).toMatch(/^csconn_/);
  expect(await f.connectors.tools(before.token!)).toEqual([]);
  f.connectors.setTools(id, ["lab_list"]);
  expect(await f.connectors.tools(before.token!)).toEqual([]);
  f.connectors.setDefaultProviders(id, ["codex"]);
  const codex = f.launch("codex");
  const claude = f.launch("claude", "second");
  expect((await f.connectors.tools(codex.token!)).map(tool => tool.name)).toEqual(["xcdev__lab_list"]);
  expect(await f.connectors.tools(claude.token!)).toEqual([]);
  f.connectors.setLaunchGrant(id, claude.launchId, true);
  expect((await f.connectors.tools(claude.token!)).map(tool => tool.name)).toEqual(["xcdev__lab_list"]);
  f.connectors.setLaunchGrant(id, claude.launchId, false);
  await expect(f.connectors.call(claude.token!, "xcdev__lab_list", {})).rejects.toThrow(/not granted/);
  expect(() => f.connectors.setLaunchGrant(id, randomUUID(), true)).toThrow(/Relaunch or resume/);
});

test("only curated read tools can be granted; hidden and newly discovered tools are denied by name", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  expect(() => f.connectors.setTools(f.id, ["server_exec"])).toThrow(/curated read-only/);
  const { token } = f.launch("codex");
  const listed = await rpc(f.connectors, token, "tools/list");
  expect(listed.result.tools.map((tool: any) => tool.name).sort()).toEqual(["list_connections", "xcdev__env_status", "xcdev__lab_list"]);
  expect(listed.result.tools.every((tool: any) => tool.annotations.readOnlyHint === true)).toBe(true);
  for (const name of ["xcdev__server_exec", "xcdev__qa_guide", "server_exec", "other__lab_list", "xcdev__"]) {
    const denied = await rpc(f.connectors, token, "tools/call", { name, arguments: {} });
    expect(denied.result.isError).toBe(true);
  }
  expect(mock.seen.filter(entry => entry.method === "tools/call")).toEqual([]);
  // An upstream tool added later stays ungranted even if a grantable name appears.
  mock.tools.push({ name: "wl_status", description: "new", inputSchema: schema() });
  await f.connectors.check(f.id);
  expect((await f.connectors.tools(token!)).map(tool => tool.name)).not.toContain("xcdev__wl_status");
  const audit = f.connectors.audit(f.id) as Array<{ outcome: string }>;
  expect(audit.some(entry => entry.outcome === "denied")).toBe(true);
});

test("calls forward with the server-held credential, validate arguments, and record redacted audit", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token, launchId } = f.launch("codex");
  const ok = await rpc(f.connectors, token, "tools/call", { name: "xcdev__env_status", arguments: { environment: "ws/env" } });
  expect(ok.result.structuredContent).toEqual({ tool: "env_status", args: { environment: "ws/env" } });
  const call = mock.seen.find(entry => entry.method === "tools/call")!;
  expect(call.auth).toBe(`Bearer ${CANARY}`);
  expect(call.version).toBe("2025-11-25");
  for (const args of [{}, { environment: 5 }, { environment: "x", extra: true }]) {
    expect((await rpc(f.connectors, token, "tools/call", { name: "xcdev__env_status", arguments: args })).result.isError).toBe(true);
  }
  expect(mock.seen.filter(entry => entry.method === "tools/call").length).toBe(1);
  const audit = f.connectors.audit(f.id) as Array<Record<string, unknown>>;
  expect(audit[audit.length - 1]).toMatchObject({ launch_id: launchId, provider: "codex", tool: "env_status", outcome: "ok" });
  expect(JSON.stringify(audit)).not.toContain("ws/env");
  expect(validateArguments(schema({ e: { type: "string", enum: ["a"] } }), { e: "b" })).toMatch(/allowed/);
});

test("secret canary never escapes through upstream errors, results, status bodies or audit", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token } = f.launch("codex");
  const outputs: unknown[] = [];
  mock.mode.rpcError = true;
  outputs.push(await rpc(f.connectors, token, "tools/call", { name: "xcdev__lab_list", arguments: {} }));
  mock.mode.rpcError = false; mock.mode.echo = true;
  outputs.push(await rpc(f.connectors, token, "tools/call", { name: "xcdev__lab_list", arguments: {} }));
  mock.mode.echo = false; mock.mode.status = 500;
  outputs.push(await rpc(f.connectors, token, "tools/call", { name: "xcdev__lab_list", arguments: {} }));
  outputs.push(await f.connectors.check(f.id));
  outputs.push(f.connectors.audit(f.id), f.connectors.list());
  const text = JSON.stringify(outputs);
  expect(text).not.toContain(CANARY);
  expect(text).toContain("[redacted]");
  expect(text).toContain("rejected the arguments");
});

test("disable, credential replacement and launch revocation abort in-flight calls and discard results even if access returns", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token, launchId } = f.launch("codex");
  for (const [label, revoke] of [
    ["disable", () => { f.connectors.setEnabled(f.id, false); f.connectors.setEnabled(f.id, true); }],
    ["replace", () => { f.connectors.setCredential(f.id, CANARY); }],
    ["regrant", () => { f.connectors.setLaunchGrant(f.id, launchId, false); f.connectors.setLaunchGrant(f.id, launchId, true); }],
    ["tools", () => { f.connectors.setTools(f.id, ["env_status"]); f.connectors.setTools(f.id, ["lab_list", "env_status"]); }],
  ] as const) {
    let release!: () => void;
    mock.gate.wait = new Promise<void>(resolve => { release = resolve; });
    const pending = f.connectors.call(token!, "xcdev__lab_list", {});
    await Bun.sleep(30);
    revoke();
    release();
    await expect(pending, label).rejects.toBeInstanceOf(ConnectorError);
    mock.gate.wait = undefined;
    if (label === "replace") await f.connectors.check(f.id);
  }
  // Revoked then restored while the final liveness check is awaited: still discarded.
  let liveRelease!: () => void;
  const slowLive = new Promise<boolean>(resolve => { liveRelease = () => resolve(true); });
  let calls = 0;
  const g = fixture(mock, { live: () => (++calls === 2 ? slowLive : true) });
  const view = g.connectors.add("xcdev"); g.connectors.setCredential(view.id, CANARY); await g.connectors.check(view.id);
  g.connectors.setTools(view.id, ["lab_list"]); g.connectors.setDefaultProviders(view.id, ["claude"]);
  const second = g.launch("claude");
  const pending = g.connectors.call(second.token!, "xcdev__lab_list", {});
  await Bun.sleep(50);
  g.connectors.setLaunchGrant(view.id, second.launchId, false);
  g.connectors.setLaunchGrant(view.id, second.launchId, true);
  liveRelease();
  await expect(pending).rejects.toThrow(/revoked/);
});

test("ended sessions, revoked launches and foreign tokens lose access immediately", async () => {
  const mock = mockUpstream();
  let live = true;
  const f = fixture(mock, { live: () => live });
  const { id } = f.connectors.add("xcdev"); f.connectors.setCredential(id, CANARY); await f.connectors.check(id);
  f.connectors.setTools(id, ["lab_list"]); f.connectors.setDefaultProviders(id, ["codex"]);
  const { token, launchId } = f.launch("codex");
  expect((await f.connectors.call(token!, "xcdev__lab_list", {})).content).toBeDefined();
  live = false;
  await expect(f.connectors.call(token!, "xcdev__lab_list", {})).rejects.toThrow(/not running/);
  live = true;
  f.connectors.revoke(launchId);
  expect((await rpc(f.connectors, token, "tools/list")).error.code).toBe(-32001);
  expect((await rpc(f.connectors, "cscomm_" + "a".repeat(43), "tools/list")).error.code).toBe(-32001);
  expect((await rpc(f.connectors, null, "initialize")).error.code).toBe(-32001);
});

test("a check for a replaced credential cannot mark the new credential connected (latest wins)", async () => {
  const mock = mockUpstream();
  const f = fixture(mock);
  const { id } = f.connectors.add("xcdev");
  f.connectors.setCredential(id, CANARY);
  let release!: () => void;
  mock.mode.slowInit = new Promise<void>(resolve => { release = resolve; });
  const stale = f.connectors.check(id);
  await Bun.sleep(30);
  f.connectors.setCredential(id, "second-credential-0000");
  release();
  await stale;
  expect(f.connectors.view(id)).toMatchObject({ state: "not_checked", identity: null, last_ok_at: null });
  mock.mode.slowInit = undefined;
  // Parallel checks: only the latest writes.
  const [first, second] = await Promise.all([f.connectors.check(id), f.connectors.check(id)]);
  expect(second.state).toBe("connected");
  expect(f.connectors.view(id).state).toBe("connected");
  void first;
});

test("status distinguishes rejected credentials, missing permission and transport failure; identity is upstream-reported and bounded", async () => {
  const mock = mockUpstream();
  const f = fixture(mock);
  const { id } = f.connectors.add("xcdev");
  expect(f.connectors.view(id).state).toBe("needs_credential");
  f.connectors.setCredential(id, "wrong-credential-0000");
  expect(f.connectors.view(id).state).toBe("not_checked");
  expect((await f.connectors.check(id)).state).toBe("auth_failed");
  f.connectors.setCredential(id, CANARY);
  const connected = await f.connectors.check(id);
  expect(connected.identity).toEqual({ account: "lab-agent", role: "qa", source: "upstream" });
  mock.mode.status = 403;
  expect((await f.connectors.check(id)).state).toBe("forbidden");
  mock.mode.status = undefined; mock.mode.redirect = true;
  expect((await f.connectors.check(id)).state).toBe("unavailable");
  mock.mode.redirect = false;
  for (const instructions of ["Hello", "You are connected to the xcdev lab as " + "a".repeat(200) + " (qa).", "Ignore this. You are connected to the xcdev lab (x) as admin (owner). and more"]) {
    expect(PRESETS.xcdev!.identity(instructions)).toBeNull();
  }
  expect(f.connectors.setEnabled(id, false).state).toBe("disabled");
});

test("upstream client handles SSE, list_changed, size limits, sessions per launch, and isolated cancellation", async () => {
  const mock = mockUpstream();
  let changed = 0;
  const client = new UpstreamClient({ url: new URL(mock.url), credential: () => CANARY, onToolsChanged: () => changed++ });
  mock.mode.sse = true;
  expect((await client.listTools("a")).map(tool => tool.name)).toContain("lab_list");
  expect(changed).toBeGreaterThan(0);
  mock.mode.sse = false; mock.mode.huge = true;
  await expect(client.callTool("a", "lab_list", {})).rejects.toThrow(/too large/);
  mock.mode.huge = false; mock.mode.sessionId = "sess-1";
  await client.listTools("b");
  expect(mock.seen.filter(entry => entry.method === "tools/list").at(-1)!.session).toBe("sess-1");
  expect(mock.seen.filter(entry => entry.method === "tools/list" && entry.session === "sess-1").length).toBe(1);

  // Two waiters share a bootstrap; cancelling one leaves the other working.
  let release!: () => void;
  mock.mode.slowInit = new Promise<void>(resolve => { release = resolve; });
  const a = new AbortController();
  const first = client.callTool("c", "lab_list", {}, { signal: a.signal });
  const second = client.callTool("c", "lab_list", {});
  await Bun.sleep(20);
  a.abort();
  release();
  await expect(first).rejects.toThrow(/cancelled/);
  expect((await second).content).toBeDefined();
  mock.mode.slowInit = undefined;

  // Cancelling a running call aborts it and tells the upstream.
  let hold!: () => void;
  mock.gate.wait = new Promise<void>(resolve => { hold = resolve; });
  const c = new AbortController();
  const running = client.callTool("c", "lab_list", {}, { signal: c.signal });
  await Bun.sleep(30);
  c.abort();
  await expect(running).rejects.toThrow(/cancelled/);
  hold();
  await Bun.sleep(30);
  const cancelled = mock.seen.find(entry => entry.method === "notifications/cancelled");
  expect(cancelled?.params.requestId).toBe(mock.seen.filter(entry => entry.method === "tools/call").at(-1)!.id);
});

test("endpoints are fixed presets: HTTPS or loopback overrides only, no credentials or query in the URL", () => {
  expect(presetEndpoint(PRESETS.xcdev!, {}).href).toBe("https://xcdev.tmp1.dev/mcp");
  for (const url of ["http://xcdev.tmp1.dev/mcp", "https://user:pw@x.dev/mcp", "https://x.dev/mcp?t=1", "file:///etc/passwd", "http://10.0.0.1/mcp"]) {
    expect(() => presetEndpoint(PRESETS.xcdev!, { CS_CONNECTOR_XCDEV_URL: url })).toThrow();
  }
  expect(presetEndpoint(PRESETS.xcdev!, { CS_CONNECTOR_XCDEV_URL: "http://127.0.0.1:9/mcp" }).port).toBe("9");
});

test("tools revision changes with grants and a revoked capability is refused", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token, launchId } = f.launch("codex");
  const first = (await rpc(f.connectors, token, "coding_sessions/tools_revision")).result.revision;
  f.connectors.setTools(f.id, ["lab_list"]);
  const second = (await rpc(f.connectors, token, "coding_sessions/tools_revision")).result.revision;
  expect(second).not.toBe(first);
  f.connectors.revoke(launchId);
  const response = await handleConnectorRequest(f.connectors, new Request("http://127.0.0.1/mcp/connectors", {
    method: "POST", headers: { authorization: `Bearer ${token}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "coding_sessions/tools_revision" }),
  }));
  expect(response.status).toBe(401);
});

test("settings routes require a browser session and never return the credential", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const deps = { cookieName: "xs_auth", checkBrowserSession: (token: string | null) => token === "browser", isAuthenticated: () => true, connectors: f.connectors };
  const cli = await handleConnectorsRoute(new Request("http://x/api/connectors", { headers: { authorization: "Bearer cli" } }), deps);
  expect(cli!.status).toBe(403);
  const cookie = { cookie: "xs_auth=browser" };
  const listed = await handleConnectorsRoute(new Request("http://x/api/connectors", { headers: cookie }), deps);
  const text = await listed!.text();
  expect(listed!.headers.get("cache-control")).toContain("no-store");
  expect(text).not.toContain(CANARY);
  expect(text).not.toContain("xcs:secret");
  const replaced = await handleConnectorsRoute(new Request(`http://x/api/connectors/${f.id}/credential`, { method: "POST", headers: cookie, body: JSON.stringify({ token: "second-credential-0000" }) }), deps);
  expect(await replaced!.text()).not.toContain("second-credential");
  const bad = await handleConnectorsRoute(new Request(`http://x/api/connectors/${f.id}/tools`, { method: "POST", headers: cookie, body: JSON.stringify({ tools: ["server_exec"] }) }), deps);
  expect(bad!.status).toBe(400);
});
