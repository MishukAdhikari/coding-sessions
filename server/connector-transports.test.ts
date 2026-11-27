import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { Connectors } from "./connectors";
import { handleConnectorsRoute } from "./connectors-route";
import { UPSTREAM_NOTICES, UpstreamClient, UpstreamError } from "./connector-upstream";
import { createSecretStore, type SourceDependencies } from "./secret-store";
import { SecretRequests } from "./secret-requests";

const LOOPBACK = { CS_CONNECTOR_ALLOW_LOOPBACK: "1" };
const FIXTURE = new URL("./test-fixtures/fake-mcp-stdio.ts", import.meta.url).pathname;
const servers: Array<{ stop(force?: boolean): void }> = [];
const clients: UpstreamClient[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
  for (const client of clients.splice(0)) client.close();
});
const tool = (name: string) => ({ name, inputSchema: { type: "object", properties: {}, additionalProperties: false } });
const meta = (version = "2026-07-28") => ({
  "io.modelcontextprotocol/protocolVersion": version,
  "io.modelcontextprotocol/clientCapabilities": {},
  "io.modelcontextprotocol/clientInfo": { name: "coding-sessions-connector-gateway", version: "1.0.0" },
});
interface Seen { method: string | undefined; params: any; headers: Record<string, string>; path: string; httpMethod: string }
function serve(handler: (req: Request, msg: any, seen: Seen[]) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0, hostname: "127.0.0.1", idleTimeout: 0,
    async fetch(req) {
      const text = req.method === "POST" ? await req.text() : "";
      const msg = text ? JSON.parse(text) : null;
      seen.push({ method: msg?.method, params: msg?.params, headers: Object.fromEntries(req.headers.entries()), path: new URL(req.url).pathname + new URL(req.url).search, httpMethod: req.method });
      return handler(req, msg, seen);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port!}/mcp`, port: server.port!, seen };
}
const reply = (msg: any, result: unknown, init?: ResponseInit) => Response.json({ jsonrpc: "2.0", id: msg.id, result }, init);
const rpcError = (msg: any, code: number, status = 200, data?: unknown) => Response.json({ jsonrpc: "2.0", id: msg.id, error: { code, message: "x", ...(data ? { data } : {}) } }, { status });
const client = (url: string, extra: Partial<ConstructorParameters<typeof UpstreamClient>[0]> = {}) => {
  const created = new UpstreamClient({ url: new URL(url), credential: () => null, ...extra });
  clients.push(created);
  return created;
};
const discoverResult = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {} },
  _meta: { "io.modelcontextprotocol/serverInfo": { name: "modern", version: "2.0" } }, instructions: "hi", ttlMs: 3600000, cacheScope: "public" };
const legacyInit = (msg: any, version = "2025-11-25") => reply(msg, { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { name: "older", version: "1.0" } });

/* ---------- 2026-07-28 stateless Streamable HTTP ---------- */

function modernServer(options: { inputRequired?: boolean } = {}) {
  return serve((req, msg) => {
    if (req.headers.get("mcp-protocol-version") !== "2026-07-28" || req.headers.get("mcp-method") !== msg.method) return rpcError(msg, -32020, 400);
    if (msg.method === "server/discover") return reply(msg, discoverResult);
    if (msg.method === "tools/list") return reply(msg, { resultType: "complete", tools: [tool("echo"), tool("ask")] });
    if (msg.method === "tools/call") {
      if (options.inputRequired || msg.params.name === "ask") return reply(msg, { resultType: "input_required", inputRequests: {} });
      return reply(msg, { resultType: "complete", content: [{ type: "text", text: `ok ${msg.params.name}` }] });
    }
    return rpcError(msg, -32601);
  });
}

test("a 2026-07-28 server is spoken to statelessly: _meta and Mcp headers on every request, never initialize", async () => {
  const mock = modernServer();
  const upstream = client(mock.url);
  const session = await upstream.session("a");
  expect(session).toMatchObject({ protocolVersion: "2026-07-28", sessionId: null, transport: "streamable-http", serverInfo: { name: "modern", version: "2.0" }, instructions: "hi" });
  expect((await upstream.listTools("a")).map(t => t.name)).toEqual(["echo", "ask"]);
  expect(await upstream.callTool("a", "echo", {})).toEqual({ content: [{ type: "text", text: "ok echo" }] });
  expect(mock.seen.map(entry => entry.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
  for (const entry of mock.seen) {
    expect(entry.params._meta).toEqual(meta());
    expect(entry.headers["mcp-protocol-version"]).toBe("2026-07-28");
    expect(entry.headers["mcp-method"]).toBe(entry.method!);
    expect(entry.headers["mcp-session-id"]).toBeUndefined();
    expect(entry.headers.accept).toBe("application/json, text/event-stream");
  }
  expect(mock.seen[2]!.headers["mcp-name"]).toBe("echo");
  expect(mock.seen[1]!.headers["mcp-name"]).toBeUndefined();
});

test("a 2026 input_required result fails with a clear local message", async () => {
  const mock = modernServer();
  const upstream = client(mock.url);
  const error = await upstream.callTool("a", "ask", {}).catch(e => e);
  expect(error).toBeInstanceOf(UpstreamError);
  expect(error.kind).toBe("protocol");
  expect(error.message).toBe(UPSTREAM_NOTICES.inputRequired);
});

test("a 2026 server that supports only versions this app does not speak fails clearly, without falling back", async () => {
  const mock = serve((_req, msg) => msg.method === "server/discover"
    ? rpcError(msg, -32022, 400, { supported: ["2099-01-01"], requested: "2026-07-28" }) : legacyInit(msg));
  const error = await client(mock.url).session("a").catch(e => e);
  expect(error.kind).toBe("protocol");
  expect(error.message).toBe(UPSTREAM_NOTICES.unsupportedVersion);
  expect(mock.seen.map(entry => entry.method)).toEqual(["server/discover"]);
});

test("a 2026 server that lists a 2025 version it also speaks is initialized with it", async () => {
  const mock = serve((_req, msg) => msg.method === "server/discover"
    ? rpcError(msg, -32022, 400, { supported: ["2025-11-25"], requested: "2026-07-28" }) : msg.id === undefined ? new Response(null, { status: 202 }) : legacyInit(msg));
  expect((await client(mock.url).session("a")).protocolVersion).toBe("2025-11-25");
  expect(mock.seen.map(entry => entry.method)).toEqual(["server/discover", "initialize", "notifications/initialized"]);
});

/* ---------- 2025 Streamable HTTP fallback ---------- */

for (const [label, refuse] of [
  ["400 with an empty body", () => new Response(null, { status: 400 })],
  ["400 with an unrecognized body", () => Response.json({ error: "Bad Request: no session" }, { status: 400 })],
  ["404", () => new Response("not found", { status: 404 })],
  ["-32601 method not found", (msg: any) => rpcError(msg, -32601)],
  ["405", () => new Response(null, { status: 405 })],
] as Array<[string, (msg: any) => Response]>) {
  test(`a 2025 server answering server/discover with ${label} is initialized, with its session kept and renewed`, async () => {
    let session = "sess-1";
    const mock = serve((req, msg) => {
      if (msg.method === "server/discover") return refuse(msg);
      if (msg.method === "initialize") return new Response(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } } }), { headers: { "content-type": "application/json", "mcp-session-id": session } });
      if (msg.id === undefined) return new Response(null, { status: 202 });
      if (req.headers.get("mcp-session-id") !== session) return new Response(null, { status: 404 });
      return reply(msg, { tools: [tool("t")] });
    });
    const upstream = client(mock.url);
    expect((await upstream.listTools("a")).map(t => t.name)).toEqual(["t"]);
    const list = mock.seen.filter(entry => entry.method === "tools/list");
    expect(list[0]!.headers["mcp-session-id"]).toBe("sess-1");
    expect(list[0]!.headers["mcp-protocol-version"]).toBe("2025-11-25");
    expect(list[0]!.params._meta).toBeUndefined();
    expect(list[0]!.headers["mcp-method"]).toBeUndefined();
    // The server forgets the session: one re-initialize, and the request goes through. The era is remembered.
    session = "sess-2";
    expect((await upstream.listTools("a")).map(t => t.name)).toEqual(["t"]);
    expect(mock.seen.filter(entry => entry.method === "initialize").length).toBe(2);
    expect(mock.seen.filter(entry => entry.method === "server/discover").length).toBe(1);
  });
}

/* ---------- 2024-11-05 HTTP+SSE ---------- */

function sseServer(options: { endpoint?: (port: number) => string } = {}) {
  const streams: Array<ReadableStreamDefaultController<Uint8Array>> = [];
  const encoder = new TextEncoder();
  const push = (data: unknown) => streams.at(-1)?.enqueue(encoder.encode(`event: message\ndata: ${JSON.stringify(data)}\n\n`));
  let gets = 0;
  const mock = serve((req, msg) => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET" && path === "/sse") {
      gets++;
      const id = gets;
      const stream = new ReadableStream<Uint8Array>({ start(controller) {
        streams.push(controller);
        controller.enqueue(encoder.encode(`: hello\n\nevent: endpoint\ndata: ${options.endpoint?.(mock.port) ?? `/messages?sessionId=s${id}`}\n\n`));
      } });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST" && path === "/sse") return new Response(null, { status: 405 });
    if (req.method === "POST" && path === "/messages") {
      if (new URL(req.url).searchParams.get("sessionId") !== `s${gets}`) return new Response(null, { status: 404 });
      queueMicrotask(() => {
        if (msg.id === undefined) return;
        if (msg.method === "initialize") push({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "sse-server", version: "0.1" } } });
        else if (msg.method === "tools/list") { push({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }); push({ jsonrpc: "2.0", id: msg.id, result: { tools: [tool("legacy")] } }); }
        else if (msg.method === "tools/call") push({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: `sse ${msg.params.name}` }] } });
        else push({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no" } });
      });
      return new Response("Accepted", { status: 202 });
    }
    return new Response(null, { status: 404 });
  });
  return { ...mock, url: mock.url.replace(/\/mcp$/, "/sse"), streams, gets: () => gets };
}

test("a legacy HTTP+SSE server: POST is refused, GET names a relative endpoint, replies arrive on the stream", async () => {
  const mock = sseServer();
  let changed = 0;
  const upstream = client(mock.url, { onToolsChanged: () => changed++ });
  const session = await upstream.session("a");
  expect(session).toMatchObject({ protocolVersion: "2024-11-05", transport: "sse", serverInfo: { name: "sse-server", version: "0.1" } });
  expect((await upstream.listTools("a")).map(t => t.name)).toEqual(["legacy"]);
  expect(changed).toBe(1);
  expect(await upstream.callTool("a", "legacy", {})).toEqual({ content: [{ type: "text", text: "sse legacy" }] });
  const posts = mock.seen.filter(entry => entry.httpMethod === "POST");
  expect(posts.map(entry => `${entry.path} ${entry.method}`)).toEqual([
    "/sse server/discover", "/sse initialize",
    "/messages?sessionId=s1 initialize", "/messages?sessionId=s1 notifications/initialized", "/messages?sessionId=s1 tools/list", "/messages?sessionId=s1 tools/call",
  ]);
  expect(posts[2]!.params.protocolVersion).toBe("2024-11-05");
  expect(mock.seen.find(entry => entry.httpMethod === "GET")!.headers.accept).toBe("text/event-stream");
});

test("a dropped SSE stream means the session is gone: the next request initializes again", async () => {
  const mock = sseServer();
  const upstream = client(mock.url);
  expect((await upstream.listTools("a")).length).toBe(1);
  mock.streams.at(-1)!.close();
  await new Promise(resolve => setTimeout(resolve, 50));
  expect((await upstream.listTools("a")).length).toBe(1);
  expect(mock.gets()).toBe(2);
  // The remembered era skips the POST probes the second time.
  expect(mock.seen.filter(entry => entry.path === "/sse" && entry.httpMethod === "POST").length).toBe(2);
});

test("an SSE endpoint on another origin is refused", async () => {
  const mock = sseServer({ endpoint: port => `http://localhost:${port}/messages?sessionId=s1` });
  const error = await client(mock.url).session("a").catch(e => e);
  expect(error.message).toBe(UPSTREAM_NOTICES.crossOrigin);
  expect(mock.seen.some(entry => entry.path.startsWith("/messages"))).toBe(false);
});

/* ---------- stdio ---------- */

const logFile = () => join(mkdtempSync(join(tmpdir(), "cs-stdio-")), "log.jsonl");
const logged = (file: string) => readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const stdioClient = (mode: string, log: string, extra: Partial<ConstructorParameters<typeof UpstreamClient>[0]> = {}) => {
  const created = new UpstreamClient({ credential: () => null, stdio: { prepare: async () => ({
    command: process.execPath, args: [FIXTURE, mode, log], cwd: tmpdir(), env: { PATH: process.env.PATH ?? "" },
  }) }, ...extra });
  clients.push(created);
  return created;
};
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function until(check: () => boolean, ms = 6000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 25))) if (check()) return true;
  return check();
}

test("a modern stdio server is probed with server/discover and never initialized; close stops the process", async () => {
  const log = logFile();
  const upstream = stdioClient("modern", log);
  expect(await upstream.session("a")).toMatchObject({ protocolVersion: "2026-07-28", transport: "stdio", serverInfo: { name: "fake-stdio", version: "9.9" } });
  expect((await upstream.listTools("a")).map(t => t.name)).toEqual(["env", "pid"]);
  const pid = Number(((await upstream.callTool("a", "pid", {})).content as any)[0].text);
  expect(alive(pid)).toBe(true);
  const messages = logged(log);
  expect(messages.map(m => m.method)).toEqual(["server/discover", "tools/list", "tools/call"]);
  for (const message of messages) expect(message.params._meta).toEqual(meta());
  upstream.close();
  expect(await until(() => !alive(pid))).toBe(true);
});

test("a legacy stdio server is initialized after an error reply, and after silence once the probe times out", async () => {
  for (const mode of ["legacy", "silent"]) {
    const log = logFile();
    const upstream = stdioClient(mode, log, { probeMs: 300 });
    expect(await upstream.session("a")).toMatchObject({ protocolVersion: "2025-11-25", transport: "stdio" });
    expect((await upstream.listTools("a")).map(t => t.name)).toEqual(["env", "pid"]);
    const methods = logged(log).map(m => m.method);
    expect(methods).toEqual(["server/discover", "initialize", "notifications/initialized", "tools/list"]);
    expect(logged(log)[3].params._meta).toBeUndefined();
  }
});

test("a stdio line over 4 MB fails as too large and stops the process", async () => {
  const upstream = stdioClient("huge", logFile());
  const error = await upstream.listTools("a").catch(e => e);
  expect(error).toBeInstanceOf(UpstreamError);
  expect(error.kind).toBe("too_large");
});

test("an idle stdio session is reaped", async () => {
  const upstream = stdioClient("modern", logFile(), { idleMs: 200 });
  const pid = Number(((await upstream.callTool("a", "pid", {})).content as any)[0].text);
  expect(await until(() => !alive(pid))).toBe(true);
  // The next request starts a fresh process.
  const next = Number(((await upstream.callTool("a", "pid", {})).content as any)[0].text);
  expect(next).not.toBe(pid);
});

/* ---------- through the registry ---------- */

function registry(env: Record<string, string> = LOOPBACK, secrets: Record<string, string> = {}) {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const key = randomBytes(32);
  const dataDir = mkdtempSync(join(tmpdir(), "cs-data-"));
  const connectors = new Connectors({
    database, codec: () => createSecretCodec(key), env, dataDir, isLive: async () => true,
    secrets: async names => Object.fromEntries(names.filter(name => name in secrets).map(name => [name, secrets[name]!])),
  });
  const launch = (provider = "codex") => {
    const launchId = randomUUID();
    database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES (?,?,?,?,?,?,'ready')").run(`cs-${launchId.slice(0, 6)}`, "demo", "/srv/demo", 1, provider, launchId);
    return connectors.prepare(launchId)!;
  };
  return { database, connectors, launch, dataDir };
}

test("a stdio child gets only PATH, HOME, LANG, TMPDIR and the named secrets, and the secret values are scrubbed", async () => {
  const home = mkdtempSync(join(tmpdir(), "cs-home-"));
  const env = { ...LOOPBACK, PATH: process.env.PATH ?? "/usr/bin", HOME: home, LANG: "en_US.UTF-8", TMPDIR: tmpdir(), CS_TOKEN_KEY_FILE: "/secret/key", OPENAI_API_KEY: "service-own-key-123456" };
  const r = registry(env, { MY_API_KEY: "named-secret-value-123456", OTHER_KEY: "not-named-value-123456" });
  const view = r.connectors.addLocal({ name: "Local", command: process.execPath, args: [FIXTURE, "modern", logFile()], env_secrets: ["MY_API_KEY"] }, "owner-browser");
  expect(view).toMatchObject({ transport: "stdio", url: null, host: null, headers: [], local: { command: process.execPath, env_secrets: ["MY_API_KEY"], cwd: null } });
  const checked = await r.connectors.check(view.id);
  expect(checked.state).toBe("connected");
  expect(checked.protocol).toEqual({ transport: "stdio", version: "2026-07-28", label: "stdio (2026-07-28)" });
  r.connectors.setTools(view.id, ["env", "pid"]);
  r.connectors.setDefaultProviders(view.id, ["codex"]);
  const token = r.launch();
  expect((await r.connectors.connections(token)).connections[0]!.host).toBe("local command on this server");
  const result = await r.connectors.call(token, "local__env", {});
  const childEnv = JSON.parse((result.content as any)[0].text) as Record<string, string>;
  const unexpected = Object.keys(childEnv).filter(name => !["PATH", "HOME", "LANG", "TMPDIR", "MY_API_KEY"].includes(name));
  // Bun itself may add a few runtime variables; none of the service's own are passed.
  for (const name of unexpected) expect(name).not.toMatch(/^(CS_|OPENAI|OTHER)/);
  expect(childEnv).toMatchObject({ HOME: home, LANG: "en_US.UTF-8", MY_API_KEY: "[redacted]" });
  expect(childEnv.OTHER_KEY).toBeUndefined();
  expect(childEnv.CS_TOKEN_KEY_FILE).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("named-secret-value");
  const pid = Number(((await r.connectors.call(token, "local__pid", {})).content as any)[0].text);
  r.connectors.shutdown();
  expect(await until(() => !alive(pid))).toBe(true);
});

test("a stdio connector with a missing secret reports it locally and runs nothing", async () => {
  const log = logFile();
  writeFileSync(log, "");
  const r = registry({ PATH: process.env.PATH ?? "" });
  const view = r.connectors.addLocal({ name: "Local", command: process.execPath, args: [FIXTURE, "modern", log], env_secrets: ["ABSENT_KEY"] }, "owner-browser");
  const checked = await r.connectors.check(view.id);
  expect(checked.state).toBe("unavailable");
  expect(checked.check_detail).toContain("ABSENT_KEY");
  expect(readFileSync(log, "utf8")).toBe("");
});

test("local command settings are validated", () => {
  const r = registry({ PATH: process.env.PATH ?? "" });
  const add = (input: Record<string, unknown>) => () => r.connectors.addLocal({ name: "L", ...input }, "owner-browser");
  expect(add({ command: "/no/such/binary" })).toThrow(/does not exist/);
  expect(add({ command: "./relative" })).toThrow(/absolute path/);
  expect(add({ command: "definitely-not-a-program-xyz" })).toThrow(/PATH/);
  expect(add({ command: process.execPath, args: ["a\nb"] })).toThrow(/single-line/);
  expect(add({ command: process.execPath, env_secrets: ["PATH"] })).toThrow(/not a secret name/);
  expect(add({ command: process.execPath, env_secrets: ["CS_TOKEN"] })).toThrow(/not a secret name/);
  expect(add({ command: process.execPath, cwd: "/no/such/dir" })).toThrow(/does not exist/);
  expect(r.connectors.addLocal({ name: "Bare", command: "sh" }, "owner-browser").local!.command).toBe("sh");
  const local = r.connectors.list().find(view => view.name === "Bare")!;
  expect(() => r.connectors.setCredential(local.id, "token-123456789")).toThrow(/local command/);
  expect(() => r.connectors.setHeaders(local.id, [])).toThrow(/local command/);
});

test("extra headers are sent on every HTTP request, sealed at rest, shown by name only, and reserved names are refused", async () => {
  const VALUE = "hdr-secret-value-123456";
  const mock = serve((req, msg) => {
    if (req.headers.get("x-api-key") !== VALUE) return new Response(null, { status: 401 });
    if (msg.method === "server/discover") return reply(msg, { ...discoverResult, instructions: `echo ${VALUE}` });
    if (msg.method === "tools/list") return reply(msg, { tools: [tool("t")] });
    return rpcError(msg, -32601);
  });
  const r = registry();
  for (const name of ["Authorization", "Host", "Content-Type", "Mcp-Session-Id", "MCP-Protocol-Version", "Transfer-Encoding", "Connection", "bad name"]) {
    await expect(r.connectors.add({ name: "H", url: mock.url, headers: [{ name, value: "x" }] })).rejects.toThrow(/set by Coding Sessions|letters, digits/);
  }
  await expect(r.connectors.add({ name: "H", url: mock.url, headers: [{ name: "X-A", value: "line\nbreak" }] })).rejects.toThrow(/printable/);
  const view = await r.connectors.add({ name: "Headers", url: mock.url, headers: [{ name: "X-API-Key", value: VALUE }] });
  expect(view.headers).toEqual(["X-API-Key"]);
  expect(JSON.stringify(view)).not.toContain(VALUE);
  const row = r.database.query("SELECT headers FROM mcp_connectors WHERE id=?").get(view.id) as { headers: string };
  expect(row.headers).toStartWith("cs:secret:v1:");
  expect(row.headers).not.toContain(VALUE);
  const checked = await r.connectors.check(view.id);
  expect(checked.state).toBe("connected");
  expect(checked.protocol!.label).toBe("Streamable HTTP (2026-07-28)");
  expect(mock.seen.every(entry => entry.headers["x-api-key"] === VALUE)).toBe(true);
  // An entry without a value keeps the saved one; a new header needs one.
  const kept = r.connectors.setHeaders(view.id, [{ name: "x-api-key" }, { name: "X-Team", value: "blue" }]);
  expect(kept.headers).toEqual(["x-api-key", "X-Team"]);
  expect((await r.connectors.check(view.id)).state).toBe("connected");
  expect(mock.seen.at(-1)!.headers["x-team"]).toBe("blue");
  expect(() => r.connectors.setHeaders(view.id, [{ name: "X-New" }])).toThrow(/Enter a value/);
  // A new URL may be a different service: the headers go with the token.
  const moved = await r.connectors.setUrl(view.id, mock.url.replace("/mcp", "/other"));
  expect(moved.headers).toEqual([]);
});

test("a legacy SSE connector works through the registry's vetted transport", async () => {
  const mock = sseServer();
  const r = registry();
  const view = await r.connectors.add({ name: "Old", url: mock.url });
  const checked = await r.connectors.check(view.id);
  expect(checked.state).toBe("connected");
  expect(checked.protocol!.label).toBe("HTTP+SSE (2024-11-05, deprecated)");
  r.connectors.setTools(view.id, ["legacy"]);
  r.connectors.setDefaultProviders(view.id, ["codex"]);
  const token = r.launch();
  expect(await r.connectors.call(token, "old__legacy", {})).toEqual({ content: [{ type: "text", text: "sse legacy" }] });
  r.connectors.shutdown();
});

/* ---------- who may create a local command ---------- */

test("a local command can be created or changed only from the owner's browser session on the app's origin", async () => {
  const r = registry({ PATH: process.env.PATH ?? "" });
  const ORIGIN = "https://cs.example";
  const deps = { cookieName: "xs_auth", checkBrowserSession: (token: string | null) => token === "browser", isAuthenticated: () => true, connectors: r.connectors, origin: ORIGIN };
  const body = JSON.stringify({ name: "Shell", transport: "stdio", command: "sh", args: ["-c", "id"] });
  const post = (path: string, headers: Record<string, string>, payload = body) => handleConnectorsRoute(new Request(`http://x${path}`, { method: "POST", headers, body: payload }), deps);
  // A CLI bearer token or MCP client never reaches connector settings at all.
  expect((await post("/api/connectors", { authorization: "Bearer cli" }))!.status).toBe(403);
  // A browser session from another origin, or with none, is refused for local commands.
  expect((await post("/api/connectors", { cookie: "xs_auth=browser" }))!.status).toBe(403);
  expect((await post("/api/connectors", { cookie: "xs_auth=browser", origin: "https://evil.example" }))!.status).toBe(403);
  expect(r.connectors.list()).toEqual([]);
  // The registry's remote add never creates one, whatever it is sent.
  await expect(r.connectors.add({ name: "Sneaky", url: "https://mcp.example/mcp", transport: "stdio", command: "sh" } as never)).rejects.toThrow(/owner/);
  const created = await post("/api/connectors", { cookie: "xs_auth=browser", origin: ORIGIN });
  expect(created!.status).toBe(200);
  const id = ((await created!.json()) as any).connector.id as string;
  const change = JSON.stringify({ command: "sh", args: ["-c", "whoami"] });
  expect((await post(`/api/connectors/${id}/local`, { cookie: "xs_auth=browser" }, change))!.status).toBe(403);
  expect(r.connectors.view(id).local!.args).toEqual(["-c", "id"]);
  expect((await post(`/api/connectors/${id}/local`, { cookie: "xs_auth=browser", origin: ORIGIN }, change))!.status).toBe(200);
  expect(r.connectors.view(id).local!.args).toEqual(["-c", "whoami"]);
  // Without a configured origin the route fails closed.
  const noOrigin = await handleConnectorsRoute(new Request("http://x/api/connectors", { method: "POST", headers: { cookie: "xs_auth=browser", origin: ORIGIN }, body }), { ...deps, origin: undefined });
  expect(noOrigin!.status).toBe(403);
});

test("an agent's or operator connection's request_connector can never ask for a local command", async () => {
  const noSources: SourceDependencies = { fetch: (async () => { throw new Error("no network"); }) as unknown as typeof fetch, runBws: async () => ({ code: 127, out: "" }) };
  const r = registry({ PATH: process.env.PATH ?? "" });
  const store = createSecretStore({ database: r.database, codec: createSecretCodec(randomBytes(32)), sources: noSources, now: () => 1 });
  const requests = new SecretRequests({ database: r.database, origin: "https://cs.example", secrets: () => store, connectors: r.connectors });
  const requester = { by: "session" as const, launchId: "l", screen: "cs-a", sessionName: "a", agent: "claude" };
  for (const extra of [{ transport: "stdio" }, { command: "/bin/sh" }, { args: ["-c", "id"] }, { env_secrets: ["X"] }, { cwd: "/" }]) {
    await expect(requests.create({ kind: "connector", name: "Shell", url: "https://mcp.example/mcp", reason: "Need its tools.", ...extra }, requester)).rejects.toThrow(/Only remote https:\/\/ MCP servers/);
  }
  // A request naming an existing local connector cannot touch it.
  r.connectors.addLocal({ name: "Shell", command: "sh" }, "owner-browser");
  const { url } = await requests.create({ kind: "connector", name: "Shell", url: "https://mcp.example/mcp", reason: "Need its tools." }, requester);
  const token = url.split("#secret-request=")[1]!;
  await expect(requests.connectorBearer({ token }, "some-token-value-123", { stepUp: () => true })).rejects.toThrow(/local command/);
  expect(r.connectors.list()[0]!.local!.command).toBe("sh");
});
