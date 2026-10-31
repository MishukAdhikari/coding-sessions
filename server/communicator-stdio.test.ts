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
