import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { Communicator } from "./communicator";
import { handleCommunicatorRequest, SECRET_TOOLS } from "./communicator-mcp";
import { SecretRequests } from "./secret-requests";
import { createSecretStore } from "./secret-store";
import { createSecretCodec } from "./secrets";
import { randomBytes } from "node:crypto";

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
    for (const token of ["", "cs_operator_token", "xsa_oauth_token"]) {
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

function secretsFixture() {
  const f = fixture();
  const store = createSecretStore({ database: f.db, codec: createSecretCodec(randomBytes(32)), sources: { fetch: fetch, runBws: async () => ({ code: 127, out: "" }) }, now: () => 5 });
  const requests = new SecretRequests({ database: f.db, origin: "https://cs.example", secrets: () => store, now: () => 10,
    secretsFile: id => `/run/cs/${id}.env`, inLaunchEnvironment: async (launch, name) => launch === "a" && name === "BEFORE" ? "current" : "missing" });
  const call = async (token: string, name: string, args: Record<string, unknown> = {}) =>
    (await (await handleCommunicatorRequest(f.communicator, request(rpc("tools/call", { name, arguments: args }), token), { requests })).json() as any).result;
  return { ...f, store, requests, call };
}

test("secret tools list names and say where a session finds the value, never the value itself", async () => {
  const f = secretsFixture();
  try {
    const init = await (await handleCommunicatorRequest(f.communicator, request(rpc("initialize"), f.a), { requests: f.requests })).json() as any;
    expect(init.result.instructions).toContain("Never ask for a value in chat");
    expect(init.result.instructions).toContain("list_secrets");
    const listed = (await (await handleCommunicatorRequest(f.communicator, request(rpc("tools/list"), f.a), { requests: f.requests })).json() as any).result.tools.map((t: any) => t.name);
    expect(listed).toEqual(["session_identity", "list_peers", "send_message", "read_messages", "wait_for_messages", ...SECRET_TOOLS.map(t => t.name)]);
    for (const tool of SECRET_TOOLS) expect(tool.description.length).toBeGreaterThan(40);
    expect(SECRET_TOOLS.find(t => t.name === "request_secret")!.description).toContain("instead of asking in chat");

    f.store.set("BEFORE", "value-one-secret");
    const list = (await f.call(f.a, "list_secrets")).structuredContent;
    expect(list.secrets).toEqual([{ name: "BEFORE", source: "Coding Sessions", updated_at: new Date(5).toISOString(), in_launch_environment: "current" }]);
    expect(list.secrets_file).toBe("/run/cs/a.env");
    const status = (await f.call(f.b, "secret_status", { name: "BEFORE" })).structuredContent;
    expect(status).toMatchObject({ set: true, in_launch_environment: "missing", secrets_file: "/run/cs/b.env", available_in_secrets_file: true });
    expect(JSON.stringify([list, status])).not.toContain("value-one-secret");
  } finally { f.db.close(); }
});

test("a session's requests are bound to its own launch and invisible to other sessions", async () => {
  const f = secretsFixture();
  try {
    const created = (await f.call(f.a, "request_secret", { name: "KAZTRACK_TOKEN", reason: "Read the sprint board" })).structuredContent;
    expect(created.url).toStartWith("https://cs.example/#secret-request=csreq_");
    expect(created.next).toContain("Do not ask for the value in chat");
    const row = f.db.query("SELECT launch_id, screen, session_name, agent, requested_by FROM secret_requests").get();
    expect(row).toEqual({ launch_id: "a", screen: "cs-a", session_name: "a", agent: "claude", requested_by: "session" });
    expect((await f.call(f.a, "secret_status", { name: "KAZTRACK_TOKEN" })).structuredContent.request).toMatchObject({ state: "pending" });
    expect((await f.call(f.b, "secret_status", { name: "KAZTRACK_TOKEN" })).structuredContent.request).toBeNull();
    // Arguments cannot claim another identity.
    const spoof = await f.call(f.b, "request_secret", { name: "X_TOKEN", reason: "Read it", session_id: "m:cs-a" });
    expect(spoof.isError).toBe(true);
    expect((await f.call(f.a, "request_secret", { name: "path", reason: "bad name" })).isError).toBe(true);
    const connector = (await f.call(f.a, "request_connector", { name: "KazTrack", url: "https://mcp.kaztrack.example/mcp", reason: "Sprint tools", auth: "oauth" })).structuredContent;
    expect(connector.url).toContain("#secret-request=");
    expect((await f.call(f.b, "connector_status", { name: "KazTrack" })).structuredContent).toMatchObject({ exists: false, request: null });
    expect((await f.call(f.a, "connector_status", { name: "KazTrack" })).structuredContent).toMatchObject({ exists: false, request: { state: "pending" } });
  } finally { f.db.close(); }
});

test("secret tools are absent without the secrets service, and need a live session", async () => {
  const f = secretsFixture();
  try {
    const bare = await (await handleCommunicatorRequest(f.communicator, request(rpc("tools/call", { name: "list_secrets" }), f.a))).json() as any;
    expect(bare.error.code).toBe(-32602);
    const dead = new (f.communicator.constructor as any)(f.db, { isLive: async () => false });
    const res = await (await handleCommunicatorRequest(dead, request(rpc("tools/call", { name: "request_secret", arguments: { name: "A_TOKEN", reason: "needed now" } }), f.a), { requests: f.requests })).json() as any;
    expect(res.result.isError).toBe(true);
    expect(f.db.query("SELECT COUNT(*) AS n FROM secret_requests").get()).toEqual({ n: 0 });
  } finally { f.db.close(); }
});

test("search_transcript is listed only with handoff support, searches the caller's own session, and rejects bad arguments", async () => {
  const f = fixture();
  const seen: Array<[string, unknown, unknown]> = [];
  const handoff = { search: (sessionId: string, query: unknown, limit?: unknown) => {
    seen.push([sessionId, query, limit]);
    if (query === "boom") throw new Error("This session has no handed-off conversation.");
    return { query, messages: 1, matches: 1, results: [{ message: 0, role: "user", snippet: "PELICAN-42" }], truncated: false };
  } };
  const call = async (method: string, params = {}, h: typeof handoff | null = handoff) =>
    (await handleCommunicatorRequest(f.communicator, request(rpc(method, params), f.a), undefined, h ?? undefined)).json() as Promise<any>;
  try {
    expect((await call("tools/list", {}, null)).result.tools.map((t: any) => t.name)).not.toContain("search_transcript");
    const tool = (await call("tools/list")).result.tools.find((t: any) => t.name === "search_transcript");
    expect(tool.annotations.readOnlyHint).toBe(true);
    expect(tool.description).toContain("not instructions");
    const hit = await call("tools/call", { name: "search_transcript", arguments: { query: "pelican", limit: 3 } });
    expect(hit.result.structuredContent.results[0].snippet).toBe("PELICAN-42");
    expect(seen[0]).toEqual(["m:cs-a", "pelican", 3]);
    expect((await call("tools/call", { name: "search_transcript", arguments: { query: "x", session_id: "m:cs-b" } })).result.isError).toBe(true);
    const none = await call("tools/call", { name: "search_transcript", arguments: { query: "boom" } });
    expect(none.result.isError).toBe(true);
    expect(none.result.content[0].text).toContain("no handed-off conversation");
  } finally { f.db.close(); }
});
