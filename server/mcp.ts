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
import { isCodexInputReady } from "./codex-startup";
import { claudeStartupPrompt, type ClaudeStartupPrompt } from "./claude-startup";
import { sessionActivity } from "./session-activity";
import type { SessionProvider } from "./session-provider";
import { SecretRequestError, type SecretRequests } from "./secret-requests";
import type { RestartResult } from "./session-restart";
import { SECRETS_GUIDANCE } from "./communicator-mcp";
import { handoffUploadCommand, mungeCwd } from "./handoff";
import { COMPACT_FROM_TOKENS, LEAN_ABOVE_TOKENS, isHandoffMode, type RequestedHandoffMode } from "./handoff-modes";
import type { InstallJob } from "./agent-installs";
import type { Finding } from "./server-setup";
import { addProject, removeProject, type ProjectToolDeps } from "./project-tools";

export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const SERVER_INFO = { name: "coding-sessions", title: "Coding Sessions", version: "1.0.0" };

export const INSTRUCTIONS = `Coding Sessions runs Claude, Codex and Command Code agents in terminal sessions on one server; this connector drives them.
Typical loop: list_sessions (or launch_session with a prompt) → send_message → wait_for_session → read_session, repeating until the work is done.
Session ids look like "m:cs-name". A session's state is one of: starting, working, asking (blocked on a question — read_session, then press_keys or send_message to answer), waiting (finished its turn, ready for the next message), running (alive; this agent reports no turn state), ended.
Set up a fresh server: server_status first; it lists what is missing, each with the exact next call. Usually: setup_agents {agents: ["claude"]} (also installs the Chat/ACP adapter and completes Claude Code's onboarding), then setup_agents {wait_seconds: 60} until the job finishes; doctor {fix: true}; sign-in with agent_auth (the human opens the link) or a key with request_secret (the human enters the value); ask the human whether to trust app workspaces, and only on their yes trust_workspaces {enabled: true, confirm: true}; for Chat (acp) mode add_project {repo, name} (a clone under ~/workspaces) and launch_session {project_id, mode: "acp"}; server_status again until ready. Items with human: true are for the person (give them the link or the sudo command); never work around them.
When startup_waiting_for_trust is true, Codex is waiting for the operator to review folder trust before its managed startup hook can run. Report this decision to the operator; do not accept trust automatically: folder trust is answered for you only through the operator's trust_workspaces setting, and only for workspaces this app creates. The same holds for Claude Code's folder_trust startup_prompt.
The additive activity field matches the web UI: running, waiting (needs input), finished (turn complete; session still open), ready, connected (no reliable turn signal), starting, ended, or failed.
Sessions use the server-configured permission mode and may require trust or approval in their terminal; end_session stops one and archives it, resume_session reopens an archived conversation.
A session launched with mode "acp" (Chat mode) talks to its agent over the Agent Client Protocol: send_message sends a prompt; when it is asking, read_session lists the agent's permission request with its options, and send_message with one option's name (or id) answers it; press_keys does not apply.
${SECRETS_GUIDANCE}
A secret saved after a session started is already in that session's $CS_SECRETS_FILE; restart_session (end and resume the same conversation) is only for programs that read their environment once at start.
Handing your own local work to the server: push your branch first, then handoff_session {name, repo, branch, cwd}. It prepares a workspace at that branch and returns a one-time upload command; run it in your local shell (it uploads your Claude Code transcript from disk; never paste the transcript into a tool call). The server session resumes your conversation with its full history; then you can stop. A person at a terminal uses \`cs handoff\` instead, which also carries uncommitted changes.
Errors come back with isError and structuredContent.error {code, message, next}: code is one of invalid_argument, not_found, conflict, unavailable, failed; next says what to call instead.
Bounds: list_sessions returns at most limit sessions (default 50, filter with agent, state or query); read_session and wait_for_session return at most 400 screen lines.`;

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
  /** `asking: false` — the agent reports working/finished but cannot show that it waits on a question. */
  providers(): Array<{ id: SessionProvider; name: string; remoteControl: boolean; turnState: boolean; asking?: boolean }>;
  launch(opts: { name: string; provider: SessionProvider; projectId: number | null; repo: string | null; remoteControl: boolean; mode?: "terminal" | "acp" }):
    Promise<{ ok: true; id: string } | { ok: false; error: string }>;
  end(id: string, deleteWorkspace: boolean): Promise<{ ok: boolean; error?: string }>;
  resume(archiveId: number): Promise<{ ok: true } | { ok: false; error: string }>;
  readScreen(id: string, lines: number): Promise<IoResult<string>>;
  sendText(id: string, text: string, submit: boolean): Promise<IoResult<true>>;
  sendKeys(id: string, keys: string[]): Promise<IoResult<true>>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** Secret and connector requests; absent in tests and deployments that predate them. */
  secrets?: {
    requests: SecretRequests;
    /** A live managed session's identity, for binding a request or a status to it. */
    session(id: string): Promise<{ launchId: string | null; screen: string; sessionName: string; agent: string } | null>;
  };
  restart?(id: string): Promise<RestartResult>;
  /** Per session: PR links found in its transcript, and the secret/connector requests it waits on. */
  sessionExtras?(sessions: SessionInfo[]): Map<string, SessionExtras>;
  /** Server setup (server_status, setup_agents, doctor, trust_workspaces); absent in tests that predate it. */
  setup?: SetupDeps;
  /** add_project / remove_project (server/project-tools.ts); absent in tests that predate them. */
  projects?: ProjectToolDeps;
  /** Handoff of a local conversation (handoff_session); absent in deployments without it. */
  handoff?: {
    status(name: string): Promise<{ ok: true; status: { state: "live" | "resumable" | "none"; name: string; workspacePath: string } } | { ok: false; error: string }>;
    prepare(name: string, repo: string, branch: string | null): Promise<{ ok: true; workspacePath: string } | { ok: false; error: string }>;
    createUpload(ticket: { name: string; workspace: string; resumeId: string | null; prompt: string | null; autoMode: boolean; mode: RequestedHandoffMode }): { url: string; expiresAt: number };
  };
}

/** What server_status reads; each part is the app's own view, never a secret or a link. */
export interface SetupSnapshot {
  app: { version: string | null; channel: string; auto_updates: boolean | null };
  permissions: "standard" | "unrestricted";
  trust_workspaces: { enabled: boolean; changed_by?: string; changed_at?: string };
  agents: Array<{ id: string; label: string; installed: boolean; version: string | null; signed_in?: boolean | null; api_key?: boolean; acp_adapter?: boolean }>;
  claude_onboarding: boolean | null;
  browser: boolean;
  host: unknown;
}

export interface SetupDeps {
  snapshot(): Promise<SetupSnapshot>;
  install(agents: unknown): { ok: true; job: InstallJob } | { ok: false; error: string; status: number };
  job(): InstallJob | null;
  doctor(fix: boolean): Finding[];
  setTrust(enabled: boolean): { ok: true } | { ok: false; error: string };
}

export interface SessionExtras {
  prs: Array<{ url: string; repo?: string; number?: number; state?: string; title?: string | null }>;
  requests: Array<{ id: string; kind: string; name: string }>;
}

/* ---------- session state, as the tools describe it ---------- */

export type SessionState = "starting" | "working" | "asking" | "waiting" | "running" | "ended";

export function sessionState(s: SessionInfo | undefined, turnState: boolean): SessionState {
  if (!s || s.status === "ended") return "ended";
  if (s.provider === "codex" && s.phase === "awaiting_session_start" && s.startupWaitingForTrust) return "asking";
  if (s.provider === "codex" && s.phase === "awaiting_session_start" && s.startupInputReady) return "running";
  if (s.status === "starting") return "starting";
  // A Chat (ACP) session always reports its turn: the bridge sees every prompt, update and permission request.
  if (!(turnState || s.mode === "acp") || s.telemetryUnknown) return "running";
  if (s.asking) return "asking";
  if (s.busy) return "working";
  if (s.waiting) return "waiting";
  return "running";
}

function summarize(s: SessionInfo, turnState: boolean, extras?: SessionExtras) {
  return {
    id: s.id,
    session_id: s.id,
    name: s.name,
    agent: s.provider,
    mode: s.mode === "acp" ? "acp" : "terminal",
    state: sessionState(s, turnState),
    activity: sessionActivity(s),
    ...(s.startupWaitingForTrust ? { startup_waiting_for_trust: true } : {}),
    ...(s.startupInputReady ? { startup_input_ready: true } : {}),
    managed: s.kind === "managed",
    project: s.projectLabel ?? s.project,
    folder: s.project,
    workspace: s.workspace,
    model: s.model,
    uptime_sec: s.uptimeSec,
    claude_url: s.claudeUrl,
    error: s.errorMessage,
    ...(extras ? { prs: extras.prs, pending_requests: extras.requests } : {}),
  };
}

function extrasFor(deps: McpDeps, sessions: SessionInfo[]): Map<string, SessionExtras> {
  try { return deps.sessionExtras?.(sessions) ?? new Map(); } catch { return new Map(); }
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
    name: "server_status",
    title: "Server setup status",
    description: "One call for how ready this server is: app version and update channel, each agent (installed, version, signed in, Chat/ACP adapter ready), Claude Code onboarding, permission mode and the trust_workspaces setting, browser, disk and memory, doctor findings, Claude Code sessions blocked on a first-run screen, and missing: each thing still needed with the exact next MCP call (human: true where only a person can do it, such as a sign-in or a secret value). ready is true when nothing an agent can do is left. Never returns secrets or sign-in links.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "setup_agents",
    title: "Install or update agents",
    description: "Install or update agent CLIs on this server as its service account (never root): claude, codex, command-code, gemini, kimi, qwen, opencode. claude and codex also install their Chat (ACP) adapter under the app's own Bun (no global npm, no system Node.js); claude-acp or codex-acp installs just the adapter. A successful Claude Code install also completes its first-run onboarding. One install runs at a time and returns a job; call again without agents (wait_seconds up to 90) to follow it. Signs in to nothing: agent_auth does that.",
    inputSchema: { type: "object", properties: {
      agents: { type: "array", items: { type: "string", enum: ["claude", "codex", "command-code", "gemini", "kimi", "qwen", "opencode", "claude-acp", "codex-acp"] }, description: "Agents to install or update. Leave out to read the current job." },
      wait_seconds: { type: "integer", minimum: 0, maximum: 90, description: "Wait up to this long for the job to finish. Default 0." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: "doctor",
    title: "Check and repair the server",
    description: "Run the checks the service account can make on itself: file owners in its home, ~/.claude.json privacy, Claude Code onboarding, screen/ttyd/git, disk, memory, the Claude.ai browser. fix: true repairs what it can without root (completes Claude Code's first-run onboarding, makes ~/.claude.json private). A finding with human: true needs a person; its fix is the exact command, such as sudo coding-sessions doctor --fix, to run on the server.",
    inputSchema: { type: "object", properties: { fix: { type: "boolean", description: "Repair what the service account can. Default false." } } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "trust_workspaces",
    title: "Trust app workspaces (operator setting)",
    description: "Turn on or off the operator setting that answers Claude Code's folder-trust question with Yes for workspaces this app creates (from a repository, cs sync and handoff, under ~/workspaces), never any other folder. With it on, a handoff or repo session in standard permission mode starts without stopping at trust. This is the operator's security decision: ask the human first and pass confirm: true only after they say yes. Recorded and shown in Settings → Server settings, where it can be turned off. enabled: false needs no confirm.",
    inputSchema: { type: "object", properties: {
      enabled: { type: "boolean" },
      confirm: { type: "boolean", description: "true only after the human operator approved trusting app workspaces." },
    }, required: ["enabled"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
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
    description: "Live sessions with each one's id, agent, mode (terminal or acp), state, folder, PR links found in its conversation (prs, with GitHub state) and the secret/connector requests it waits on (pending_requests), plus the server's CPU, memory and free disk. Filter by agent, state or a name query; at most limit sessions (total says how many matched). include_ended adds archived (ended) sessions that resume_session can reopen.",
    inputSchema: { type: "object", properties: {
      include_ended: { type: "boolean", description: "Also list archived sessions. Default false." },
      agent: { type: "string", description: "Only this agent: claude, codex, command-code or cmd:<slug>." },
      state: { type: "string", enum: ["starting", "working", "asking", "waiting", "running", "ended"], description: "Only sessions in this state." },
      query: { type: "string", description: "Case-insensitive substring of the name or folder." },
      limit: { type: "integer", minimum: 1, maximum: 200, description: "Most sessions (and archived rows) to return. Default 50." },
    } },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "read_session",
    title: "Read a session's screen",
    description: "The bottom of a session's terminal as plain text, and its state, mode, PR links and pending secret/connector requests. For a Chat (acp) session the screen is the chat transcript, ending with the agent's permission request and its options while it is asking (answer with send_message). Use it to see what the agent did, said or is asking.",
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
    description: "Wait until the session's agent stops working — it finished its turn, asks a question, or ended — then return its state, screen and reason: turn_finished, asking (read_session, then answer), ended, screen_settled (no turn state; the screen stopped changing), or timeout (timed_out: true; call again to keep waiting). For an agent without turn state, or one working that cannot report a question, waits until its screen stops changing.",
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
    name: "add_project",
    title: "Add a project",
    description: "Register a project, which Chat (acp) mode needs, without the app. Only under the server's workspaces folder: repo clones \"owner/repo\" (or a GitHub URL, optional branch) into a new workspace named name with the app's own git and GitHub sign-in, exactly as a repo launch prepares one; path adds a folder that already exists under ~/workspaces (such as a repo or handoff workspace). Any other folder is refused: add it in the app's Projects. Runs the app's own project checks (a directory the server can write). Adding the same folder again returns the existing project. Returns the project with its id for launch_session.",
    inputSchema: { type: "object", properties: {
      repo: { type: "string", description: "owner/repo, owner/repo#branch or a GitHub URL to clone." },
      name: { type: "string", description: "With repo: the new workspace's name, 1-31 letters, numbers, dashes or underscores." },
      branch: { type: "string", description: "With repo: the branch to check out. Default: the repo's default branch." },
      path: { type: "string", description: "Instead of repo: an existing folder under ~/workspaces." },
      label: { type: "string", description: "Display name. Default: name, or the folder's name." },
    } },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "remove_project",
    title: "Remove a project",
    description: "Remove a project from the list (list_projects shows ids). The folder and its files stay, and running sessions keep running; only new launches into it stop being offered.",
    inputSchema: { type: "object", properties: { project_id: { type: "integer" } }, required: ["project_id"] },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
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
    description: "Start an agent in a new session: in a project (project_id from list_projects) or in a fresh workspace cloned from a repo (\"owner/repo\", \"owner/repo#branch\", or a GitHub URL). With prompt, sends it as the first message once the agent is ready: within this call when it starts quickly, otherwise prompt_queued is true and the server sends it the moment the agent is up (do not send it again). Returns the session id.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "1-31 chars: letters, numbers, dashes." },
        agent: { type: "string", description: "claude (default), codex, command-code, or a registered cmd:<slug>." },
        project_id: { type: "integer", description: "A project from list_projects." },
        repo: { type: "string", description: "Instead of project_id: a repo to clone into a fresh workspace." },
        remote_control: { type: "boolean", description: "Claude only: also open it in the Claude app's Remote Control. Default true." },
        mode: { type: "string", enum: ["terminal", "acp"], description: "terminal (default): the agent's own terminal UI, as today. acp: Chat mode — the agent speaks the Agent Client Protocol and the app shows a chat with permission prompts. Project launches only; for Claude Code, Codex, Command Code and the Gemini, Qwen, opencode and Kimi presets." },
        prompt: { type: "string", description: "First message for the agent." },
      },
      required: ["name"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "handoff_session",
    title: "Hand your local conversation to the server",
    description: "Continue your own local Claude Code conversation on the server, with its full history, without re-sending it as a prompt. Push your branch first: the server workspace is prepared from repo at branch (uncommitted local changes do not travel; commit and push them, or ask the person to run `cs handoff`). Returns a one-time upload command (15 minutes) to run in your local shell: it uploads your transcript file from disk in parts, then the server adopts it and launches the session resuming it, with prompt as the first new message. mode (default auto) decides how much history the server session reads: auto resumes a conversation under ~50k estimated tokens in full, compacts one of 50k-300k (/compact on the server, then resume), and goes lean above that (the server writes HANDOFF.md from the conversation and starts a fresh session pointed at it, with search_transcript for details). The command's output has the session_id, the mode and tokens_before/tokens_after (estimates); compact and lean take a minute or two, and the command waits for them. Never paste a transcript into a tool call. Claude Code only.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Session name, 1-31 chars: letters, numbers, dashes. Must not be in use." },
        repo: { type: "string", description: "owner/repo or a GitHub URL." },
        branch: { type: "string", description: "The pushed branch to continue on." },
        cwd: { type: "string", description: "Your local working directory (absolute). Locates your transcript under ~/.claude/projects/." },
        transcript_id: { type: "string", description: "Your conversation id (the transcript's file name without .jsonl). Default: the newest transcript for cwd." },
        prompt: { type: "string", description: "Optional first new message for the server session, e.g. what to do next." },
        agent: { type: "string", enum: ["claude"], description: "claude (the only one supported for now)." },
        mode: { type: "string", enum: ["auto", "full", "compact", "lean"], description: "auto (default): by estimated size. full: resume everything. compact: /compact a copy first, then resume. lean: HANDOFF.md plus a fresh session; the full transcript stays searchable with search_transcript." },
      },
      required: ["name", "repo", "branch", "cwd"],
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  },
  {
    name: "resume_session",
    title: "Resume an ended session",
    description: "Reopen an archived conversation (archive_id from list_sessions with include_ended) in a new session, in its original folder.",
    inputSchema: { type: "object", properties: { archive_id: { type: "integer" } }, required: ["archive_id"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "list_secrets",
    title: "List secrets",
    description: "Names of the secrets (API keys, tokens) stored in Coding Sessions, with their source and when they changed. Never returns values. Every session receives them as environment variables at launch and in its $CS_SECRETS_FILE, which the app rewrites whenever they change. Check here before asking anyone for a key.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "secret_status",
    title: "Secret status",
    description: "Whether a secret exists, where it comes from and when it changed, and the latest request for it. With session_id, also whether that session's environment has the current value and its secrets file path. Never returns the value.",
    inputSchema: { type: "object", properties: { name: { type: "string", description: "Environment variable name." }, session_id: { ...sessionId, description: "Optional: a live session to check against." } }, required: ["name"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "request_secret",
    title: "Ask the member for a secret",
    description: "Create a one-time link (15 minutes) where the member pastes a secret into Coding Sessions; it is stored as a Secret for every session. Never ask for secret values in chat and never pass them to any tool. Give the member the returned url, then poll secret_status. session_id (optional) names the session the value is for; the page shows the request came through this operator connection.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Environment variable name, e.g. KAZTRACK_API_TOKEN." },
      reason: { type: "string", description: "One or two plain sentences the member will read." },
      session_id: { ...sessionId, description: "Optional: the session that needs it." },
    }, required: ["name", "reason"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  {
    name: "request_connector",
    title: "Ask the member to connect an MCP server",
    description: "Create a one-time link (15 minutes) where the member connects a remote MCP server: they paste its token, or sign in with OAuth in their own browser (callback on this app's HTTPS address, not localhost). The credential stays in Coding Sessions; agents reach the tools through the connectors gateway. Poll connector_status.",
    inputSchema: { type: "object", properties: {
      name: { type: "string", description: "Connector name, e.g. KazTrack." },
      url: { type: "string", description: "The server's https:// MCP URL." },
      reason: { type: "string", description: "One or two plain sentences the member will read." },
      auth: { type: "string", enum: ["bearer", "oauth"], description: "Default bearer." },
      session_id: { ...sessionId, description: "Optional: the session that needs it; its agent type is granted the connector." },
    }, required: ["name", "url", "reason"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "connector_status",
    title: "Connector status",
    description: "Whether a connector exists, its state, auth mode and granted tool count, and the latest request for it. With session_id, whether that session can use it now. Never returns credentials.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, session_id: { ...sessionId, description: "Optional." } }, required: ["name"] },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "restart_session",
    title: "Restart a session with new secrets",
    description: "End a session and resume the same conversation, so it starts again with the current secrets and connectors. Everything running in it stops and the agent restarts; the conversation continues. Refused, with nothing ended, when the session could not come back (registered commands, missing folder, no saved conversation). Most agents do not need this: $CS_SECRETS_FILE already has new values.",
    inputSchema: { type: "object", properties: { session_id: sessionId }, required: ["session_id"] },
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
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
export type ErrorCode = "invalid_argument" | "not_found" | "conflict" | "unavailable" | "failed";

/** A tool error: plain text for every client, and {error: {code, message, next}} for agents. */
const fail = (message: string, code: ErrorCode = "failed", next?: string): ToolResult => ({
  content: [{ type: "text", text: next ? `${message}\nNext: ${next}` : message }],
  structuredContent: { error: { code, message, ...(next ? { next } : {}) } },
  isError: true,
});

const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/;
const NAME_HINT = "Use 1-31 letters, numbers, dashes or underscores, starting with a letter or number.";
const notFound = (id: string) => fail(id ? `No live session ${id}.` : "session_id is required.", id ? "not_found" : "invalid_argument",
  "list_sessions shows the live ones (include_ended for archived ones, which resume_session reopens).");

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
 * identical screens in a row do — and so they do for a "working" agent that cannot
 * report a question, so an approval prompt does not hold the caller until timeout.
 */
/** A Claude Code terminal session blocked on a first-run screen (theme, security notes, folder trust). */
function startupPromptOf(s: SessionInfo | undefined, screen: string): ClaudeStartupPrompt | null {
  if (!s || s.status === "ended" || s.provider !== "claude" || s.mode === "acp" || !screen) return null;
  return claudeStartupPrompt(screen);
}

export async function waitForSession(deps: McpDeps, id: string, timeoutSec: number, lines: number) {
  const started = deps.now();
  const deadline = started + timeoutSec * 1000;
  const SETTLE_MS = 4000;
  let last = "";
  let same = 0;
  for (;;) {
    const s = await findSession(deps, id);
    const entry = s ? deps.providers().find((p) => p.id === s.provider) : undefined;
    const turnState = entry?.turnState ?? false;
    // A "working" state can hide a question or approval prompt the agent never reports.
    const hidden = turnState && entry?.asking === false;
    const reported = sessionState(s, turnState);
    const screen = reported === "ended" ? null : await deps.readScreen(id, lines);
    const text = screen?.ok ? screen.value : "";
    // Claude Code's first-run screens are in no transcript: the turn state misses them.
    const startup = startupPromptOf(s, text);
    const state: SessionState = startup ? "asking" : reported;
    same = text && text === last ? same + 1 : 0;
    last = text;
    const settled = deps.now() - started >= SETTLE_MS;
    const done = state === "ended" || !!startup
      || (settled && (state === "waiting" || state === "asking"))
      || ((state === "running" || (hidden && state === "working")) && same >= 2);
    const timedOut = deps.now() >= deadline;
    if (done || timedOut) {
      const reason = !done ? "timeout"
        : state === "ended" ? "ended"
        : state === "asking" ? "asking"
        : state === "waiting" ? "turn_finished"
        : "screen_settled";
      return {
        session_id: id, state, reason, timed_out: !done, waited_sec: Math.round((deps.now() - started) / 1000),
        ...(startup ? { startup_prompt: startup } : {}), screen: screen?.ok ? screen.value : null,
      };
    }
    await deps.sleep(2000);
  }
}

/** How long a launch prompt is kept for an agent still starting (matches the app's starting grace). */
const QUEUED_PROMPT_MS = 15 * 60_000;
const queuedPrompts = new Set<Promise<void>>();

/** Resolves once every queued launch prompt has been delivered or given up. For tests. */
export async function settleQueuedPrompts(): Promise<void> {
  while (queuedPrompts.size) await Promise.all([...queuedPrompts]);
}

/**
 * A fresh workspace can take longer to prepare than one MCP call may wait, so the
 * prompt is kept and typed the moment the agent is ready — never into a trust
 * prompt, a failed launch or an ended session.
 */
function queuePrompt(deps: McpDeps, id: string, prompt: string): void {
  const delivery = (async () => {
    try { if (await waitUntilReady(deps, id, QUEUED_PROMPT_MS)) await deps.sendText(id, prompt, true); } catch {}
  })();
  queuedPrompts.add(delivery);
  void delivery.finally(() => queuedPrompts.delete(delivery));
}

/** After a Launch: wait for the session to exist and its screen to settle, then type. */
async function waitUntilReady(deps: McpDeps, id: string, timeoutMs = 60_000): Promise<boolean> {
  const deadline = deps.now() + timeoutMs;
  let last = "";
  let same = 0;
  while (deps.now() < deadline) {
    const s = await findSession(deps, id);
    if (s?.status === "ended" || s?.phase === "failed") return false;
    // A Chat (ACP) session is ready once its bridge has a session; there is no screen to settle.
    if (s?.mode === "acp") {
      if (s.status === "running") return true;
      await deps.sleep(1000);
      continue;
    }
    const preHookCodex = s?.provider === "codex" && s.phase !== "ready";
    if (s?.status === "running" && s.phase !== "failed" && !s.startupWaitingForTrust
      && (!preHookCodex || (s.phase === "awaiting_session_start" && s.startupInputReady))) {
      const screen = await deps.readScreen(id, 40);
      // Never type into Claude Code's first-run screens: Enter on the trust question exits.
      const text = screen.ok && (!preHookCodex || isCodexInputReady(screen.value)) && !startupPromptOf(s, screen.value) ? screen.value.trim() : "";
      same = text && text === last ? same + 1 : 0;
      last = text;
      if (same >= 2) return true;
    } else {
      same = 0;
      last = "";
    }
    await deps.sleep(1500);
  }
  return false;
}

/**
 * The operator surface for requests. The operator may name any live session; the request is
 * still labelled as coming through this connection, and creating one grants nothing: only
 * the member, signed in to the app, can fulfil it.
 */
async function secretTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!deps.secrets) return fail("Secret requests are unavailable on this server.", "unavailable");
  const { requests } = deps.secrets;
  let session: Awaited<ReturnType<NonNullable<McpDeps["secrets"]>["session"]>> = null;
  if (args.session_id !== undefined && args.session_id !== null && args.session_id !== "") {
    session = await deps.secrets.session(str(args.session_id));
    if (!session) return fail(`No live managed session ${str(args.session_id)}. list_sessions shows the live ones.`, "not_found", "list_sessions, or leave session_id out.");
  }
  const caller = session ? { launchId: session.launchId, screen: session.screen } : null;
  try {
    switch (name) {
      case "list_secrets": return ok(await requests.listSecrets(null));
      case "secret_status": return ok(await requests.secretStatus(args.name, caller));
      case "connector_status": return ok(requests.connectorStatus(args.name, caller));
      case "request_secret":
      case "request_connector": {
        const created = await requests.create({
          kind: name === "request_connector" ? "connector" : "secret",
          name: args.name, reason: args.reason, url: args.url, auth: args.auth,
        }, { by: "operator", launchId: session?.launchId ?? null, screen: session?.screen ?? null, sessionName: session?.sessionName ?? null, agent: session?.agent ?? null });
        return ok({ ...created, next: "Give the member this link. Do not ask for the value in chat. Then poll " + (name === "request_connector" ? "connector_status." : "secret_status.") });
      }
    }
  } catch (error) {
    if (error instanceof SecretRequestError) {
      const code: ErrorCode = error.status === 404 ? "not_found" : error.status === 409 ? "conflict" : error.status === 400 || error.status === 422 ? "invalid_argument" : "failed";
      return fail(error.message, code);
    }
    throw error;
  }
  return fail(`Unknown tool ${name}.`);
}

/* ---------- server setup ---------- */

interface Missing { item: string; why: string; next: string; human?: boolean; ask_operator?: boolean; optional?: boolean }

/** Claude Code terminal sessions blocked on a first-run screen right now. */
async function pendingStartupScreens(deps: McpDeps) {
  const out: Array<{ session_id: string; name: string; kind: string; how: string }> = [];
  for (const s of await deps.listSessions()) {
    if (s.status === "ended" || s.provider !== "claude" || s.mode === "acp") continue;
    const screen = await deps.readScreen(s.id, 40).catch(() => null);
    const startup = screen?.ok ? startupPromptOf(s, screen.value) : null;
    if (startup) out.push({ session_id: s.id, name: s.name, kind: startup.kind, how: startup.how });
  }
  return out;
}

export async function serverStatus(deps: McpDeps, setup: SetupDeps) {
  const snap = await setup.snapshot();
  const findings = setup.doctor(false);
  const screens = await pendingStartupScreens(deps);
  const job = setup.job();
  const missing: Missing[] = [];
  const agent = (id: string) => snap.agents.find((a) => a.id === id);
  const claude = agent("claude");
  const codex = agent("codex");
  const installing = !!job?.running;

  if (!snap.agents.some((a) => a.installed)) {
    missing.push({ item: "an agent", why: "No agent CLI is installed.", next: installing ? "setup_agents {wait_seconds: 60}" : 'setup_agents {agents: ["claude"]}' });
  }
  for (const a of [claude, codex]) {
    if (!a?.installed) continue;
    const name = a.id === "claude" ? "Claude Code" : "Codex";
    if (a.acp_adapter === false) missing.push({ item: `${name} Chat (ACP) adapter`, why: `Chat mode for ${name} needs its ACP adapter.`, next: installing ? "setup_agents {wait_seconds: 60}" : `setup_agents {agents: ["${a.id}-acp"]}` });
    if (a.signed_in === false && !a.api_key) missing.push({ item: `${name} sign-in`, why: `${name} is installed but not signed in.`, human: true,
      next: `agent_auth {agent: "${a.id}", action: "login"} returns a sign-in link for the human to open${a.id === "claude" ? " (then submit_code with the code they get)" : ""}; or, for an API key, request_secret {name: "${a.id === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}", reason} and give the human the link.` });
  }
  if (claude?.installed && snap.claude_onboarding === false) {
    missing.push({ item: "Claude Code onboarding", why: "Every first terminal session stops at the theme picker and security notes.", next: "doctor {fix: true}" });
  }
  if (claude?.installed && snap.permissions === "standard" && !snap.trust_workspaces.enabled) {
    missing.push({ item: "workspace trust", ask_operator: true, why: "In standard permission mode every new repo or handoff workspace stops at Claude Code's folder-trust question (default: No, exit).",
      next: "Ask the human whether to trust workspaces this app creates; only if they say yes: trust_workspaces {enabled: true, confirm: true}. Otherwise they answer trust per session." });
  }
  if (!deps.listProjects().length && snap.agents.some((a) => a.installed && a.acp_adapter)) {
    missing.push({ item: "a project for Chat mode", optional: true, why: "Chat (acp) sessions launch only into a project; none is registered.",
      next: 'add_project {repo: "owner/repo", name: "app"} (or path of an existing ~/workspaces folder), then launch_session {project_id, mode: "acp"}' });
  }
  for (const f of findings) {
    if (f.status === "ok" || f.check === "Claude Code onboarding") continue;
    missing.push({ item: f.check, why: f.detail, next: f.fix ?? "doctor", ...(f.human ? { human: true } : {}) });
  }
  for (const s of screens) missing.push({ item: `session ${s.name}: ${s.kind}`, why: "This Claude Code session is waiting on a first-run screen.", next: `read_session {session_id: "${s.session_id}"}; ${s.how}`, ...(s.kind === "folder_trust" ? { ask_operator: true } : {}) });

  const agentWork = missing.filter((m) => !m.human && !m.ask_operator && !m.optional);
  return {
    ready: agentWork.length === 0 && !installing,
    app: snap.app,
    permissions: snap.permissions,
    trust_workspaces: snap.trust_workspaces,
    agents: snap.agents,
    claude_onboarding: snap.claude_onboarding,
    browser: snap.browser,
    host: snap.host,
    install_job: job ? { agents: job.agents, result: job.result, started_at: job.startedAt, finished_at: job.finishedAt } : null,
    doctor: findings,
    startup_screens: screens,
    missing,
    next: agentWork[0]?.next ?? missing[0]?.next ?? "Ready: launch_session or handoff_session.",
  };
}

async function setupTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const setup = deps.setup;
  if (!setup) return fail("Server setup tools are unavailable on this server.", "unavailable");
  switch (name) {
    case "server_status":
      return ok(await serverStatus(deps, setup));
    case "setup_agents": {
      let started: InstallJob | null = null;
      if (args.agents !== undefined && args.agents !== null) {
        const r = setup.install(args.agents);
        if (!r.ok) return fail(r.error, r.status === 409 ? "conflict" : "invalid_argument", r.status === 409 ? "setup_agents {wait_seconds: 60} follows the running job." : undefined);
        started = r.job;
      }
      const wait = int(args.wait_seconds, 0, 0, 90);
      const deadline = deps.now() + wait * 1000;
      let job = setup.job() ?? started;
      while (job?.running && deps.now() < deadline) { await deps.sleep(2000); job = setup.job(); }
      if (!job) return ok({ job: null, next: 'setup_agents {agents: ["claude"]}' });
      return ok({ job, next: job.running ? "setup_agents {wait_seconds: 60}" : job.result === "success" ? "server_status" : "Read job.output; fix the cause (doctor) and run setup_agents again." });
    }
    case "doctor": {
      const findings = setup.doctor(args.fix === true);
      const human = findings.filter((f) => f.human && f.status !== "ok");
      return ok({ findings, ok: findings.every((f) => f.status === "ok"),
        ...(human.length ? { for_the_human: [...new Set(human.map((f) => f.fix).filter(Boolean))], note: "These need a person on the server (root, or a decision); give them the commands. The agent cannot run them." } : {}),
        next: findings.some((f) => f.status !== "ok" && !f.human && f.fix?.startsWith("doctor")) ? "doctor {fix: true}" : "server_status" });
    }
    case "trust_workspaces": {
      if (typeof args.enabled !== "boolean") return fail("enabled must be true or false.", "invalid_argument");
      if (args.enabled && args.confirm !== true) {
        return fail("Trusting app workspaces is the operator's decision.", "invalid_argument",
          "Ask the human whether Claude Code may trust the workspaces this app creates (repo, sync and handoff workspaces under ~/workspaces); only after they say yes, call trust_workspaces {enabled: true, confirm: true}.");
      }
      const r = setup.setTrust(args.enabled);
      if (!r.ok) return fail(r.error);
      return ok({ trust_workspaces: args.enabled, applies_to: "workspaces this app creates under ~/workspaces (repo, cs sync, handoff), for sessions started from now on",
        shown_in: "Settings → Server settings → Trust app workspaces", next: "server_status" });
    }
  }
  return fail(`Unknown tool ${name}.`);
}

export async function callTool(deps: McpDeps, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "server_status":
    case "setup_agents":
    case "doctor":
    case "trust_workspaces":
      return setupTool(deps, name, args);
    case "agent_accounts":
      return deps.accounts ? ok(await deps.accounts.list()) : fail("Agent account controls are unavailable.", "unavailable");
    case "agent_auth": {
      if (!deps.accounts) return fail("Agent account controls are unavailable.", "unavailable");
      const result = await deps.accounts.action(args.agent, args.action, args.code);
      return result.ok ? ok(result) : fail(typeof result.error === "string" ? result.error : "Account operation failed.");
    }
    case "list_sessions": {
      const agent = str(args.agent).trim();
      const wanted = str(args.state).trim();
      const q = str(args.query).trim().toLowerCase();
      const limit = int(args.limit, 50, 1, 200);
      const all = await deps.listSessions();
      const matched = all
        .map((s) => ({ s, state: sessionState(s, turnStateFor(deps, s.provider)) }))
        .filter(({ s, state }) => (!agent || s.provider === agent) && (!wanted || state === wanted)
          && (!q || s.name.toLowerCase().includes(q) || (s.project ?? "").toLowerCase().includes(q) || (s.projectLabel ?? "").toLowerCase().includes(q)));
      const page = matched.slice(0, limit).map(({ s }) => s);
      const extras = extrasFor(deps, page);
      const sessions = page.map((s) => summarize(s, turnStateFor(deps, s.provider), extras.get(s.id) ?? { prs: [], requests: [] }));
      const data: Record<string, unknown> = { sessions, total: matched.length, truncated: matched.length > page.length, host: deps.hostStats() };
      if (args.include_ended === true) {
        const ended = deps.listArchive()
          .filter((a) => (!agent || a.provider === agent) && (!q || a.name.toLowerCase().includes(q) || (a.project ?? "").toLowerCase().includes(q)));
        data.ended = ended.slice(0, limit).map(summarizeArchived);
        data.ended_total = ended.length;
      }
      return ok(data);
    }

    case "read_session": {
      const id = str(args.session_id);
      const s = await findSession(deps, id);
      if (!s) return notFound(id);
      const screen = await deps.readScreen(id, int(args.lines, 80, 5, 400));
      if (!screen.ok) return fail(screen.error);
      const startup = startupPromptOf(s, screen.value);
      const state: SessionState = startup ? "asking" : sessionState(s, turnStateFor(deps, s.provider));
      const extras = extrasFor(deps, [s]).get(s.id) ?? { prs: [], requests: [] };
      const acp = s.mode === "acp";
      const next = startup ? startup.how
        : state === "asking"
        ? (acp ? "send_message with one of the permission options above (its name or id)." : "press_keys for a menu, or send_message to answer.")
        : state === "waiting" ? "send_message with the next instruction." : state === "ended" ? "resume_session (list_sessions include_ended)." : "wait_for_session";
      return ok({
        session_id: id, name: s.name, agent: s.provider, mode: acp ? "acp" : "terminal", state,
        ...(startup ? { startup_prompt: startup } : {}), screen: screen.value,
        prs: extras.prs, pending_requests: extras.requests,
        ...(extras.requests.length ? { note: "The session waits on the member for a secret or connector; poll secret_status / connector_status." } : {}),
        next,
      });
    }

    case "send_message": {
      const id = str(args.session_id);
      const text = str(args.text);
      if (!id) return notFound(id);
      if (!text.trim() && args.submit === false) return fail("Nothing to send.", "invalid_argument", "Pass text, or submit: true to press Enter.");
      const r = await deps.sendText(id, text, args.submit !== false);
      if (r.ok) return ok({ session_id: id, sent: true, next: "wait_for_session" });
      return (await findSession(deps, id)) ? fail(r.error) : notFound(id);
    }

    case "press_keys": {
      const id = str(args.session_id);
      const keys = Array.isArray(args.keys) ? args.keys.map(String).slice(0, 20) : [];
      if (!id) return notFound(id);
      if (!keys.length) return fail("keys is empty.", "invalid_argument", "Pass keys such as [\"enter\"] or [\"1\"].");
      const r = await deps.sendKeys(id, keys);
      if (r.ok) return ok({ session_id: id, pressed: keys, next: "wait_for_session" });
      return (await findSession(deps, id)) ? fail(r.error) : notFound(id);
    }

    case "wait_for_session": {
      const id = str(args.session_id);
      if (!id) return notFound(id);
      const result = await waitForSession(deps, id, int(args.timeout_seconds, 50, 5, 90), int(args.lines, 60, 5, 400));
      const next = result.reason === "timeout" ? "wait_for_session again"
        : result.reason === "asking" ? "read_session, then answer with press_keys or send_message"
        : result.reason === "ended" ? "resume_session (list_sessions include_ended) if the work is not done"
        : "read_session or send_message";
      return ok({ ...result, next });
    }

    case "list_projects":
      return ok({ projects: deps.listProjects(), agents: deps.providers() });

    case "add_project": {
      if (!deps.projects) return fail("Adding projects over MCP is unavailable on this server.", "unavailable");
      const r = await addProject(deps.projects, args);
      if (!r.ok) return fail(r.error, r.code, r.code === "invalid_argument" ? "Give repo with name, or path under ~/workspaces." : undefined);
      return ok({ ...r, next: `launch_session {name, project_id: ${r.project.id}, mode: "acp"} for Chat mode, or mode "terminal".` });
    }

    case "remove_project": {
      if (!deps.projects) return fail("Removing projects over MCP is unavailable on this server.", "unavailable");
      const r = removeProject(deps.projects, args.project_id);
      return "removed" in r ? ok({ removed: r.removed, note: "The folder was not deleted." }) : r.ok ? ok(r) : fail(r.error, r.code, "list_projects");
    }

    case "list_repos": {
      const q = str(args.query).toLowerCase();
      const repos = (await deps.listRepos()).filter((r) => !q || r.toLowerCase().includes(q));
      return ok({ repos: repos.slice(0, 200), total: repos.length });
    }

    case "launch_session": {
      const provider = (str(args.agent) || "claude") as SessionProvider;
      if (!deps.providers().some((p) => p.id === provider)) {
        return fail(`Unknown agent “${provider}”.`, "invalid_argument", "list_projects shows the agents this server runs.");
      }
      const name = str(args.name).trim();
      if (!NAME_RE.test(name)) return fail(`Bad name “${name}”. ${NAME_HINT}`, "invalid_argument");
      const repo = str(args.repo).trim() || null;
      const projectId = args.project_id == null || args.project_id === "" ? null : Number(args.project_id);
      if (repo && projectId !== null) return fail("Give project_id or repo, not both.", "invalid_argument");
      if (!repo && !Number.isInteger(projectId)) return fail("Give project_id (from list_projects) or repo.", "invalid_argument", "list_projects or list_repos");
      if (!repo && !deps.listProjects().some((p) => p.id === projectId)) {
        return fail(`No project with id ${projectId}.`, "not_found", "list_projects shows the allowlisted projects.");
      }
      const mode = args.mode === undefined || args.mode === null || args.mode === "" ? "terminal" : args.mode;
      if (mode !== "terminal" && mode !== "acp") return fail('mode must be "terminal" or "acp".', "invalid_argument");
      if (mode === "acp" && repo) return fail("Chat (acp) mode works for project launches only.", "invalid_argument", "Use project_id, or mode terminal with repo.");
      const r = await deps.launch({ name, provider, projectId: repo ? null : projectId, repo, remoteControl: args.remote_control !== false, mode });
      if (!r.ok) return /already running|already owns/i.test(r.error)
        ? fail(r.error, "conflict", "Pick another name, or send_message to the running session (list_sessions).")
        : fail(r.error);
      const prompt = str(args.prompt);
      if (!prompt.trim()) return ok({ session_id: r.id, launched: true, next: "send_message" });
      if (!(await waitUntilReady(deps, r.id))) {
        const s = await findSession(deps, r.id);
        if (s?.status === "ended" || s?.phase === "failed") {
          return ok({ session_id: r.id, launched: true, prompt_sent: false, note: "The session ended or failed before the agent was ready; read_session for details." });
        }
        queuePrompt(deps, r.id, prompt);
        return ok({ session_id: r.id, launched: true, prompt_sent: false, prompt_queued: true,
          note: "The agent is still starting. The prompt will be sent as soon as it is ready; don't send it again. Use wait_for_session to follow along." });
      }
      const sent = await deps.sendText(r.id, prompt, true);
      return sent.ok
        ? ok({ session_id: r.id, launched: true, prompt_sent: true, next: "wait_for_session" })
        : ok({ session_id: r.id, launched: true, prompt_sent: false, note: sent.error });
    }

    case "handoff_session":
      return handoffTool(deps, args);

    case "resume_session": {
      const id = Number(args.archive_id);
      if (!Number.isInteger(id)) return fail("archive_id must be an integer.", "invalid_argument", "list_sessions with include_ended shows archive_id values.");
      const r = await deps.resume(id);
      if (!r.ok) return /no archived/i.test(r.error) ? fail(r.error, "not_found", "list_sessions with include_ended.") : fail(r.error);
      return ok({ resumed: true, next: "list_sessions" });
    }

    case "list_secrets":
    case "secret_status":
    case "request_secret":
    case "request_connector":
    case "connector_status":
      return secretTool(deps, name, args);

    case "restart_session": {
      if (!deps.restart) return fail("Restart is unavailable on this server.", "unavailable");
      const id = str(args.session_id);
      const r = await deps.restart(id);
      return r.ok ? ok({ ...r, restarted: true, next: "wait_for_session" }) : fail(r.error);
    }

    case "end_session": {
      const id = str(args.session_id);
      const r = await deps.end(id, args.delete_workspace === true);
      return r.ok ? ok({ session_id: id, ended: true }) : fail(r.error ?? "Couldn't end the session.");
    }
  }
  return fail(`Unknown tool ${name}.`, "invalid_argument", "tools/list shows the tools.");
}

/**
 * handoff_session: prepare a Workspace from a pushed branch and hand back a one-time,
 * chunked upload command. The transcript travels from the agent's disk to the server
 * by that command, never through this tool call (no transcript text in the model's
 * context or in MCP logs); the upload's last request adopts it and launches the resume.
 */
async function handoffTool(deps: McpDeps, args: Record<string, unknown>): Promise<ToolResult> {
  if (!deps.handoff) return fail("Handoff is unavailable on this server.", "unavailable");
  const agent = str(args.agent) || "claude";
  if (agent !== "claude") return fail("Only Claude Code conversations can be handed off for now.", "invalid_argument", "Use launch_session with a prompt for other agents.");
  const name = str(args.name).trim();
  if (!NAME_RE.test(name)) return fail(`Bad name “${name}”. ${NAME_HINT}`, "invalid_argument");
  const repo = str(args.repo).trim();
  if (!repo) return fail("repo is required (owner/repo).", "invalid_argument", "list_repos");
  const branch = str(args.branch).trim();
  if (!branch) return fail("branch is required: the pushed branch to continue on.", "invalid_argument", "git push -u origin HEAD, then pass its name.");
  const cwd = str(args.cwd).trim();
  if (!cwd.startsWith("/")) return fail("cwd must be your absolute local working directory.", "invalid_argument");
  const transcriptId = str(args.transcript_id).trim() || null;
  if (transcriptId && !/^[a-zA-Z0-9_-]{1,128}$/.test(transcriptId)) return fail("transcript_id must be the transcript's file name without .jsonl.", "invalid_argument");

  const mode = args.mode === undefined || args.mode === "" ? "auto" : args.mode;
  if (!isHandoffMode(mode)) return fail("mode must be auto, full, compact or lean.", "invalid_argument");

  const st = await deps.handoff.status(name);
  if (!st.ok) return fail(st.error, "invalid_argument");
  if (st.status.state !== "none") {
    return fail(`“${name}” already has a ${st.status.state === "live" ? "running session" : "server workspace"}.`, "conflict", "Pick another name.");
  }
  const prep = await deps.handoff.prepare(name, repo, branch);
  if (!prep.ok) return fail(prep.error);
  const prompt = str(args.prompt).trim() || null;
  const { url, expiresAt } = deps.handoff.createUpload({ name, workspace: prep.workspacePath, resumeId: transcriptId, prompt, autoMode: false, mode });
  const dir = `~/.claude/projects/${mungeCwd(cwd)}`;
  const transcriptPath = transcriptId ? `${dir}/${transcriptId}.jsonl` : null;
  const command = handoffUploadCommand(url, cwd, transcriptId);
  return ok({
    name, workspace: prep.workspacePath, branch,
    transcript: transcriptPath ?? `newest .jsonl in ${dir}`,
    command, expires_at: new Date(expiresAt).toISOString(), mode,
    modes: `auto picks by the transcript's estimated size (chars/4 of its messages): under ${COMPACT_FROM_TOKENS / 1000}k full, up to ${LEAN_ABOVE_TOKENS / 1000}k compact, above that lean. The server measures it after the upload; the command's last JSON line has mode, tokens_before and tokens_after.`,
    next: "Run command in your local shell (it prints JSON with session_id, mode and token estimates when the server session has started; for compact or lean it waits until it has). Then stop working locally; follow the server session with wait_for_session and read_session.",
  });
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
