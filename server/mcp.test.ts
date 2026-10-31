import { expect, test } from "bun:test";
import { handleMcpPost, sessionState, type McpDeps } from "./mcp";
import { keyBytes, pasteBytes, screenFromId, tailLines } from "./session-io";
import type { SessionInfo } from "./sessions";

function session(over: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "m:cs-demo", kind: "managed", provider: "claude", launchId: null, phase: null, errorMessage: null,
    name: "demo", status: "running", workspace: false, project: "/srv/demo", projectLabel: "Demo",
    pid: 10, uptimeSec: 5, cpu: 0, active: false, busy: false, waiting: true, asking: false,
    telemetryUnknown: false, claudeUrl: null, remoteControl: true, resumeId: null, model: null, initial: "D",
    ...over,
  };
}

function harness(over: Partial<McpDeps> = {}) {
  let clock = 0;
  const sent: Array<[string, string, boolean]> = [];
  const deps: McpDeps = {
    listSessions: async () => [session()],
    listArchive: () => [],
    hostStats: () => ({ cpu: 1 }),
    listProjects: () => [{ id: 1, path: "/srv/demo", label: "Demo" }],
    listRepos: async () => ["me/a", "me/b"],
    providers: () => [
      { id: "claude", name: "Claude", remoteControl: true, turnState: true },
      { id: "command-code", name: "Command Code", remoteControl: false, turnState: false },
    ],
    launch: async ({ name }) => ({ ok: true, id: `m:cs-${name}` }),
    end: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
    readScreen: async () => ({ ok: true, value: "❯ ready" }),
    sendText: async (id, text, submit) => { sent.push([id, text, submit]); return { ok: true, value: true }; },
    sendKeys: async () => ({ ok: true, value: true }),
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
    ...over,
  };
  return { deps, sent };
}

async function rpc(deps: McpDeps, method: string, params: object = {}, id: number | null = 1) {
  const body = id === null ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id, method, params };
  const res = await handleMcpPost(deps, new Request("https://x/mcp", { method: "POST", body: JSON.stringify(body) }));
  return { status: res.status, json: res.status === 202 ? null : await res.json() as any };
}

const call = async (deps: McpDeps, name: string, args: object = {}) =>
  (await rpc(deps, "tools/call", { name, arguments: args })).json.result;

test("initialize echoes a supported protocol version and falls back otherwise", async () => {
  const { deps } = harness();
  expect((await rpc(deps, "initialize", { protocolVersion: "2025-06-18" })).json.result.protocolVersion).toBe("2025-06-18");
  expect((await rpc(deps, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion).toBe("2025-11-25");
  expect((await rpc(deps, "notifications/initialized", {}, null)).status).toBe(202);
  expect((await rpc(deps, "nope")).json.error.code).toBe(-32601);
});

test("tools/list names every tool with a schema", async () => {
  const { deps } = harness();
  const tools = (await rpc(deps, "tools/list")).json.result.tools as any[];
  expect(tools.map((t) => t.name)).toContain("wait_for_session");
  for (const t of tools) expect(t.inputSchema.type).toBe("object");
});

test("MCP account tools expose sanitized account status and delegate explicit account changes", async () => {
  const actions: unknown[][] = [];
  const { deps } = harness({ accounts: {
    list: async () => ({ accounts: [{ provider: "codex", loggedIn: true, email: "test@example.test", loggedInSince: null }] }),
    action: async (...args) => { actions.push(args); return { ok: true, login: { state: "awaiting_user" } }; },
  } });
  expect((await call(deps, "agent_accounts")).structuredContent.accounts[0].email).toBe("test@example.test");
  expect((await call(deps, "agent_auth", { agent: "codex", action: "login" })).structuredContent.ok).toBe(true);
  expect(actions).toEqual([["codex", "login", undefined]]);
  expect((await call(harness().deps, "agent_accounts")).isError).toBe(true);
});

test("list_sessions reports state and the archive on request", async () => {
  const { deps } = harness({
    listArchive: () => [{ id: 7, provider: "codex", name: "old", initial: "O", project: "/x", claudeUrl: null, remoteControl: false, resumeId: "r", model: null, startedAt: 1, endedAt: 2, workspacePresent: true, canResume: true }],
  });
  const r = await call(deps, "list_sessions", { include_ended: true });
  expect(r.structuredContent.sessions[0].state).toBe("waiting");
  expect(r.structuredContent.ended[0].archive_id).toBe(7);
});

test("launch_session with a prompt waits for a steady screen, then sends it", async () => {
  const { deps, sent } = harness();
  const r = await call(deps, "launch_session", { name: "demo", project_id: 1, prompt: "fix the tests" });
  expect(r.structuredContent).toMatchObject({ session_id: "m:cs-demo", prompt_sent: true });
  expect(sent).toEqual([["m:cs-demo", "fix the tests", true]]);
});

test("launch_session refuses an unknown agent and a missing target", async () => {
  const { deps } = harness();
  expect((await call(deps, "launch_session", { name: "x", agent: "gpt", project_id: 1 })).isError).toBe(true);
  expect((await call(deps, "launch_session", { name: "x" })).isError).toBe(true);
});

test("wait_for_session ignores a 'waiting' seen in the first seconds after a message", async () => {
  let reads = 0;
  const { deps } = harness({ readScreen: async () => ({ ok: true, value: `frame ${reads++}` }) });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: 30 });
  expect(r.structuredContent.state).toBe("waiting");
  expect(r.structuredContent.timed_out).toBe(false);
  expect(r.structuredContent.waited_sec).toBeGreaterThanOrEqual(4);
});

test("wait_for_session times out while working", async () => {
  const { deps } = harness({ listSessions: async () => [session({ busy: true, waiting: false })] });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: 10 });
  expect(r.structuredContent).toMatchObject({ state: "working", timed_out: true });
});

test("wait_for_session without turn state waits for a still screen", async () => {
  let n = 0;
  const { deps } = harness({
    listSessions: async () => [session({ provider: "command-code", waiting: false })],
    readScreen: async () => ({ ok: true, value: n++ < 3 ? `busy ${n}` : "idle" }),
  });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: 60 });
  expect(r.structuredContent).toMatchObject({ state: "running", timed_out: false, screen: "idle" });
});

test("wait_for_session returns at once when the session is gone", async () => {
  const { deps } = harness({ listSessions: async () => [] });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo" });
  expect(r.structuredContent).toMatchObject({ state: "ended", timed_out: false, waited_sec: 0 });
});

test("sessionState maps the card flags", () => {
  expect(sessionState(undefined, true)).toBe("ended");
  expect(sessionState(session({ status: "starting" }), true)).toBe("starting");
  expect(sessionState(session({ asking: true }), true)).toBe("asking");
  expect(sessionState(session({ busy: true, waiting: false }), true)).toBe("working");
  expect(sessionState(session({ telemetryUnknown: true }), true)).toBe("running");
  expect(sessionState(session(), false)).toBe("running");
});

test("session-io: keys, paste, ids and screen tails", () => {
  expect(keyBytes("enter")).toBe("\r");
  expect(keyBytes("Shift+Tab")).toBe("\x1b[Z");
  expect(keyBytes("2")).toBe("2");
  expect(keyBytes("nonsense")).toBeNull();
  expect(pasteBytes("one line")).toBe("one line");
  expect(pasteBytes("a\r\nb")).toBe("\x1b[200~a\nb\x1b[201~");
  expect(pasteBytes("x\x1b[201~y\nz")).toBe("\x1b[200~xy\nz\x1b[201~"); // can't close the paste early
  expect(screenFromId("m:cs-demo")).toBe("cs-demo");
  expect(screenFromId("e:123")).toBeNull();
  expect(screenFromId("m:cs-a;rm")).toBeNull();
  expect(tailLines("a\nb\x1b[31mc\x1b[0m  \n\n\n", 2)).toBe("a\nbc");
});

test("MCP code-submission errors stay errors and Command Code continues in browser", async () => {
  const { deps } = harness({ accounts: {
    list: async () => ({ accounts: [] }),
    action: async (provider, action) => provider === "claude" && action === "submit_code"
      ? { ok: false, error: "Claude could not accept the callback code." }
      : { ok: true, requiresBrowser: true, path: "/?settings=agent-auth&agent=command-code" },
  } });
  expect((await call(deps, "agent_auth", { agent: "claude", action: "submit_code", code: "1234" })).isError).toBe(true);
  const result = await call(deps, "agent_auth", { agent: "command-code", action: "login" });
  expect(result.structuredContent).toMatchObject({ ok: true, requiresBrowser: true, path: "/?settings=agent-auth&agent=command-code" });
  const tools = (await rpc(deps, "tools/list")).json.result.tools;
  const schema = tools.find((tool: { name: string }) => tool.name === "agent_auth").inputSchema;
  expect(Object.keys(schema.properties)).toEqual(["agent", "action", "code"]);
});

test("list_sessions adds UI activity without changing legacy MCP state", async () => {
  const { deps } = harness({
    providers: () => [{ id: "codex", name: "Codex", remoteControl: false, turnState: true }],
    listSessions: async () => [session({ provider: "codex", waiting: true, turnComplete: true })],
  });
  const result = await call(deps, "list_sessions", {});
  expect(result.structuredContent.sessions[0]).toMatchObject({ state: "waiting", activity: "finished" });
});
