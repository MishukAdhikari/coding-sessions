/**
 * The MCP connector: Streamable HTTP at POST /mcp, stateless JSON responses, for the
 * Claude app, Claude Code and Codex. It exposes what the web app does — list, Launch,
 * read, type, wait, Resume, End — as tools, so an agent can drive a Session from the
 * first prompt to the finished turn without a browser.
 *
 * Dependencies come in as an object so tests drive the protocol without a server.
 */
import type { ArchivedInfo, SessionInfo } from "./sessions";
import type { IoResult } from "./session-io";
import { sessionActivity } from "./session-activity";
import type { SessionProvider } from "./session-provider";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "xcloud-sessions", title: "Coding Sessions", version: "1.0.0" };

const INSTRUCTIONS = `Coding Sessions runs Claude, Codex and Command Code agents in terminal sessions on one server; this connector drives them.
Typical loop: list_sessions (or launch_session with a prompt) → send_message → wait_for_session → read_session, repeating until the work is done.
Session ids look like "m:cs-name". A session's state is one of: starting, working, asking (blocked on a question — read_session, then press_keys or send_message to answer), waiting (finished its turn, ready for the next message), running (alive; this agent reports no turn state), ended.
When startup_waiting_for_trust is true, Codex is waiting for the operator to review folder trust before its managed startup hook can run. Report this decision to the operator; do not accept trust automatically.
The additive activity field matches the web UI: running, waiting (needs input), finished (turn complete; session still open), ready, connected (no reliable turn signal), starting, ended, or failed.
Sessions use the server-configured permission mode and may require trust or approval in their terminal; end_session stops one and archives it, resume_session reopens an archived conversation.`;

export interface McpDeps {
  accounts?: {
    list(): Promise<Record<string, unknown>>;
    action(provider: unknown, action: unknown, code?: unknown): Promise<Record<string, unknown>>;
  };
  listSessions(): Promise<SessionInfo[]>;
  listArchive(): ArchivedInfo[];
  hostStats(): unknown;
  listProjects(): Array<{ id: number; path: string; label: string }>;
  listRepos(): Promise<string[]>;
  providers(): Array<{ id: SessionProvider; name: string; remoteControl: boolean; turnState: boolean }>;
  launch(opts: { name: string; provider: SessionProvider; projectId: number | null; repo: string | null; remoteControl: boolean }):
    Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  end(id: string, deleteWorkspace: boolean): Promise<{ ok: boolean; error?: string }>;
  resume(archiveId: number): Promise<{ ok: true } | { ok: false; error: string }>;
  readScreen(id: string, lines: number): Promise<IoResult<string>>;
  sendText(id: string, text: string, submit: boolean): Promise<IoResult<true>>;
  sendKeys(id: string, keys: string[]): Promise<IoResult<true>>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

/* ---------- session state, as the tools describe it ---------- */

export type SessionState = "starting" | "working" | "asking" | "waiting" | "running" | "ended";

export function sessionState(s: SessionInfo | undefined, turnState: boolean): SessionState {
  if (!s || s.status === "ended") return "ended";
  if (s.provider === "codex" && s.phase === "awaiting_session_start" && s.startupWaitingForTrust) return "asking";
  if (s.status === "starting") return "starting";
  if (!turnState || s.telemetryUnknown) return "running";
  if (s.asking) return "asking";
  if (s.busy) return "working";
  if (s.waiting) return "waiting";
  return "running";
}

function summarize(s: SessionInfo, turnState: boolean) {
  return {
    id: s.id,
    name: s.name,
    agent: s.provider,
    state: sessionState(s, turnState),
    activity: sessionActivity(s),
    ...(s.startupWaitingForTrust ? { startup_waiting_for_trust: true } : {}),
    managed: s.kind === "managed",
    project: s.projectLabel ?? s.project,
    folder: s.project,
    workspace: s.workspace,
    model: s.model,
    uptime_sec: s.uptimeSec,
    claude_url: s.claudeUrl,
    error: s.errorMessage,
  };
}

function summarizeArchived(a: ArchivedInfo) {
  return {
    archive_id: a.id,
    name: a.name,
    agent: a.provider,
    folder: a.project,
    model: a.model,
    claude_url: a.claudeUrl,
    ended_at: new Date(a.endedAt).toISOString(),
    can_resume: a.canResume,
  };
}

/* ---------- tool definitions ---------- */

const sessionId = { type: "string", description: "Session id from list_sessions, like \"m:cs-name\"." };

export const TOOLS = [
  {
    name: "agent_accounts",
    title: "Agent account status",
    description: "Show which Codex, Claude, and Command Code accounts are signed in, their email and plan when available, and the recorded login time. Never returns credentials. Older or externally changed logins may have an unknown login time.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "agent_auth",
    title: "Manage an agent account",
    description: "Start or check sign-in, cancel sign-in, switch accounts, or sign out a server agent. Switch signs out first; switch/logout affect future sessions and may affect existing sessions on their next request. Use only when the user requests that account change. Codex returns a device URL/code; Claude returns a login URL and accepts a one-time callback code. Command Code API keys must be entered in the browser, never in this tool.",
    inputSchema: { type: "object", properties: {
      agent: { type: "string", enum: ["codex", "claude", "command-code"] },
      action: { type: "string", enum: ["status", "login", "switch", "logout", "cancel", "submit_code"] },
      code: { type: "string", description: "Claude one-time callback code only. Never pass API keys or access tokens." },
    }, required: ["agent", "action"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
  },
  {
    name: "list_sessions",
    title: "List sessions",
    description: "Live sessions with each one's agent, state and folder, plus the server's CPU, memory and free disk. include_ended adds archived (ended) sessions that resume_session can reopen.",
    inputSchema: { type: "object", properties: { include_ended: { type: "boolean", description: "Also list archived sessions. Default false." } } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "read_session",
    title: "Read a session's screen",
    description: "The bottom of a session's terminal as plain text, and its state. Use it to see what the agent did, said or is asking.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId, lines: { type: "integer", minimum: 5, maximum: 400, description: "Lines from the bottom. Default 80." } },
      required: ["session_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "send_message",
    title: "Send a message",
    description: "Type a message into a session's input and press Enter, as a person would in the terminal. Multi-line text arrives as one message. Follow with wait_for_session to let the agent work.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        text: { type: "string", description: "The message." },
        submit: { type: "boolean", description: "Press Enter after the text. Default true." },
      },
      required: ["session_id", "text"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "press_keys",
    title: "Press keys",
    description: "Press keys in a session, in order — for an agent's menus and questions: enter, escape, tab, shift+tab, up, down, left, right, backspace, space, ctrl+c, ctrl+d, ctrl+l, or one character such as \"1\" or \"y\".",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId, keys: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 20 } },
      required: ["session_id", "keys"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "wait_for_session",
    title: "Wait for a session",
    description: "Wait until the session's agent stops working — it finished its turn, asks a question, or ended — then return its state and screen. Returns early with timed_out: true; call again to keep waiting. For an agent without turn state, waits until its screen stops changing.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: sessionId,
        timeout_seconds: { type: "integer", minimum: 5, maximum: 90, description: "Default 50, at most 90 (Cloudflare ends a request at 100 seconds; some clients drop a call after 60)." },
        lines: { type: "integer", minimum: 5, maximum: 400, description: "Screen lines to return. Default 60." },
      },
      required: ["session_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_projects",
    title: "List projects and agents",
    description: "Where a session can be launched — the server's allowlisted projects (by id) — and the agents it can run (claude, codex, command-code, registered cmd:* commands).",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "list_repos",
    title: "List GitHub repos",
    description: "GitHub repos the server can clone for a fresh workspace (launch_session's repo), optionally filtered.",
    inputSchema: { type: "object", properties: { query: { type: "string", description: "Case-insensitive substring to filter by." } } },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  {
    name: "launch_session",
    title: "Launch a session",
    description: "Start an agent in a new session: in a project (project_id from list_projects) or in a fresh workspace cloned from a repo (\"owner/repo\", \"owner/repo#branch\", or a GitHub URL). With prompt, waits for the agent to be ready and sends it as the first message. Returns the session id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "1-31 chars: letters, numbers, dashes." },
        agent: { type: "string", description: "claude (default), codex, command-code, or a registered cmd:<slug>." },
        project_id: { type: "integer", description: "A project from list_projects." },
        repo: { type: "string", description: "Instead of project_id: a repo to clone into a fresh workspace." },
        remote_control: { type: "boolean", description: "Claude only: also open it in the Claude app's Remote Control. Default true." },
        prompt: { type: "string", description: "First message for the agent." },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "resume_session",
    title: "Resume an ended session",
    description: "Reopen an archived conversation (archive_id from list_sessions with include_ended) in a new session, in its original folder.",
    inputSchema: { type: "object", properties: { archive_id: { type: "integer" } }, required: ["archive_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "end_session",
    title: "End a session",
    description: "Stop a session's agent and archive it (it can be resumed). delete_workspace also removes a fresh workspace's folder, with any unpushed work in it.",
    inputSchema: {
      type: "object",
      properties: { session_id: sessionId, delete_workspace: { type: "boolean", description: "Default false." } },
      required: ["session_id"],
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

/* ---------- tool implementations ---------- */

type ToolResult = { content: Array<{ type: "text"; text: string }>; structuredContent?: Record<string, unknown>; isError?: boolean };

const ok = (data: Record<string, unknown>): ToolResult =>
  ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data });
const fail = (message: string): ToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const int = (v: unknown, def: number, min: number, max: number) =>
  Number.isFinite(Number(v)) && v !== null && v !== "" ? Math.min(max, Math.max(min, Math.trunc(Number(v)))) : def;
const str = (v: unknown) => (typeof v === "string" ? v : "");

function turnStateFor(deps: McpDeps, provider: SessionProvider): boolean {
  return deps.providers().find((p) => p.id === provider)?.turnState ?? false;
}

async function findSession(deps: McpDeps, id: string): Promise<SessionInfo | undefined> {
  return (await deps.listSessions()).find((s) => s.id === id);
}

/**
 * Poll until the agent stops working. With turn state, "waiting"/"asking"/"ended"
 * ends the wait — ignored for the first few seconds, because right after a message
 * the transcript can still show the previous turn's end. Without turn state, three
 * identical screens in a row do.
 */
export async function waitForSession(deps: McpDeps, id: string, timeoutSec: number, lines: number) {
  const started = deps.now();
  const deadline = started + timeoutSec * 1000;
  const SETTLE_MS = 4000;
  let last = "";
  let same = 0;
  for (;;) {
    const s = await findSession(deps, id);
    const turnState = s ? turnStateFor(deps, s.provider) : false;
    const state = sessionState(s, turnState);
    const screen = state === "ended" ? null : await deps.readScreen(id, lines);
    const text = screen?.ok ? screen.value : "";
    same = text && text === last ? same + 1 : 0;
    last = text;
    const settled = deps.now() - started >= SETTLE_MS;
    const done = state === "ended"
      || (settled && (state === "waiting" || state === "asking"))
      || (state === "running" && same >= 2);
    const timedOut = deps.now() >= deadline;
    if (done || timedOut) {
      return { session_id: id, state, timed_out: !done, waited_sec: Math.round((deps.now() - started) / 1000), screen: screen?.ok ? screen.value : null };
    }
    await deps.sleep(2000);
  }
}

/** After a Launch: wait for the session to exist and its screen to settle, then type. */
async function waitUntilReady(deps: McpDeps, id: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  let last = "";
  let same = 0;
  while (deps.now() < deadline) {
    const s = await findSession(deps, id);
    if (s?.status === "running") {
      const screen = await deps.readScreen(id, 40);
      const text = screen.ok ? screen.value.trim() : "";
      same = text && text === last ? same + 1 : 0;
      last = text;
      if (same >= 2) return true;
    }
    await deps.sleep(1500);
  }
  return false;
}

export async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "agent_accounts":
      return deps.accounts ? ok(await deps.accounts.list()) : fail("Agent account controls are unavailable.");
    case "agent_auth": {
      if (!deps.accounts) return fail("Agent account controls are unavailable.");
      const result = await deps.accounts.action(args.agent, args.action, args.code);
      return result.ok ? ok(result) : fail(typeof result.error === "string" ? result.error : "Account operation failed.");
    }
    case "list_sessions": {
      const sessions = (await deps.listSessions()).map((s) => summarize(s, turnStateFor(deps, s.provider)));
      const data: Record<string, unknown> = { sessions, host: deps.hostStats() };
      if (args.include_ended === true) data.ended = deps.listArchive().map(summarizeArchived);
      return ok(data);
    }

    case "read_session": {
      const id = str(args.session_id);
      const s = await findSession(deps, id);
      if (!s) return fail(`No live session ${id}. list_sessions shows the live ones.`);
      const screen = await deps.readScreen(id, int(args.lines, 80, 5, 400));
      if (!screen.ok) return fail(screen.error);
      return ok({ session_id: id, name: s.name, agent: s.provider, state: sessionState(s, turnStateFor(deps, s.provider)), screen: screen.value });
    }

    case "send_message": {
      const id = str(args.session_id);
      const text = str(args.text);
      if (!text.trim() && args.submit === false) return fail("Nothing to send.");
      const r = await deps.sendText(id, text, args.submit !== false);
      return r.ok ? ok({ session_id: id, sent: true, next: "wait_for_session" }) : fail(r.error);
    }

    case "press_keys": {
      const id = str(args.session_id);
      const keys = Array.isArray(args.keys) ? args.keys.map(String).slice(0, 20) : [];
      if (!keys.length) return fail("keys is empty.");
      const r = await deps.sendKeys(id, keys);
      return r.ok ? ok({ session_id: id, pressed: keys }) : fail(r.error);
    }

    case "wait_for_session": {
      const id = str(args.session_id);
      return ok(await waitForSession(deps, id, int(args.timeout_seconds, 50, 5, 90), int(args.lines, 60, 5, 400)));
    }

    case "list_projects":
      return ok({ projects: deps.listProjects(), agents: deps.providers() });

    case "list_repos": {
      const q = str(args.query).toLowerCase();
      const repos = (await deps.listRepos()).filter((r) => !q || r.toLowerCase().includes(q));
      return ok({ repos: repos.slice(0, 200), total: repos.length });
    }

    case "launch_session": {
      const provider = (str(args.agent) || "claude") as SessionProvider;
      if (!deps.providers().some((p) => p.id === provider)) {
        return fail(`Unknown agent “${provider}”. list_projects shows the agents this server runs.`);
      }
      const repo = str(args.repo).trim() || null;
      const projectId = args.project_id == null ? null : Number(args.project_id);
      if (!repo && !Number.isInteger(projectId)) return fail("Give project_id (from list_projects) or repo.");
      const r = await deps.launch({ name: str(args.name), provider, projectId: repo ? null : projectId, repo, remoteControl: args.remote_control !== false });
      if (!r.ok) return fail(r.error);
      const prompt = str(args.prompt);
      if (!prompt.trim()) return ok({ session_id: r.id, launched: true, next: "send_message" });
      if (!(await waitUntilReady(deps, r.id))) {
        return ok({ session_id: r.id, launched: true, prompt_sent: false, note: "The agent wasn't ready in time; read_session, then send_message." });
      }
      const sent = await deps.sendText(r.id, prompt, true);
      return sent.ok
        ? ok({ session_id: r.id, launched: true, prompt_sent: true, next: "wait_for_session" })
        : ok({ session_id: r.id, launched: true, prompt_sent: false, note: sent.error });
    }

    case "resume_session": {
      const id = Number(args.archive_id);
      if (!Number.isInteger(id)) return fail("archive_id must be an integer.");
      const r = await deps.resume(id);
      return r.ok ? ok({ resumed: true, next: "list_sessions" }) : fail(r.error);
    }

    case "end_session": {
      const id = str(args.session_id);
      const r = await deps.end(id, args.delete_workspace === true);
      return r.ok ? ok({ session_id: id, ended: true }) : fail(r.error ?? "Couldn't end the session.");
    }
  }
  return fail(`Unknown tool ${name}.`);
}

/* ---------- JSON-RPC over Streamable HTTP ---------- */

type JsonRpcId = string | number | null;
const rpcResult = (id: JsonRpcId, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: JsonRpcId, code: number, message: string) => ({ jsonrpc: "2.0", id, error: { code, message } });

async function dispatch(deps: McpDeps, msg: any): Promise<object | null> {
  if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
    return rpcError(msg?.id ?? null, -32600, "Invalid request");
  }
  const isNotification = !("id" in msg);
  const id: JsonRpcId = msg.id ?? null;
  const params = msg.params && typeof msg.params === "object" ? msg.params : {};

  switch (msg.method) {
    case "initialize": {
      const asked = String(params.protocolVersion ?? "");
      return rpcResult(id, {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked) ? asked : SUPPORTED_PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return isNotification ? null : rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: TOOLS });
    case "tools/call": {
      const name = String(params.name ?? "");
      if (!TOOLS.some((t) => t.name === name)) return rpcError(id, -32602, `Unknown tool: ${name}`);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      try {
        return rpcResult(id, await callTool(deps, name, args));
      } catch (e) {
        return rpcResult(id, fail(`Tool failed: ${(e as Error)?.message ?? e}`));
      }
    }
    default:
      if (isNotification) return null; // notifications/initialized, cancelled, …
      return rpcError(id, -32601, `Method not found: ${msg.method}`);
  }
}

/** Handle POST /mcp (the caller has already checked the bearer token). */
export async function handleMcpPost(deps: McpDeps, req: Request): Promise<Response> {
  let body: unknown;
  try { body = await req.json(); } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const replies = (await Promise.all((batch ? body as unknown[] : [body]).map((m) => dispatch(deps, m)))).filter(Boolean);
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0], { headers: { "cache-control": "no-store" } });
}
