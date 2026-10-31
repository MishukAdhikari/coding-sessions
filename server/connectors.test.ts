import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { ConnectorError, Connectors, exposedName, validateArguments } from "./connectors";
import { handleConnectorRequest } from "./connector-mcp";
import { handleConnectorsRoute } from "./connectors-route";
import { UpstreamClient } from "./connector-upstream";

const CANARY = "upstream_tok_CANARY_9f8e7d6c5b4a3210";
const INSTRUCTIONS = "Mock server.";
const schema = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties, required, additionalProperties: false });
const BASE_TOOLS = [
  { name: "list_items", description: "List items", inputSchema: schema({ mine: { type: "boolean" } }), annotations: { readOnlyHint: true } },
  { name: "get_status", description: "Status", inputSchema: schema({ environment: { type: "string" } }, ["environment"]) },
  { name: "read_guide", description: "Guide", inputSchema: schema() },
  { name: "run_command", description: "Run a shell command", inputSchema: schema({ command: { type: "string" } }), annotations: { readOnlyHint: true, destructiveHint: false } },
];

interface Mock {
  url: string;
  seen: Array<{ method: string; auth: string | null; id: unknown; params: any; session: string | null; version: string | null }>;
  tools: Array<Record<string, any>>;
  mode: Record<string, unknown>;
  gate: { wait?: Promise<void> };
  stop(): void;
}
const servers: Array<{ stop(): void }> = [];
const LOOPBACK = { CS_CONNECTOR_ALLOW_LOOPBACK: "1" };
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
        body = reply({ protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "mock-server", version: "1.2.3" }, instructions: (mock.mode.instructions as string) ?? INSTRUCTIONS });
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
    database, codec: () => createSecretCodec(key), env: LOOPBACK,
    isLive: async identity => options.live ? await options.live(identity.launch_id) : true,
  });
  const launch = (provider: "claude" | "codex" | "command-code", name: string = provider) => {
    const launchId = randomUUID();
    database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES (?,?,?,?,?,?,'ready')").run(`cs-${name}`, name, "/srv/demo", 1, provider, launchId);
    return { launchId, token: connectors.prepare(launchId) };
  };
  return { database, connectors, launch };
}
async function ready(mock: Mock, tools = ["list_items", "get_status"], providers: string[] = ["codex"]) {
  const f = fixture(mock);
  const view = await f.connectors.add({ name: "Lab", url: mock.url, token: CANARY });
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

test("tokens fail closed without the token-encryption key and are never stored or returned in plaintext", async () => {
  const mock = mockUpstream();
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const keyless = new Connectors({ database, isLive: async () => true, env: LOOPBACK });
  await expect(keyless.add({ name: "Lab", url: mock.url, token: CANARY })).rejects.toThrow(/token-encryption key/);
  expect(database.query("SELECT COUNT(*) AS n FROM mcp_connectors").get()).toEqual({ n: 0 });
  // A server that needs no token can still be added without a key.
  expect((await keyless.add({ name: "Open", url: mock.url })).credential.set).toBe(false);

  const f = fixture(mock);
  const saved = await f.connectors.add({ name: "Lab", url: mock.url, token: CANARY });
  const row = f.database.query("SELECT credential FROM mcp_connectors WHERE id=?").get(saved.id) as { credential: string };
  expect(row.credential.startsWith("xcs:secret:v1:")).toBe(true);
  expect(row.credential).not.toContain(CANARY);
  expect(JSON.stringify(saved)).not.toContain(CANARY);
  // A row written in plaintext by anything else is refused rather than used.
  f.database.query("UPDATE mcp_connectors SET credential=? WHERE id=?").run(CANARY, saved.id);
  expect((await f.connectors.check(saved.id)).state).toBe("unavailable");
  expect(mock.seen.filter(entry => entry.auth === `Bearer ${CANARY}`).length).toBe(0);
});

test("adding and discovering grants nothing; tool, agent and session grants are each explicit", async () => {
  const mock = mockUpstream();
  const f = fixture(mock);
  const { id } = await f.connectors.add({ name: "Lab", url: mock.url, token: CANARY });
  const checked = await f.connectors.check(id);
  expect(checked.granted_tools).toEqual([]);
  expect(checked.default_providers).toEqual([]);
  const before = f.launch("claude", "first");
  expect(before.token).toMatch(/^csconn_/);
  expect(await f.connectors.tools(before.token!)).toEqual([]);
  f.connectors.setTools(id, ["list_items"]);
  expect(await f.connectors.tools(before.token!)).toEqual([]);
  f.connectors.setDefaultProviders(id, ["codex"]);
  const codex = f.launch("codex");
  const claude = f.launch("claude", "second");
  expect((await f.connectors.tools(codex.token!)).map(tool => tool.name)).toEqual(["lab__list_items"]);
  expect(await f.connectors.tools(claude.token!)).toEqual([]);
  f.connectors.setLaunchGrant(id, claude.launchId, true);
  expect((await f.connectors.tools(claude.token!)).map(tool => tool.name)).toEqual(["lab__list_items"]);
  f.connectors.setLaunchGrant(id, claude.launchId, false);
  await expect(f.connectors.call(claude.token!, "lab__list_items", {})).rejects.toThrow(/not granted/);
  expect(() => f.connectors.setLaunchGrant(id, randomUUID(), true)).toThrow(/Relaunch or resume/);
});

test("any offered tool may be granted explicitly; hints are advisory; hidden and new tools are denied by name", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  expect(() => f.connectors.setTools(f.id, ["not_offered"])).toThrow(/not offered/);
  const view = f.connectors.setTools(f.id, ["list_items", "get_status", "run_command"]);
  // The server says run_command is read-only; that is shown, not trusted.
  expect(view.tools.find(tool => tool.name === "run_command")!.hints).toEqual({ readOnly: true, destructive: false });
  const { token } = f.launch("codex");
  const listed = await rpc(f.connectors, token, "tools/list");
  expect(listed.result.tools.map((tool: any) => tool.name).sort()).toEqual(["lab__get_status", "lab__list_items", "lab__run_command", "list_connections"]);
  for (const tool of listed.result.tools.filter((tool: any) => tool.name.startsWith("lab__"))) {
    expect(tool.annotations).toEqual({ openWorldHint: true });
    expect(tool.description).toContain("[Lab, through Coding Sessions]");
  }
  f.connectors.setTools(f.id, ["list_items"]);
  for (const name of ["lab__run_command", "lab__read_guide", "run_command", "other__list_items", "lab__"]) {
    const denied = await rpc(f.connectors, token, "tools/call", { name, arguments: {} });
    expect(denied.result.isError).toBe(true);
  }
  expect(mock.seen.filter(entry => entry.method === "tools/call")).toEqual([]);
  mock.tools.push({ name: "brand_new", description: "new", inputSchema: schema() });
  await f.connectors.check(f.id);
  expect((await f.connectors.tools(token!)).map(tool => tool.name)).not.toContain("lab__brand_new");
  const audit = f.connectors.audit(f.id) as Array<{ outcome: string }>;
  expect(audit.some(entry => entry.outcome === "denied")).toBe(true);
});

test("long or unusual tool names get deterministic bounded aliases across namespaces", async () => {
  const long = "a".repeat(70);
  const dotted = "files.read";
  for (const slug of ["lab", "x".repeat(20)]) {
    const alias = exposedName(slug, long);
    expect(alias).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(alias).toBe(exposedName(slug, long));
    expect(exposedName(slug, dotted)).toMatch(new RegExp(`^${slug}__files_read_[0-9a-f]{8}$`));
  }
  expect(exposedName("lab", long + "b")).not.toBe(exposedName("lab", long + "c"));
  const mock = mockUpstream();
  mock.tools.push({ name: dotted, description: "dotted", inputSchema: schema() }, { name: long, description: "long", inputSchema: schema() });
  const f = await ready(mock, [dotted, long]);
  const second = await f.connectors.add({ name: "Lab", url: mock.url, token: CANARY });
  expect(second.namespace).toBe("lab_2");
  await f.connectors.check(second.id);
  f.connectors.setTools(second.id, [dotted]); f.connectors.setDefaultProviders(second.id, ["codex"]);
  const { token } = f.launch("codex");
  const names = (await f.connectors.tools(token!)).map(tool => tool.name);
  expect(names).toContain(exposedName("lab", dotted));
  expect(names).toContain(exposedName("lab", long));
  expect(names).toContain(exposedName("lab_2", dotted));
  const result = await f.connectors.call(token!, exposedName("lab_2", dotted), {});
  expect(result.structuredContent).toMatchObject({ tool: dotted });
  // An alias that equals another tool's literal name is withheld from both.
  const clash = `files_read_${exposedName("lab", dotted).slice(-8)}`;
  mock.tools.push({ name: clash, description: "clash", inputSchema: schema() });
  await f.connectors.check(f.id);
  const view = f.connectors.view(f.id);
  expect(view.tools.find(tool => tool.name === dotted)!.exposed).toBeNull();
  expect(view.tools.find(tool => tool.name === clash)!.exposed).toBeNull();
  expect(() => f.connectors.setTools(f.id, [clash])).toThrow(/collide/);
  expect((await f.connectors.tools(token!)).map(tool => tool.name)).not.toContain(exposedName("lab", dotted));
  // Renaming never changes the namespace.
  expect(f.connectors.rename(second.id, "Something else").namespace).toBe("lab_2");
});

test("calls forward with the server-held credential, validate arguments, and record redacted audit", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token, launchId } = f.launch("codex");
  const ok = await rpc(f.connectors, token, "tools/call", { name: "lab__get_status", arguments: { environment: "ws/env" } });
  expect(ok.result.structuredContent).toEqual({ tool: "get_status", args: { environment: "ws/env" } });
  const call = mock.seen.find(entry => entry.method === "tools/call")!;
  expect(call.auth).toBe(`Bearer ${CANARY}`);
  expect(call.version).toBe("2025-11-25");
  for (const args of [{}, { environment: 5 }, { environment: "x", extra: true }]) {
    expect((await rpc(f.connectors, token, "tools/call", { name: "lab__get_status", arguments: args })).result.isError).toBe(true);
  }
  expect(mock.seen.filter(entry => entry.method === "tools/call").length).toBe(1);
  const audit = f.connectors.audit(f.id) as Array<Record<string, unknown>>;
  expect(audit[audit.length - 1]).toMatchObject({ launch_id: launchId, provider: "codex", tool: "get_status", outcome: "ok" });
  expect(JSON.stringify(audit)).not.toContain("ws/env");
  expect(validateArguments(schema({ e: { type: "string", enum: ["a"] } }), { e: "b" })).toMatch(/allowed/);
});

test("secret canary never escapes through upstream errors, results, status bodies or audit", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token } = f.launch("codex");
  const outputs: unknown[] = [];
  mock.mode.rpcError = true;
  outputs.push(await rpc(f.connectors, token, "tools/call", { name: "lab__list_items", arguments: {} }));
  mock.mode.rpcError = false; mock.mode.echo = true;
  outputs.push(await rpc(f.connectors, token, "tools/call", { name: "lab__list_items", arguments: {} }));
  mock.mode.echo = false; mock.mode.status = 500;
  outputs.push(await rpc(f.connectors, token, "tools/call", { name: "lab__list_items", arguments: {} }));
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
    ["rename-url", async () => { await f.connectors.setUrl(f.id, mock.url.replace("/mcp", "/mcp2")); await f.connectors.setUrl(f.id, mock.url); f.connectors.setCredential(f.id, CANARY); await f.connectors.check(f.id); f.connectors.setTools(f.id, ["list_items", "get_status"]); }],
    ["regrant", () => { f.connectors.setLaunchGrant(f.id, launchId, false); f.connectors.setLaunchGrant(f.id, launchId, true); }],
    ["tools", () => { f.connectors.setTools(f.id, ["get_status"]); f.connectors.setTools(f.id, ["list_items", "get_status"]); }],
  ] as const) {
    let release!: () => void;
    mock.gate.wait = new Promise<void>(resolve => { release = resolve; });
    const outcome = f.connectors.call(token!, "lab__list_items", {}).then(() => "delivered", error => error);
    await Bun.sleep(30);
    await revoke();
    release();
    expect(await outcome, label).toBeInstanceOf(ConnectorError);
    mock.gate.wait = undefined;
    if (label === "replace") await f.connectors.check(f.id);
  }
  // Revoked then restored while the final liveness check is awaited: still discarded.
  let liveRelease!: () => void;
  const slowLive = new Promise<boolean>(resolve => { liveRelease = () => resolve(true); });
  let calls = 0;
  const g = fixture(mock, { live: () => (++calls === 2 ? slowLive : true) });
  const view = await g.connectors.add({ name: "Lab", url: mock.url, token: CANARY }); await g.connectors.check(view.id);
  g.connectors.setTools(view.id, ["list_items"]); g.connectors.setDefaultProviders(view.id, ["claude"]);
  const second = g.launch("claude");
  const pending = g.connectors.call(second.token!, "lab__list_items", {});
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
  const { id } = await f.connectors.add({ name: "Lab", url: mock.url, token: CANARY }); await f.connectors.check(id);
  f.connectors.setTools(id, ["list_items"]); f.connectors.setDefaultProviders(id, ["codex"]);
  const { token, launchId } = f.launch("codex");
  expect((await f.connectors.call(token!, "lab__list_items", {})).content).toBeDefined();
  live = false;
  await expect(f.connectors.call(token!, "lab__list_items", {})).rejects.toThrow(/not running/);
  live = true;
  f.connectors.revoke(launchId);
  expect((await rpc(f.connectors, token, "tools/list")).error.code).toBe(-32001);
  expect((await rpc(f.connectors, "cscomm_" + "a".repeat(43), "tools/list")).error.code).toBe(-32001);
  expect((await rpc(f.connectors, null, "initialize")).error.code).toBe(-32001);
});

test("a check for a replaced credential cannot mark the new credential connected (latest wins)", async () => {
  const mock = mockUpstream();
  const f = fixture(mock);
  const { id } = await f.connectors.add({ name: "Lab", url: mock.url, token: CANARY });
  let release!: () => void;
  mock.mode.slowInit = new Promise<void>(resolve => { release = resolve; });
  const stale = f.connectors.check(id);
  await Bun.sleep(30);
  f.connectors.setCredential(id, "second-credential-0000");
  release();
  await stale;
  expect(f.connectors.view(id)).toMatchObject({ state: "not_checked", server: null, last_ok_at: null });
  mock.mode.slowInit = undefined;
  // Parallel checks: only the latest writes.
  const [first, second] = await Promise.all([f.connectors.check(id), f.connectors.check(id)]);
  expect(second.state).toBe("connected");
  expect(f.connectors.view(id).state).toBe("connected");
  void first;
});

test("status distinguishes rejected tokens, missing permission, refused destinations and transport failure", async () => {
  const mock = mockUpstream();
  const f = fixture(mock);
  const { id } = await f.connectors.add({ name: "Lab", url: mock.url, token: "wrong-credential-0000" });
  expect(f.connectors.view(id).state).toBe("not_checked");
  expect((await f.connectors.check(id)).state).toBe("auth_failed");
  f.connectors.setCredential(id, CANARY);
  expect((await f.connectors.check(id)).server).toEqual({ name: "mock-server", version: "1.2.3" });
  mock.mode.status = 403;
  expect((await f.connectors.check(id)).state).toBe("forbidden");
  mock.mode.status = undefined; mock.mode.redirect = true;
  const redirected = await f.connectors.check(id);
  expect(redirected.state).toBe("blocked");
  expect(redirected.check_detail).toMatch(/redirect/);
  mock.mode.redirect = false;
  mock.stop();
  expect((await f.connectors.check(id)).state).toBe("unavailable");
  expect(f.connectors.setEnabled(id, false).state).toBe("disabled");
});

test("upstream client handles SSE, list_changed, size limits, sessions per launch, and isolated cancellation", async () => {
  const mock = mockUpstream();
  let changed = 0;
  const client = new UpstreamClient({ url: new URL(mock.url), credential: () => CANARY, onToolsChanged: () => changed++ });
  // The no-token mode sends no Authorization header at all.
  const anonymous = new UpstreamClient({ url: new URL(mock.url), credential: () => null });
  await expect(anonymous.listTools("anon")).rejects.toThrow(/rejected/);
  expect(mock.seen.some(entry => entry.auth === null)).toBe(false);
  mock.mode.sse = true;
  expect((await client.listTools("a")).map(tool => tool.name)).toContain("list_items");
  expect(changed).toBeGreaterThan(0);
  mock.mode.sse = false;
  mock.tools.push({ name: "list_items", description: "duplicate", inputSchema: schema() });
  expect((await client.listTools("a")).map(tool => tool.name)).not.toContain("list_items");
  mock.tools.pop();
  mock.mode.huge = true;
  await expect(client.callTool("a", "list_items", {})).rejects.toThrow(/too large/);
  mock.mode.huge = false; mock.mode.sessionId = "sess-1";
  await client.listTools("b");
  expect(mock.seen.filter(entry => entry.method === "tools/list").at(-1)!.session).toBe("sess-1");
  expect(mock.seen.filter(entry => entry.method === "tools/list" && entry.session === "sess-1").length).toBe(1);

  // Two waiters share a bootstrap; cancelling one leaves the other working.
  let release!: () => void;
  mock.mode.slowInit = new Promise<void>(resolve => { release = resolve; });
  const a = new AbortController();
  const first = client.callTool("c", "list_items", {}, { signal: a.signal });
  const second = client.callTool("c", "list_items", {});
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
  const running = client.callTool("c", "list_items", {}, { signal: c.signal });
  await Bun.sleep(30);
  c.abort();
  await expect(running).rejects.toThrow(/cancelled/);
  hold();
  await Bun.sleep(30);
  const cancelled = mock.seen.find(entry => entry.method === "notifications/cancelled");
  expect(cancelled?.params.requestId).toBe(mock.seen.filter(entry => entry.method === "tools/call").at(-1)!.id);
});

test("URLs are HTTPS, public and plain; loopback only through the service environment; DNS answers are vetted", async () => {
  const database = new Database(":memory:"); applyDatabaseSchema(database);
  const strict = new Connectors({ database, isLive: async () => true, codec: () => createSecretCodec(randomBytes(32)), env: {},
    resolver: async host => host === "internal.example" ? [{ address: "10.1.2.3", family: 4 }] : host === "mixed.example" ? [{ address: "93.184.216.34", family: 4 }, { address: "169.254.169.254", family: 4 }] : [{ address: "93.184.216.34", family: 4 }] });
  for (const url of ["http://public.example/mcp", "https://user:pw@public.example/mcp", "https://public.example/mcp?token=1", "https://public.example/mcp#x",
    "file:///etc/passwd", "https://10.0.0.1/mcp", "https://169.254.169.254/latest", "https://[::1]/mcp", "https://[::ffff:127.0.0.1]/mcp", "https://[fd00::1]/mcp",
    "https://100.64.0.1/mcp", "https://localhost/mcp", "http://127.0.0.1:9/mcp", "https://internal.example/mcp", "https://mixed.example/mcp"]) {
    await expect(strict.add({ name: "x", url }), url).rejects.toBeInstanceOf(ConnectorError);
  }
  expect((await strict.add({ name: "Public", url: "https://public.example/mcp" })).host).toBe("public.example");
  expect(database.query("SELECT COUNT(*) AS n FROM mcp_connectors").get()).toEqual({ n: 1 });
  const loopback = new Connectors({ database, isLive: async () => true, env: LOOPBACK });
  expect((await loopback.add({ name: "Local", url: "http://127.0.0.1:9/mcp" })).url).toBe("http://127.0.0.1:9/mcp");
  await expect(loopback.add({ name: "Private", url: "https://10.0.0.1/mcp" })).rejects.toBeInstanceOf(ConnectorError);
});

test("changing the URL clears the token, discovery and tool grants; a stale bootstrap never sends the new token to the old URL", async () => {
  const a = mockUpstream();
  const b = mockUpstream();
  const f = await ready(a);
  const before = f.connectors.view(f.id);
  expect(before.granted_tools.length).toBe(2);
  const moved = await f.connectors.setUrl(f.id, b.url);
  expect(moved).toMatchObject({ credential: { set: false }, granted_tools: [], discovered_count: 0, server: null, state: "not_checked", default_providers: ["codex"] });
  expect(f.database.query("SELECT credential FROM mcp_connectors WHERE id=?").get(f.id)).toEqual({ credential: null });
  // Same origin, different path: still cleared.
  f.connectors.setCredential(f.id, CANARY);
  expect((await f.connectors.setUrl(f.id, b.url.replace("/mcp", "/other"))).credential.set).toBe(false);

  // Race: a check against A is initializing; the operator moves to B and enters token B.
  await f.connectors.setUrl(f.id, a.url);
  f.connectors.setCredential(f.id, CANARY);
  let release!: () => void;
  a.mode.slowInit = new Promise<void>(resolve => { release = resolve; });
  const pending = f.connectors.check(f.id);
  await Bun.sleep(30);
  await f.connectors.setUrl(f.id, b.url);
  f.connectors.setCredential(f.id, "second-credential-0000");
  const seenBefore = a.seen.length;
  release();
  await pending;
  await Bun.sleep(50);
  const leaked = a.seen.slice(seenBefore).filter(entry => entry.auth === "Bearer second-credential-0000");
  expect(leaked).toEqual([]);
  expect(f.connectors.view(f.id).state).toBe("not_checked");
});

test("legacy preset rows migrate in place, keep their grants, and are disabled until a URL is set", () => {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE mcp_connectors (id TEXT PRIMARY KEY, preset TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL DEFAULT 1, credential TEXT, credential_set_at INTEGER,
    granted_tools TEXT NOT NULL DEFAULT '[]', default_providers TEXT NOT NULL DEFAULT '[]', catalog TEXT, catalog_at INTEGER, catalog_stale INTEGER NOT NULL DEFAULT 0,
    identity TEXT, check_status TEXT, check_at INTEGER, check_ok_at INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE connector_launch_grants (connector_id TEXT NOT NULL REFERENCES mcp_connectors(id) ON DELETE CASCADE, launch_id TEXT NOT NULL, granted_at INTEGER NOT NULL, PRIMARY KEY (connector_id, launch_id));
    INSERT INTO mcp_connectors (id,preset,credential,granted_tools,default_providers,created_at) VALUES ('c1','oldpreset','xcs:secret:v1:sealed','["one"]','["codex"]',1);
    INSERT INTO connector_launch_grants VALUES ('c1','launch-1',1);`);
  applyDatabaseSchema(database);
  applyDatabaseSchema(database);
  const row = database.query("SELECT name,slug,url,enabled,credential,granted_tools,default_providers FROM mcp_connectors").get();
  expect(row).toEqual({ name: "oldpreset", slug: "oldpreset", url: "", enabled: 0, credential: "xcs:secret:v1:sealed", granted_tools: '["one"]', default_providers: '["codex"]' });
  expect(database.query("SELECT COUNT(*) AS n FROM connector_launch_grants").get()).toEqual({ n: 1 });
  const connectors = new Connectors({ database, isLive: async () => true, env: LOOPBACK });
  expect(connectors.view("c1")).toMatchObject({ state: "disabled", url: null, namespace: "oldpreset" });
});

test("tools revision changes with grants and a revoked capability is refused", async () => {
  const mock = mockUpstream();
  const f = await ready(mock);
  const { token, launchId } = f.launch("codex");
  const first = (await rpc(f.connectors, token, "coding_sessions/tools_revision")).result.revision;
  f.connectors.setTools(f.id, ["list_items"]);
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
  const created = await handleConnectorsRoute(new Request("http://x/api/connectors", { method: "POST", headers: { cookie: "xs_auth=browser" }, body: JSON.stringify({ name: "Other", url: mock.url, token: "third-credential-0000" }) }), deps);
  expect(created!.status).toBe(200);
  expect(await created!.text()).not.toContain("third-credential");
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
  const post = (path: string, body: string) => handleConnectorsRoute(new Request(`http://x${path}`, { method: "POST", headers: cookie, body }), deps);
  const blocked = await post("/api/connectors", JSON.stringify({ name: "Test", url: "https://10.0.0.1/mcp" }));
  expect(blocked!.status).toBe(400);
  expect((await blocked!.json() as any).error).toMatch(/private/);
  for (const body of ["{", "[]", "null", "{}", JSON.stringify({ tokn: "x" })]) {
    const response = await post(`/api/connectors/${f.id}/credential`, body);
    expect(response!.status, body).toBe(400);
  }
  expect(f.connectors.view(f.id).credential.set).toBe(true);
  expect((await post(`/api/connectors/${f.id}/url`, "{"))!.status).toBe(400);
  const removed = await post(`/api/connectors/${f.id}/credential`, JSON.stringify({ token: null }));
  expect((await removed!.json() as any).connector.credential.set).toBe(false);
  const bad = await handleConnectorsRoute(new Request(`http://x/api/connectors/${f.id}/tools`, { method: "POST", headers: cookie, body: JSON.stringify({ tools: ["not_offered"] }) }), deps);
  expect(bad!.status).toBe(400);
});
