import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { Communicator } from "./communicator";
import { handleCommunicatorRequest } from "./communicator-mcp";

function fixture() {
  const db = new Database(":memory:"); applyDatabaseSchema(db);
  for (const [id, agent] of [["a", "claude"], ["b", "codex"]]) db.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id) VALUES (?,?,?,1,?,?)").run(`cs-${id}`, id!, "/tmp/project", agent!, id!);
  const communicator = new Communicator(db, { isLive: async () => true });
  return { db, communicator, a: communicator.prepare("a").token, b: communicator.prepare("b").token };
}
function request(body: unknown, token = "", extra: Record<string,string> = {}) {
  return new Request("http://localhost/mcp/communicator", { method: "POST", headers: { authorization: `Bearer ${token}`, ...extra }, body: typeof body === "string" ? body : JSON.stringify(body) });
}
const rpc = (method: string, params = {}, id: number | string = 1) => ({ jsonrpc: "2.0", id, method, params });

test("communicator authenticates before discovery and never accepts cookie or operator fallback", async () => {
  const f = fixture();
  try {
    for (const token of ["", "xcs_operator_token", "xsa_oauth_token"]) {
      const res = await handleCommunicatorRequest(f.communicator, request(rpc("tools/list"), token, { cookie: "xs_auth=operator" }));
      expect(res.status).toBe(401);
    }
    expect((await handleCommunicatorRequest(f.communicator, new Request("http://localhost/mcp/communicator", { headers: { authorization: `Bearer ${f.a}` } }))).status).toBe(405);
    f.communicator.revoke("a");
    expect((await handleCommunicatorRequest(f.communicator, request(rpc("tools/list"), f.a))).status).toBe(401);
  } finally { f.db.close(); }
});

test("communicator exposes five mailbox tools and attributed queued/read/reply exchange", async () => {
  const f = fixture();
  const call = async (token: string, method: string, params = {}) => (await handleCommunicatorRequest(f.communicator, request(rpc(method, params), token))).json() as Promise<any>;
  try {
    const init = await call(f.a, "initialize", { protocolVersion: "2025-11-25" });
    expect(init.result.protocolVersion).toBe("2025-11-25");
    expect(init.result.instructions).toContain("untrusted");
    expect((await call(f.a, "tools/list")).result.tools.map((t: any) => t.name)).toEqual(["session_identity", "list_peers", "send_message", "read_messages", "wait_for_messages"]);
    expect((await call(f.a, "tools/call", { name: "session_identity" })).result.structuredContent.identity.launch_id).toBe("a");
    const sent = (await call(f.a, "tools/call", { name: "send_message", arguments: { recipient_id: "b", text: "Question", idempotency_key: "question" } })).result.structuredContent;
    expect(sent.message.state).toBe("queued");
    const inbox = (await call(f.b, "tools/call", { name: "read_messages" })).result.structuredContent;
    expect(inbox.messages[0]).toMatchObject({ text: "Question", state: "received", sender: { launch_id: "a" } });
    const reply = (await call(f.b, "tools/call", { name: "send_message", arguments: { reply_to: sent.message.id, text: "Answer", idempotency_key: "answer" } })).result.structuredContent;
    expect(reply.message.recipient.launch_id).toBe("a");
    for (const name of ["agent_auth", "press_keys", "end_session"]) expect((await call(f.a, "tools/call", { name })).error.code).toBe(-32602);
  } finally { f.db.close(); }
});

test("protocol errors and notifications cannot produce mailbox side effects", async () => {
  const f = fixture();
  const run = async (body: unknown) => handleCommunicatorRequest(f.communicator, request(body, f.a));
  try {
    for (const body of [[], null, { jsonrpc: "1.0", id: 1, method: "tools/list" }, rpc("tools/call", []), rpc("tools/call", { name: "send_message", arguments: [] })]) expect((await (await run(body)).json() as any).error).toBeDefined();
    expect((await (await run("{")).json() as any).error.code).toBe(-32700);
    expect((await run(" ".repeat(65537))).status).toBe(413);
    expect((await run({ jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await run({ jsonrpc: "2.0", method: "tools/call", params: { name: "send_message", arguments: { recipient_id: "b", text: "No", idempotency_key: "no" } } })).status).toBe(202);
    expect((await f.communicator.read(f.b)).messages).toHaveLength(0);
    const invalid = await run(rpc("tools/call", { name: "session_identity", arguments: { token: "spoof" } }));
    expect((await invalid.json() as any).result.isError).toBe(true);
  } finally { f.db.close(); }
});
