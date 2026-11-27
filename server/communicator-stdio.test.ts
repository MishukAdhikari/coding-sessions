import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { Communicator } from "./communicator";
import { handleCommunicatorRequest } from "./communicator-mcp";

const script = new URL("./communicator-stdio.ts", import.meta.url).pathname;
function client(url: string, token: string) {
  const process = Bun.spawn([Bun.which("bun")!, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: Bun.env.PATH, CS_COMMUNICATOR_URL: url, CS_COMMUNICATOR_TOKEN: token } });
  let seq = 0;
  const replies = new Map<string, (value: any) => void>();
  const pending: any[] = [];
  const output = (async () => {
    let buffer = "";
    for await (const chunk of process.stdout) {
      buffer += Buffer.from(chunk).toString();
      for (;;) {
        const end = buffer.indexOf("\n"); if (end < 0) break;
        const row = JSON.parse(buffer.slice(0,end)); buffer = buffer.slice(end+1);
        const callback = replies.get(String(row.id));
        if (callback) { replies.delete(String(row.id)); callback(row); } else pending.push(row);
      }
    }
  })();
  const send = (value: unknown) => process.stdin.write(JSON.stringify(value) + "\n");
  return {
    process, send, pending,
    request(method: string, params = {}) {
      const id = ++seq;
      const promise = new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Bridge response timed out")), 4000);
        replies.set(String(id), row => { clearTimeout(timer); resolve(row); });
      });
      send({ jsonrpc: "2.0", id, method, params });
      return { id, promise };
    },
    async close() { process.stdin.end(); await process.exited; await output; return new Response(process.stderr).text(); },
  };
}
function fixture() {
  const db = new Database(":memory:"); applyDatabaseSchema(db);
  for (const id of ["a", "b"]) db.query("INSERT INTO launches(screen,name,project_path,created_at,provider,launch_id) VALUES(?,?,?,1,'claude',?)").run(`cs-${id}`, id, "/tmp/project", id);
  const communicator = new Communicator(db, { isLive: async () => true });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => handleCommunicatorRequest(communicator,req) });
  return { db, communicator, server, url: `http://127.0.0.1:${server.port}/mcp/communicator` };
}

test("two real stdio clients discover tools and exchange an attributed reply through HTTP and SQLite", async () => {
  const f = fixture();
  const a = client(f.url, f.communicator.prepare("a").token), b = client(f.url, f.communicator.prepare("b").token);
  try {
    expect((await a.request("initialize", { protocolVersion: "2025-11-25" }).promise).result.serverInfo.name).toBe("coding-sessions-communicator");
    a.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect((await a.request("tools/list").promise).result.tools).toHaveLength(5);
    const sent = (await a.request("tools/call", { name: "send_message", arguments: { recipient_id: "b", text: "Hello peer", idempotency_key: "one" } }).promise).result.structuredContent.message;
    const read = (await b.request("tools/call", { name: "read_messages" }).promise).result.structuredContent.messages;
    expect(read[0]).toMatchObject({ id: sent.id, sender: { launch_id: "a" }, state: "received" });
    await b.request("tools/call", { name: "send_message", arguments: { text: "Hello back", idempotency_key: "two", reply_to: sent.id } }).promise;
    expect((await a.request("tools/call", { name: "wait_for_messages" }).promise).result.structuredContent.messages[0].text).toBe("Hello back");
    expect((await a.request("tools/call", { name: "agent_auth" }).promise).error.code).toBe(-32602);
  } finally {
    expect(await a.close()).toBe(""); expect(await b.close()).toBe("");
    f.server.stop(true); f.db.close();
  }
});

test("cancelling one wait keeps the bridge usable and EOF stops outstanding waits", async () => {
  const f = fixture(), a = client(f.url, f.communicator.prepare("a").token);
  try {
    const waiting = a.request("tools/call", { name: "wait_for_messages" });
    a.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: waiting.id } });
    expect((await waiting.promise).error.code).toBe(-32800);
    expect((await a.request("ping").promise).result).toEqual({});
    a.send({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "wait_for_messages" } });
  } finally { await a.close(); f.server.stop(true); f.db.close(); }
});

test("oversized and malformed lines return protocol errors without ending subsequent discovery", async () => {
  const f = fixture(), a = client(f.url, f.communicator.prepare("a").token);
  try {
    a.process.stdin.write("{" + "x".repeat(65536) + "\n{\n");
    expect((await a.request("tools/list").promise).result.tools).toHaveLength(5);
    expect(a.pending.map(row => row.error.code)).toEqual([-32600, -32700]);
  } finally { await a.close(); f.server.stop(true); f.db.close(); }
});

test("missing credentials or non-loopback endpoint fail without printing secrets", async () => {
  for (const url of ["https://external.invalid/mcp/communicator", "http://127.0.0.1:1/other", "http://127.0.0.1:1/mcp/communicator?token=secret", "http://user:password@127.0.0.1:1/mcp/communicator", ""]) {
    const a = client(url, "fixture-private-secret");
    const err = await a.close();
    expect(a.process.exitCode).not.toBe(0); expect(err).not.toContain("fixture-private-secret"); expect(err).not.toContain("password");
  }
});

test("outside a managed launch the bridge is an MCP server with no tools, not a failure", async () => {
  for (const env of [{}, { CS_COMMUNICATOR_TOKEN: "${CS_COMMUNICATOR_TOKEN}", CS_COMMUNICATOR_URL: "$CS_COMMUNICATOR_URL" }]) {
    const child = Bun.spawn([process.execPath, new URL("./communicator-stdio.ts", import.meta.url).pathname], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "", ...env },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_peers" } }) + "\n");
    child.stdin.end();
    const lines = (await new Response(child.stdout).text()).trim().split("\n").map(line => JSON.parse(line));
    expect(await child.exited).toBe(0);
    expect(lines[0].result.serverInfo.version).toBe("offline");
    expect(lines[1].result.tools).toEqual([]);
    expect(lines[2].error.message).toContain("outside a configured managed launch");
  }
});

test("a 2026-07-28 client over stdio: the bridge derives the required headers from each message", async () => {
  const f = fixture();
  const seen: Array<Record<string, string | null>> = [];
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: req => {
    seen.push({ version: req.headers.get("mcp-protocol-version"), method: req.headers.get("mcp-method"), name: req.headers.get("mcp-name") });
    return handleCommunicatorRequest(f.communicator, req);
  } });
  const a = client(`http://127.0.0.1:${server.port}/mcp/communicator`, f.communicator.prepare("a").token);
  const _meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  try {
    const discover = (await a.request("server/discover", { _meta }).promise).result;
    expect(discover).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], cacheScope: "private" });
    expect(discover._meta["io.modelcontextprotocol/serverInfo"].name).toBe("coding-sessions-communicator");
    expect((await a.request("tools/list", { _meta }).promise).result.tools).toHaveLength(5);
    const called = (await a.request("tools/call", { name: "session_identity", arguments: {}, _meta }).promise).result;
    expect(called).toMatchObject({ resultType: "complete", structuredContent: { identity: { launch_id: "a" } } });
    expect(seen).toEqual([
      { version: "2026-07-28", method: "server/discover", name: null },
      { version: "2026-07-28", method: "tools/list", name: null },
      { version: "2026-07-28", method: "tools/call", name: "session_identity" },
    ]);
    // The endpoint's protocol errors reach the agent as they are, not as a connection failure.
    const old = (await a.request("tools/list", { _meta: { ..._meta, "io.modelcontextprotocol/protocolVersion": "2030-01-01" } }).promise).error;
    expect(old).toMatchObject({ code: -32022, data: { requested: "2030-01-01" } });
    expect((await a.request("prompts/list", { _meta }).promise).error.code).toBe(-32601);
    const noCaps = (await a.request("tools/list", { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } }).promise).error;
    expect(noCaps.code).toBe(-32602);
  } finally { await a.close(); server.stop(true); f.server.stop(true); f.db.close(); }
});

test("outside a managed launch a 2026-07-28 client discovers an MCP server with no tools", async () => {
  const child = Bun.spawn([process.execPath, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH ?? "" } });
  const _meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} };
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta } }) + "\n");
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: { _meta } }) + "\n");
  child.stdin.end();
  const lines = (await new Response(child.stdout).text()).trim().split("\n").map(line => JSON.parse(line));
  expect(await child.exited).toBe(0);
  expect(lines[0].result).toMatchObject({ resultType: "complete", supportedVersions: ["2026-07-28"], _meta: { "io.modelcontextprotocol/serverInfo": { version: "offline" } } });
  expect(lines[1].result).toEqual({ resultType: "complete", tools: [] });
});

test("redirects cannot forward a launch credential to another endpoint", async () => {
  let targetHits = 0;
  const target = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => { targetHits++; return new Response("unexpected"); } });
  const redirect = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => Response.redirect(`http://127.0.0.1:${target.port}/steal`,302) });
  const a = client(`http://127.0.0.1:${redirect.port}/mcp/communicator`, "cscomm_" + "a".repeat(43));
  try { expect((await a.request("ping").promise).error.code).toBe(-32000); expect(targetHits).toBe(0); }
  finally { await a.close(); redirect.stop(true); target.stop(true); }
});

test("a full page of escaped text survives bridge response bounds", async () => {
  const f = fixture();
  f.db.query("INSERT INTO launches(screen,name,project_path,created_at,provider,launch_id) VALUES('cs-c','c','/tmp/project',1,'codex','c')").run();
  const at = f.communicator.prepare("a").token, ct = f.communicator.prepare("c").token;
  const b = client(f.url, f.communicator.prepare("b").token);
  try {
    for (let i=0;i<100;i++) await f.communicator.send(i<60 ? at : ct, { recipient_id: "b", text: '\0'.repeat(16384), idempotency_key: String(i) });
    const received = await b.request("tools/call", { name: "read_messages", arguments: { limit: 100 } }).promise;
    expect(received.result.structuredContent.messages).toHaveLength(100);
  } finally { await b.close(); f.server.stop(true); f.db.close(); }
});

test("a bridge started while the app is down retries until it is back, instead of failing the server", async () => {
  const db = new Database(":memory:"); applyDatabaseSchema(db);
  db.query("INSERT INTO launches(screen,name,project_path,created_at,provider,launch_id) VALUES('cs-a','a','/tmp/project',1,'claude','a')").run();
  const communicator = new Communicator(db, { isLive: async () => true });
  const token = communicator.prepare("a").token;
  // Reserve a port, then close it: the app is "restarting".
  const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response(null) });
  const port = probe.port;
  probe.stop(true);
  const a = client(`http://127.0.0.1:${port}/mcp/communicator`, token);
  let server: ReturnType<typeof Bun.serve> | null = null;
  try {
    const pending = a.request("initialize", { protocolVersion: "2025-11-25" }).promise;
    await Bun.sleep(700);
    server = Bun.serve({ port, hostname: "127.0.0.1", fetch: req => handleCommunicatorRequest(communicator, req) });
    expect((await pending).result.serverInfo.name).toBe("coding-sessions-communicator");
    expect((await a.request("tools/list").promise).result.tools.length).toBeGreaterThan(0);
  } finally { server?.stop(true); await a.close(); }
});
