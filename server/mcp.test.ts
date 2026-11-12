import { expect, test } from "bun:test";
import { handleMcpPost, sessionState, settleQueuedPrompts, type McpDeps } from "./mcp";
import { keyBytes, pasteBytes, screenFromId, tailLines } from "./session-io";
import type { SessionInfo } from "./sessions";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretStore } from "./secret-store";
import { createSecretCodec } from "./secrets";
import { SecretRequests } from "./secret-requests";

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
      { id: "codex", name: "Codex", remoteControl: false, turnState: true },
      { id: "command-code", name: "Command Code", remoteControl: false, turnState: true, asking: false },
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
    listArchive: () => [{ id: 7, provider: "codex", name: "old", initial: "O", project: "/x", claudeUrl: null, remoteControl: false, resumeId: "r", model: null, startedAt: 1, endedAt: 2, workspacePresent: true, canResume: true, mode: "terminal" }],
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

test("a launch prompt survives a workspace that takes longer than one call to prepare", async () => {
  let clock = 0;
  const { deps, sent } = harness({
    // Prepared after 70 s, like a fresh workspace on a busy server.
    listSessions: async () => [session({ status: clock < 70_000 ? "starting" : "running" })],
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  const r = await call(deps, "launch_session", { name: "demo", project_id: 1, prompt: "fix the tests" });
  expect(r.structuredContent).toMatchObject({ session_id: "m:cs-demo", prompt_sent: false, prompt_queued: true });
  await settleQueuedPrompts();
  expect(sent).toEqual([["m:cs-demo", "fix the tests", true]]);
});

test("a queued launch prompt is dropped, never typed, when the session fails or ends first", async () => {
  for (const later of [{ phase: "failed" } as Partial<SessionInfo>, { status: "ended" } as Partial<SessionInfo>]) {
    let clock = 0;
    const { deps, sent } = harness({
      listSessions: async () => [session(clock < 70_000 ? { status: "starting" } : later)],
      sleep: async (ms) => { clock += ms; },
      now: () => clock,
    });
    expect((await call(deps, "launch_session", { name: "demo", project_id: 1, prompt: "fix" })).structuredContent.prompt_queued).toBe(true);
    await settleQueuedPrompts();
    expect(sent).toEqual([]);
  }
});

test("a launch that fails before the agent is ready reports it instead of queueing", async () => {
  const { deps, sent } = harness({ listSessions: async () => [session({ phase: "failed" })] });
  const r = await call(deps, "launch_session", { name: "demo", project_id: 1, prompt: "fix" });
  expect(r.structuredContent).toMatchObject({ prompt_sent: false });
  expect(r.structuredContent.prompt_queued).toBeUndefined();
  await settleQueuedPrompts();
  expect(sent).toEqual([]);
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
    listSessions: async () => [session({ provider: "cmd:custom", waiting: false })],
    readScreen: async () => ({ ok: true, value: n++ < 3 ? `busy ${n}` : "idle" }),
  });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: 60 });
  expect(r.structuredContent).toMatchObject({ state: "running", timed_out: false, screen: "idle" });
});

test("wait_for_session hands back a working agent that cannot report a question once its screen is still", async () => {
  let n = 0;
  const { deps } = harness({
    listSessions: async () => [session({ provider: "command-code", busy: true, waiting: false })],
    readScreen: async () => ({ ok: true, value: n++ < 3 ? `busy ${n}` : "Allow shell_command? (y/n)" }),
  });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: 60 });
  expect(r.structuredContent).toMatchObject({ state: "working", timed_out: false, screen: "Allow shell_command? (y/n)" });
});

test("wait_for_session keeps waiting on a working agent that does report questions", async () => {
  const { deps } = harness({
    listSessions: async () => [session({ provider: "codex", busy: true, waiting: false })],
    readScreen: async () => ({ ok: true, value: "still" }),
  });
  const r = await call(deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: 20 });
  expect(r.structuredContent).toMatchObject({ state: "working", timed_out: true });
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

test("MCP reports confirmed startup trust as asking, preserving unready lifecycle", async () => {
  const pending = session({ provider: "codex", phase: "awaiting_session_start", status: "starting", startupWaitingForTrust: true, telemetryUnknown: true });
  expect(sessionState(pending, true)).toBe("asking");
  expect(sessionState({ ...pending, status: "ended" }, true)).toBe("ended");
  expect(sessionState({ ...pending, startupWaitingForTrust: false }, true)).toBe("starting");
});

const codexIdle = `>_ OpenAI Codex (v0.166.0)
/tmp/project
› Ask Codex to do anything
GPT-5.6-Sol xhigh Fast · /tmp/project
? for shortcuts   ⚠ 9 warnings · f2 to view`;

test("MCP can send the first Codex prompt before SessionStart, only into a confirmed current input", async () => {
  const pending = session({ provider: "codex", phase: "awaiting_session_start", startupInputReady: true, waiting: false });
  const { deps, sent } = harness({ listSessions: async () => [pending], readScreen: async () => ({ ok: true, value: codexIdle }) });
  expect(sessionState(pending, true)).toBe("running");
  expect(sessionState({ ...pending, waiting: true }, true)).toBe("running");
  expect((await call(deps, "list_sessions")).structuredContent.sessions[0]).toMatchObject({ state: "running", activity: "ready", startup_input_ready: true });
  expect((await call(deps, "launch_session", { name: "demo", agent: "codex", project_id: 1, prompt: "test prompt" })).structuredContent.prompt_sent).toBe(true);
  expect(sent).toEqual([["m:cs-demo", "test prompt", true]]);
  expect(pending.phase).toBe("awaiting_session_start");
});

test("MCP never submits an initial prompt into trust, unknown startup, failed state or a stale input behind an overlay", async () => {
  const cases: Array<[Partial<SessionInfo>, string]> = [
    [{ startupInputReady: false }, codexIdle],
    [{ startupWaitingForTrust: true }, codexIdle],
    [{ phase: "failed" }, codexIdle],
    [{}, "Trust these hooks?\n› 1. Trust and continue"],
    [{}, "Trust this folder?\n› 1. Trust and continue\n2. Back to Agent Command Center"],
    [{}, "Starting Codex"],
    [{}, codexIdle + "\nWarnings · 1 of 9 · Startup\nesc dismiss & close"],
  ];
  for (const [flags, viewport] of cases) {
    const { deps, sent } = harness({
      listSessions: async () => [session({ provider: "codex", phase: "awaiting_session_start", startupInputReady: true, ...flags })],
      readScreen: async () => ({ ok: true, value: viewport }),
    });
    expect((await call(deps, "launch_session", { name: "demo", agent: "codex", project_id: 1, prompt: "test prompt" })).structuredContent.prompt_sent).toBe(false);
    expect(sent).toEqual([]);
  }
});

test("launch_session passes mode through: terminal by default, acp when asked", async () => {
  const modes: unknown[] = [];
  const { deps } = harness({ launch: async ({ name, mode }) => { modes.push(mode); return { ok: true, id: `m:cs-${name}` }; } });
  await call(deps, "launch_session", { name: "a", project_id: 1 });
  await call(deps, "launch_session", { name: "b", project_id: 1, mode: "acp" });
  expect(modes).toEqual(["terminal", "acp"]);
  expect((await call(deps, "launch_session", { name: "c", project_id: 1, mode: "chat" })).isError).toBe(true);
});

test("an ACP session's prompt goes out once its bridge is ready, with no screen to settle", async () => {
  const { deps, sent } = harness({
    listSessions: async () => [session({ mode: "acp", provider: "codex", status: "running", waiting: true, turnState: true })],
    readScreen: async () => ({ ok: true, value: `changing ${Math.random()}` }),
  });
  const r = await call(deps, "launch_session", { name: "demo", project_id: 1, mode: "acp", prompt: "go" });
  expect(r.structuredContent).toMatchObject({ prompt_sent: true });
  expect(sent).toEqual([["m:cs-demo", "go", true]]);
});

function secretHarness() {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const store = createSecretStore({ database, codec: createSecretCodec(randomBytes(32)), sources: { fetch, runBws: async () => ({ code: 127, out: "" }) }, now: () => 7 });
  const requests = new SecretRequests({ database, origin: "https://cs.example", secrets: () => store, secretsFile: id => `/run/cs/${id}.env`, inLaunchEnvironment: async () => "outdated" });
  const restarts: string[] = [];
  const { deps } = harness({
    secrets: { requests, session: async (id) => id === "m:cs-demo" ? { launchId: "launch-demo", screen: "cs-demo", sessionName: "demo", agent: "codex" } : null },
    restart: async (id) => { restarts.push(id); return id === "m:cs-demo" ? { ok: true, session_id: id, archive_id: 3 } : { ok: false, error: "That session is not running.", ended: false }; },
  });
  return { deps, store, database, restarts };
}

test("operator secret tools create labelled requests for any live session and never return a value", async () => {
  const h = secretHarness();
  const tools = (await rpc(h.deps, "tools/list")).json.result.tools.map((t: any) => t.name);
  for (const name of ["list_secrets", "secret_status", "request_secret", "request_connector", "connector_status", "restart_session"]) expect(tools).toContain(name);
  const init = (await rpc(h.deps, "initialize")).json.result.instructions as string;
  expect(init).toContain("never ask for a value in chat".replace("never", "Never"));
  h.store.set("STORED", "operator-hidden-value");
  const list = await call(h.deps, "list_secrets");
  expect(list.structuredContent.secrets).toEqual([{ name: "STORED", source: "Coding Sessions", updated_at: new Date(7).toISOString() }]);
  const status = await call(h.deps, "secret_status", { name: "STORED", session_id: "m:cs-demo" });
  expect(status.structuredContent).toMatchObject({ set: true, in_launch_environment: "outdated", secrets_file: "/run/cs/launch-demo.env" });
  expect(JSON.stringify([list, status])).not.toContain("operator-hidden-value");

  const created = await call(h.deps, "request_secret", { name: "NEW_TOKEN", reason: "For the demo session", session_id: "m:cs-demo" });
  expect(created.structuredContent.url).toStartWith("https://cs.example/#secret-request=");
  expect(h.database.query("SELECT requested_by, screen, launch_id, agent FROM secret_requests").get())
    .toEqual({ requested_by: "operator", screen: "cs-demo", launch_id: "launch-demo", agent: "codex" });
  expect((await call(h.deps, "request_secret", { name: "X_TOKEN", reason: "needed", session_id: "m:cs-nope" })).isError).toBe(true);
  expect((await call(h.deps, "request_secret", { name: "PATH", reason: "needed" })).isError).toBe(true);
  expect((await call(h.deps, "connector_status", { name: "KazTrack" })).structuredContent).toMatchObject({ exists: false, request: null });
});

test("restart_session restarts through the dependency and reports refusals as errors", async () => {
  const h = secretHarness();
  expect((await call(h.deps, "restart_session", { session_id: "m:cs-demo" })).structuredContent).toMatchObject({ ok: true, restarted: true, archive_id: 3 });
  const refused = await call(h.deps, "restart_session", { session_id: "m:cs-gone" });
  expect(refused.isError).toBe(true);
  expect(refused.content[0].text).toBe("That session is not running.");
  expect(h.restarts).toEqual(["m:cs-demo", "m:cs-gone"]);
  const { deps } = harness();
  expect((await call(deps, "request_secret", { name: "A_B", reason: "needed" })).isError).toBe(true);
  expect((await call(deps, "restart_session", { session_id: "m:cs-demo" })).isError).toBe(true);
});

/* ---------- agent ergonomics: codes, filters, reasons, handoff ---------- */

test("tools/list keeps every existing tool, adds handoff_session, and annotates read-only and destructive tools", async () => {
  const { deps } = harness();
  const tools = (await rpc(deps, "tools/list")).json.result.tools as any[];
  const names = tools.map((t) => t.name);
  for (const name of ["agent_accounts", "agent_auth", "list_sessions", "read_session", "send_message", "press_keys", "wait_for_session",
    "list_projects", "list_repos", "launch_session", "resume_session", "list_secrets", "secret_status", "request_secret",
    "request_connector", "connector_status", "restart_session", "end_session", "handoff_session"]) expect(names).toContain(name);
  const by = Object.fromEntries(tools.map((t) => [t.name, t]));
  for (const ro of ["list_sessions", "read_session", "wait_for_session", "list_projects", "list_repos", "list_secrets", "secret_status", "connector_status", "agent_accounts"]) {
    expect(by[ro].annotations.readOnlyHint).toBe(true);
  }
  for (const d of ["end_session", "restart_session", "agent_auth"]) expect(by[d].annotations.destructiveHint).toBe(true);
  expect(by.handoff_session.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  expect(by.handoff_session.inputSchema.required).toEqual(["name", "repo", "branch", "cwd"]);
  expect(Object.keys(by.list_sessions.inputSchema.properties)).toEqual(["include_ended", "agent", "state", "query", "limit"]);
  const init = (await rpc(deps, "initialize", { protocolVersion: "2025-06-18" })).json.result.instructions as string;
  expect(init).toContain("handoff_session");
  expect(init).toContain("structuredContent.error");
});

test("errors carry a code and a next step in structuredContent, and the next step in the text", async () => {
  const { deps } = harness();
  const missing = await call(deps, "read_session", { session_id: "m:cs-nope" });
  expect(missing.isError).toBe(true);
  expect(missing.structuredContent.error).toMatchObject({ code: "not_found" });
  expect(missing.structuredContent.error.next).toContain("list_sessions");
  expect(missing.content[0].text).toContain("Next: list_sessions");
  expect((await call(deps, "read_session", {})).structuredContent.error.code).toBe("invalid_argument");
  expect((await call(deps, "resume_session", { archive_id: "x" })).structuredContent.error.code).toBe("invalid_argument");
  expect((await call(deps, "press_keys", { session_id: "m:cs-demo", keys: [] })).structuredContent.error.code).toBe("invalid_argument");
  expect((await call(deps, "send_message", { session_id: "m:cs-demo", text: " ", submit: false })).structuredContent.error.code).toBe("invalid_argument");
  const gone = harness({ sendText: async () => ({ ok: false, error: "No such session." }), sendKeys: async () => ({ ok: false, error: "No such session." }) });
  expect((await call(gone.deps, "send_message", { session_id: "m:cs-x", text: "hi" })).structuredContent.error.code).toBe("not_found");
  expect((await call(gone.deps, "press_keys", { session_id: "m:cs-x", keys: ["enter"] })).structuredContent.error.code).toBe("not_found");
  expect((await call(gone.deps, "send_message", { session_id: "m:cs-demo", text: "hi" })).structuredContent.error.code).toBe("failed");
  expect((await call(harness({ resume: async () => ({ ok: false, error: "No archived session with that id." }) }).deps, "resume_session", { archive_id: 9 }))
    .structuredContent.error.code).toBe("not_found");
});

test("launch_session validates name, target and mode with clear codes before launching", async () => {
  const launched: string[] = [];
  const { deps } = harness({ launch: async ({ name }) => { launched.push(name); return name === "taken" ? { ok: false, error: "A session named “k-taken” is already running." } : { ok: true, id: `m:cs-${name}` }; } });
  const code = async (args: object) => (await call(deps, "launch_session", args)).structuredContent.error?.code;
  expect(await code({ name: "bad name!", project_id: 1 })).toBe("invalid_argument");
  expect(await code({ name: "-x", project_id: 1 })).toBe("invalid_argument");
  expect(await code({ name: "ok", project_id: 1, repo: "me/a" })).toBe("invalid_argument");
  expect(await code({ name: "ok", project_id: 99 })).toBe("not_found");
  expect(await code({ name: "ok", repo: "me/a", mode: "acp" })).toBe("invalid_argument");
  expect(await code({ name: "ok", project_id: 1, mode: "gui" })).toBe("invalid_argument");
  expect(await code({ name: "ok", agent: "gpt", project_id: 1 })).toBe("invalid_argument");
  expect(launched).toEqual([]);
  expect(await code({ name: "taken", project_id: 1 })).toBe("conflict");
  expect((await call(deps, "launch_session", { name: "fine", repo: "me/a" })).structuredContent).toMatchObject({ session_id: "m:cs-fine", launched: true });
});

test("list_sessions filters by agent, state and query, bounds by limit, and adds mode, PR links and pending requests", async () => {
  const sessions = [
    session({ id: "m:cs-a", name: "k-alpha", provider: "claude", waiting: true }),
    session({ id: "m:cs-b", name: "k-beta", provider: "codex", busy: true, waiting: false, mode: "acp" }),
    session({ id: "m:cs-c", name: "k-gamma", provider: "claude", busy: true, waiting: false, project: "/srv/shop" }),
  ];
  const { deps } = harness({
    listSessions: async () => sessions,
    listArchive: () => [
      { id: 1, name: "k-old", provider: "claude", project: "/srv/demo", model: null, claudeUrl: null, endedAt: 0, canResume: true } as any,
      { id: 2, name: "k-older", provider: "codex", project: "/srv/demo", model: null, claudeUrl: null, endedAt: 0, canResume: true } as any,
    ],
    sessionExtras: (list) => new Map(list.map((s) => [s.id, {
      prs: s.id === "m:cs-a" ? [{ url: "https://github.com/me/a/pull/7", repo: "me/a", number: 7, state: "open", title: "Fix" }] : [],
      requests: s.id === "m:cs-c" ? [{ id: "r1", kind: "secret", name: "API_KEY" }] : [],
    }])),
  });
  const list = async (args: object) => (await call(deps, "list_sessions", args)).structuredContent;
  const all = await list({});
  expect(all.total).toBe(3);
  expect(all.sessions[0]).toMatchObject({ id: "m:cs-a", session_id: "m:cs-a", mode: "terminal", prs: [{ number: 7, state: "open" }], pending_requests: [] });
  expect(all.sessions[1].mode).toBe("acp");
  expect(all.sessions[2].pending_requests).toEqual([{ id: "r1", kind: "secret", name: "API_KEY" }]);
  expect((await list({ agent: "codex" })).sessions.map((s: any) => s.id)).toEqual(["m:cs-b"]);
  expect((await list({ state: "working" })).sessions.map((s: any) => s.id)).toEqual(["m:cs-b", "m:cs-c"]);
  expect((await list({ query: "SHOP" })).sessions.map((s: any) => s.id)).toEqual(["m:cs-c"]);
  expect(await list({ limit: 1 })).toMatchObject({ total: 3, truncated: true });
  expect((await list({ limit: 1 })).sessions).toHaveLength(1);
  const ended = await list({ include_ended: true, agent: "codex" });
  expect(ended.ended.map((a: any) => a.archive_id)).toEqual([2]);
  expect(ended.ended_total).toBe(1);
  // Without the dependency the lists stay empty rather than failing.
  expect((await call(harness().deps, "list_sessions", {})).structuredContent.sessions[0]).toMatchObject({ prs: [], pending_requests: [] });
});

test("read_session returns mode, pending requests and the next step; a Chat session's permission request reads as asking", async () => {
  const acp = session({ mode: "acp", asking: true, waiting: true });
  const { deps } = harness({
    listSessions: async () => [acp],
    readScreen: async () => ({ ok: true, value: "Agent wants to run `rm -rf build`\nOptions: Allow once (allow) | Reject (reject)" }),
    sessionExtras: () => new Map([[acp.id, { prs: [], requests: [{ id: "r2", kind: "connector", name: "KazTrack" }] }]]),
  });
  const r = (await call(deps, "read_session", { session_id: "m:cs-demo" })).structuredContent;
  expect(r).toMatchObject({ mode: "acp", state: "asking", pending_requests: [{ name: "KazTrack" }] });
  expect(r.screen).toContain("Allow once");
  expect(r.next).toContain("send_message");
  expect(r.note).toContain("secret_status");
  const terminal = (await call(harness().deps, "read_session", { session_id: "m:cs-demo" })).structuredContent;
  expect(terminal).toMatchObject({ mode: "terminal", state: "waiting", pending_requests: [] });
  expect(terminal.next).toContain("send_message");
});

test("wait_for_session says why it stopped", async () => {
  const reason = async (over: Partial<McpDeps>, timeout = 10) =>
    (await call(harness(over).deps, "wait_for_session", { session_id: "m:cs-demo", timeout_seconds: timeout })).structuredContent;
  expect(await reason({})).toMatchObject({ reason: "turn_finished", timed_out: false });
  expect(await reason({ listSessions: async () => [session({ asking: true })] })).toMatchObject({ reason: "asking" });
  expect(await reason({ listSessions: async () => [] })).toMatchObject({ reason: "ended", state: "ended" });
  expect(await reason({ listSessions: async () => [session({ busy: true, waiting: false })] })).toMatchObject({ reason: "timeout", timed_out: true, next: "wait_for_session again" });
  expect(await reason({ listSessions: async () => [session({ provider: "cmd:x" as any })] })).toMatchObject({ reason: "screen_settled", state: "running" });
});

function handoffHarness(state: "none" | "live" | "resumable" = "none") {
  const tickets: any[] = [];
  const prepared: any[] = [];
  const h = harness({
    handoff: {
      status: async (name) => ({ ok: true, status: { state, name: `k-${name}`, workspacePath: `/home/u/workspaces/k-${name}` } }),
      prepare: async (name, repo, branch) => { prepared.push([name, repo, branch]); return { ok: true, workspacePath: `/home/u/workspaces/k-${name}` }; },
      createUpload: (t) => { tickets.push(t); return { url: "https://sessions.example.com/mcp/handoff/cshand_abcdefghijklmnopqrstuvwxyz", expiresAt: 900_000 }; },
    },
  });
  return { ...h, tickets, prepared };
}

test("handoff_session prepares the branch and returns a one-time upload command, never asking for the transcript itself", async () => {
  const h = handoffHarness();
  const r = await call(h.deps, "handoff_session", { name: "login-fix", repo: "me/app", branch: "fix/login", cwd: "/Users/me/app", transcript_id: "abc-123", prompt: "now add tests" });
  expect(r.isError).toBeUndefined();
  const data = r.structuredContent;
  expect(h.prepared).toEqual([["login-fix", "me/app", "fix/login"]]);
  expect(h.tickets).toEqual([{ name: "login-fix", workspace: "/home/u/workspaces/k-login-fix", resumeId: "abc-123", prompt: "now add tests", autoMode: false }]);
  expect(data.command).toContain("https://sessions.example.com/mcp/handoff/cshand_");
  expect(data.command).toContain('"$HOME"/.claude/projects/-Users-me-app/abc-123.jsonl');
  expect(data.transcript).toBe("~/.claude/projects/-Users-me-app/abc-123.jsonl");
  expect(data.expires_at).toBe(new Date(900_000).toISOString());
  expect(data.next).toContain("wait_for_session");
  // No transcript id: the command picks the newest transcript for cwd.
  const newest = (await call(h.deps, "handoff_session", { name: "x", repo: "me/app", branch: "b", cwd: "/Users/me/app" })).structuredContent;
  expect(newest.command).toContain("ls -t");
  expect(h.tickets[1].resumeId).toBeNull();
  // The schema has no field for transcript content.
  const tool = ((await rpc(h.deps, "tools/list")).json.result.tools as any[]).find((t) => t.name === "handoff_session");
  expect(Object.keys(tool.inputSchema.properties)).toEqual(["name", "repo", "branch", "cwd", "transcript_id", "prompt", "agent"]);
});

test("handoff_session validates its input and refuses names already in use", async () => {
  const h = handoffHarness();
  const code = async (args: object, deps = h.deps) => (await call(deps, "handoff_session", args)).structuredContent.error?.code;
  const base = { name: "a", repo: "me/app", branch: "b", cwd: "/w" };
  expect(await code({ ...base, name: "bad name" })).toBe("invalid_argument");
  expect(await code({ ...base, repo: "" })).toBe("invalid_argument");
  expect(await code({ ...base, branch: "" })).toBe("invalid_argument");
  expect(await code({ ...base, cwd: "relative/dir" })).toBe("invalid_argument");
  expect(await code({ ...base, transcript_id: "../../etc/passwd" })).toBe("invalid_argument");
  expect(await code({ ...base, agent: "codex" })).toBe("invalid_argument");
  expect(h.prepared).toEqual([]);
  expect(await code(base, handoffHarness("live").deps)).toBe("conflict");
  expect(await code(base, handoffHarness("resumable").deps)).toBe("conflict");
  expect(await code(base, harness().deps)).toBe("unavailable");
});
