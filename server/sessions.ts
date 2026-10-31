import { config } from "./config";
import { Communicator } from "./communicator";
import { communicator } from "./communicator-runtime";
import { communicatorEnvironment, providerCommunicatorArgs } from "./communicator-config";
import { CODEX_READINESS_TIMEOUT_ERROR, createStartupProbe, type CodexStartupObservation } from "./codex-startup";
import { childEnvironment } from "./child-env";
import { DB_PATH, db, getMeta } from "./db";
import { queueChatDeletion } from "./claude-chat";
import { readlinkSync, readdirSync, statSync, openSync, readSync, closeSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { lastTurnState, type TurnState } from "./turn-state";
import { DEFAULT_SESSION_PROVIDER, capabilitiesFor, commandSlug, isCommandProvider, parseSessionProvider, type SessionProvider } from "./session-provider";
import { commandEnv, findCommand, resolveBin, type CustomCommand } from "./commands";
import { buildCodexInvocation, preflightCodex, type CodexInvocation } from "./codex";
import { codexActivity, isCodexSessionId } from "./codex-state";
import {
  buildCommandCodeInvocation,
  commandCodeEnv,
  commandCodeModel,
  findCommandCodeSessionId,
  findCommandCodeTranscript,
  isCommandCodeProc,
  normalizeCommandCodeSessionId,
  preflightCommandCode,
} from "./command-code";
import type { Database } from "bun:sqlite";
import * as mux from "./mux";
import { sessionActivity, type SessionActivity } from "./session-activity";

const SCREEN_PREFIX = "cs-";
const NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/;
export const PREFIX_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,11}$/;
const FULL_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,42}$/;
const WORKSPACES_DIR = join(homedir(), "workspaces");
const IS_DARWIN = process.platform === "darwin"; // local dev on a Mac; the server is Linux
const ACTIVE_CPU_PCT = 5; // Process CPU indicator only; turn state comes from agent evidence.
const STARTING_GRACE_MS = 15 * 60_000; // screen alive but claude not yet up → "starting"
const SCREEN_DISCOVERY_GRACE_MS = 30_000;
const startupProbe = createStartupProbe();
const CODEX_EARLY_EXIT_ERROR = "Codex exited before its managed SessionStart hook reported readiness.";

export interface SessionInfo {
  id: string;            // "m:<screen>" | "e:<pid>"
  kind: "managed" | "external";
  provider: SessionProvider;
  launchId: string | null;
  phase: string | null;
  errorMessage: string | null;
  name: string;
  status: "running" | "starting" | "ended";
  workspace: boolean;
  project: string | null;
  projectLabel: string | null;
  pid: number | null;
  uptimeSec: number | null;
  cpu: number | null;
  active: boolean;         // high instantaneous CPU right now (lifetime-avg, so rarely true for old sessions) — info only, not the "working" source
  busy: boolean;           // Claude is mid-turn (working) per the transcript → "Working now", regardless of CPU
  waiting: boolean;        // Claude finished its turn / asked a question → needs you
  asking: boolean;         // Claude asked a question and is blocked on your reply (a stronger "waiting")
  telemetryUnknown: boolean; // Activity evidence is stale or absent while the process is live
  activity?: SessionActivity;
  startupInputReady?: boolean; // Live input evidence; SessionStart still owns conversation readiness.
  startupWaitingForTrust?: boolean; // A live pre-hook Codex TUI needs a folder-trust decision.
  turnComplete?: boolean; // Codex Stop, distinct from its initial SessionStart readiness
  claudeUrl: string | null;
  remoteControl: boolean;  // launched with --remote-control → drivable from the Claude app
  resumeId: string | null; // local id for `claude --resume <id>` in a terminal
  model: string | null;    // friendly model name from the transcript (e.g. "Opus 4.8")
  initial: string;         // avatar letter, with the name prefix stripped
}

/* ---------- claude.ai session link discovery ---------- */

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
const urlCache = new Map<number, string>(); // pid → claude.ai/code/session_… url
const transcriptCache = new Map<number, string>(); // pid → transcript file path
const modelCache = new Map<number, { at: number; model: string | null }>(); // pid → friendly model

/**
 * Locate a remote-control session's transcript
 * (~/.claude/projects/<munged-cwd>/<uuid>.jsonl) by "file created shortly after
 * the process started". Cached per pid — the transcript file doesn't move.
 */
function findTranscript(pid: number, cwd: string | null, etimes: number): string | null {
  const cached = transcriptCache.get(pid);
  if (cached) return cached;
  if (!cwd) return null;
  const dir = join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  const startMs = Date.now() - etimes * 1000;
  let best: { path: string; delta: number } | null = null;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return null; }
  for (const f of entries) {
    if (!f.endsWith(".jsonl")) continue;
    const full = join(dir, f);
    let st;
    try { st = statSync(full); } catch { continue; }
    const birth = st.birthtimeMs || st.ctimeMs;
    const delta = birth - startMs;
    if (delta < -15_000 || delta > 300_000) continue;
    if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { path: full, delta };
  }
  if (!best) return null;
  transcriptCache.set(pid, best.path);
  return best.path;
}

/**
 * The transcript's head carries a bridge_status line with the
 * claude.ai/code/session_… URL. Cached per pid — it never changes.
 */
function claudeUrlFor(pid: number, cwd: string | null, etimes: number): string | null {
  const cached = urlCache.get(pid);
  if (cached) return cached;
  const path = findTranscript(pid, cwd, etimes);
  if (!path) return null;
  let head = "";
  try {
    const fd = openSync(path, "r");
    const buf = Buffer.alloc(16384);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    head = buf.toString("utf8", 0, n);
  } catch { return null; }
  const m = head.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/);
  if (!m) return null;
  urlCache.set(pid, m[0]);
  return m[0];
}

/** The local session id needed to `claude --resume <id>` — the transcript's filename. */
function resumeIdFor(pid: number, cwd: string | null, etimes: number): string | null {
  const path = findTranscript(pid, cwd, etimes);
  if (!path) return null;
  return (path.split("/").pop() ?? "").replace(/\.jsonl$/, "") || null;
}

const RESUME_ID_RE = /^[a-zA-Z0-9_-]+$/;

/** Path to the Claude conversation transcript for a given cwd + local session id. */
function transcriptPathFor(projectPath: string, resumeId: string): string {
  return join(PROJECTS_DIR, projectPath.replace(/[^a-zA-Z0-9]/g, "-"), resumeId + ".jsonl");
}

/** Does the project's Claude transcript dir hold ANY conversation at all? */
function projectHasAnyTranscript(projectPath: string): boolean {
  const dir = join(PROJECTS_DIR, projectPath.replace(/[^a-zA-Z0-9]/g, "-"));
  try { return readdirSync(dir).some((f) => f.endsWith(".jsonl")); }
  catch { return false; }
}

/**
 * Decide how to resume a Claude conversation from what still survives on disk.
 * `claude --resume <id>` / `--continue` fail hard if the transcript is gone, and
 * that failure kills the detached screen silently — so we check before launching.
 *   - exact transcript present            → `--resume` the stored conversation
 *   - it's gone but the folder has others → `--continue` the latest one
 *   - nothing left in the folder          → blocked; there is nothing to resume
 * Pure (fs checks happen in the caller) so it can be unit-tested.
 */
export function planResume(exactExists: boolean, anyExists: boolean): { arg: "--resume" | "--continue" } | { blocked: true } {
  if (exactExists) return { arg: "--resume" };
  if (anyExists) return { arg: "--continue" };
  return { blocked: true };
}

/**
 * Can an archived row actually be resumed? Its folder must survive AND there must
 * be a Claude conversation left to resume into (the exact one, or any in the
 * folder for `--continue`). Mirrors the guard in `resumeArchived` so the UI's
 * resume button matches what a resume attempt would really do.
 */
function canResumeArchived(projectPath: string | null, name: string, resumeId: string | null): boolean {
  if (!projectPath || !existsSync(projectPath) || !FULL_NAME_RE.test(name)) return false;
  const rid = resumeId && RESUME_ID_RE.test(resumeId) ? resumeId : null;
  if (rid && existsSync(transcriptPathFor(projectPath, rid))) return true;
  return projectHasAnyTranscript(projectPath);
}

/** Map a raw model id (claude-opus-4-8-…) to a short display name (Opus 4.8). */
function friendlyModel(id: string): string {
  const rules: [RegExp, string][] = [
    [/opus-4-8/, "Opus 4.8"], [/opus-4-7/, "Opus 4.7"], [/opus-4-1/, "Opus 4.1"], [/opus-4/, "Opus 4"],
    [/fable-5/, "Fable 5"], [/mythos-5/, "Mythos 5"], [/sonnet-5/, "Sonnet 5"],
    [/haiku-4-5/, "Haiku 4.5"], [/sonnet-4/, "Sonnet 4"], [/haiku-4/, "Haiku 4"],
    [/3-7-sonnet/, "Sonnet 3.7"], [/3-5-sonnet/, "Sonnet 3.5"], [/3-5-haiku/, "Haiku 3.5"],
  ];
  for (const [re, name] of rules) if (re.test(id)) return name;
  return id.replace(/^claude-/, "").replace(/-/g, " ");
}

/** Read the last `maxBytes` of a transcript file, decoded as UTF-8. Null on any error. */
function readTranscriptTail(path: string, maxBytes = 65536): string | null {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    const len = Math.min(size, maxBytes);
    fd = openSync(path, "r");
    const buf = Buffer.alloc(len);
    const n = readSync(fd, buf, 0, len, Math.max(0, size - len));
    return buf.toString("utf8", 0, n);
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {} // never leak the fd if readSync throws
  }
}

/**
 * Read the LAST model id from the transcript tail — reflects the model in use
 * right now, even if it was switched mid-session. Cached per pid for 30s.
 */
function claudeModelFor(pid: number, cwd: string | null, etimes: number): string | null {
  const c = modelCache.get(pid);
  if (c && Date.now() - c.at < 30_000) return c.model;
  let model: string | null = null;
  const path = findTranscript(pid, cwd, etimes);
  const text = path ? readTranscriptTail(path) : null;
  if (text) {
    const ms = [...text.matchAll(/"model"\s*:\s*"(claude-[a-z0-9.-]+)"/g)];
    if (ms.length) model = friendlyModel(ms[ms.length - 1][1]);
  }
  modelCache.set(pid, { at: Date.now(), model });
  return model;
}

/**
 * The model a Command Code session is running, read from the last one its own
 * transcript recorded. Cached per pid for 30s, like the Claude reader above.
 */
function commandCodeModelFor(pid: number, cwd: string | null, sessionId: string | null): string | null {
  const cached = modelCache.get(pid);
  if (cached && Date.now() - cached.at < 30_000) return cached.model;
  const path = cwd && sessionId ? findCommandCodeTranscript(cwd, sessionId) : null;
  const text = path ? readTranscriptTail(path) : null;
  const model = text ? commandCodeModel(text) : null;
  modelCache.set(pid, { at: Date.now(), model });
  return model;
}

const waitingCache = new Map<number, { at: number; state: TurnState }>();

/**
 * Classify what the session's last real turn is doing, by reading the transcript
 * tail (see turn-state.ts):
 *   - "asking": Claude asked interactively (AskUserQuestion / ExitPlanMode) and is
 *     blocked on a reply → needs you, and needs you *now*.
 *   - "done":   Claude finished its turn (end_turn/stop_sequence) → waiting, idle.
 *   - "busy":   a user/tool_result last, an auto-running tool_use, or a streaming
 *     message → Claude is, or is about to be, working.
 * Callers derive `waiting` (done|asking) and `asking` from this. Cached ~4s per
 * pid to keep the poll cheap.
 */
function turnStateFor(pid: number, cwd: string | null, etimes: number): TurnState {
  const c = waitingCache.get(pid);
  if (c && Date.now() - c.at < 4000) return c.state;
  const path = findTranscript(pid, cwd, etimes);
  const text = path ? readTranscriptTail(path) : null;
  const state: TurnState = text ? lastTurnState(text) : "unknown";
  waitingCache.set(pid, { at: Date.now(), state });
  return state;
}

export interface Proc { pid: number; ppid: number; etimes: number; pcpu: number; args: string }

export async function run(cmd: string[], env?: Record<string, string>): Promise<{ code: number; out: string; err: string }> {
  const p = Bun.spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    env: childEnvironment(env),
  });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out, err };
}

/**
 * BSD `ps` (macOS) has no `etimes`, only `etime` — elapsed time as
 * `[[dd-]hh:]mm:ss`. Convert it to the seconds `etimes` would have given.
 * Returns null for anything unparseable so the caller can skip the row.
 */
export function parseEtime(field: string): number | null {
  const m = field.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/);
  if (!m) return null;
  const n = (s: string | undefined) => (s ? Number(s) : 0);
  return n(m[1]) * 86400 + n(m[2]) * 3600 + n(m[3]) * 60 + n(m[4]);
}

/**
 * One `ps` output line → Proc. Handles both the Linux `etimes` column (bare
 * seconds) and the macOS `etime` column (`[[dd-]hh:]mm:ss`). Pure + tested.
 */
export function parsePsLine(line: string): Proc | null {
  const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+([\d.]+)\s+(.*)$/);
  if (!m) return null;
  const elapsedField = m[3] ?? "";
  const elapsed = /^\d+$/.test(elapsedField) ? Number(elapsedField) : parseEtime(elapsedField);
  if (elapsed === null) return null;
  return { pid: Number(m[1]), ppid: Number(m[2]), etimes: elapsed, pcpu: Number(m[4]), args: m[5] ?? "" };
}

// Discover only this account’s processes; other instances have separate Unix owners.
const PS_ARGS = IS_DARWIN
  ? ["-u", String(process.getuid!()), "-o", "pid=,ppid=,etime=,pcpu=,args="]
  : ["-u", String(process.getuid!()), "-o", "pid=,ppid=,etimes=,pcpu=,args="];

async function listProcs(): Promise<Proc[]> {
  const { out } = await run(["ps", ...PS_ARGS]);
  return out.split("\n").filter(Boolean).map(parsePsLine).filter(Boolean) as Proc[];
}

/** Live cs-* sessions under either holder (zmx or legacy screen) → Map<rootPid, name>. */
function listScreens(): Promise<Map<number, string>> {
  return mux.listByPrefix(SCREEN_PREFIX);
}

/**
 * Is this ps row the claude binary itself? The SCREEN daemon carries the same
 * args string, so the first token has to be checked, not just the flags.
 *
 * Deliberately separate from "has --remote-control": a Session launched with
 * remote control off is still a Session, and still has to be listed and killed.
 */
export function isClaudeProc(args: string): boolean {
  return /(^|\/)claude(\s|$)/.test(args.split(/\s+/)[0] ?? "");
}

const CODEX_NON_INTERACTIVE_COMMANDS = new Set([
  "exec", "review", "login", "logout", "mcp", "plugin", "mcp-server",
  "app-server", "remote-control", "app", "completion", "update", "doctor",
  "sandbox", "debug", "apply", "archive", "delete", "unarchive", "fork",
  "cloud", "exec-server", "features", "help",
]);
const CODEX_OPTIONS_WITH_VALUES = new Set([
  "-c", "--config", "--remote", "--remote-auth-token-env", "-i", "--image",
  "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox",
  "-C", "--cd", "--add-dir", "-a", "--ask-for-approval",
]);

/** Match only the interactive Codex TUI process that this app launches. */
export function isCodexProc(args: string): boolean {
  const tokens = args.trim().split(/\s+/).filter(Boolean);
  if (!/(^|\/)codex$/.test(tokens[0] ?? "")) return false;
  for (let index = 1; index < tokens.length; index++) {
    const token = tokens[index];
    if (CODEX_OPTIONS_WITH_VALUES.has(token)) {
      index++;
      continue;
    }
    if (token === "--") return true;
    if (token.startsWith("-")) continue;
    if (token === "resume") return true;
    return !CODEX_NON_INTERACTIVE_COMMANDS.has(token);
  }
  return true;
}

/** Find an actual provider binary descended from one session root (screen daemon or zmx child). */
/** argv[0]'s basename, which is what a registered Command is recognised by. */
export function procBinName(args: string): string {
  const argv0 = args.trim().split(/\s+/)[0] ?? "";
  return argv0.slice(argv0.lastIndexOf("/") + 1);
}

const WRAPPER_BINS = new Set(["bash", "sh", "zsh", "dash", "screen", "SCREEN", "zmx", "env", "sudo"]);

/**
 * A Command is recognised by its registered binary's basename. If the definition was
 * deleted while the Session runs, fall back to "any descendant that isn't a shell
 * wrapper" so the card stays truthful and killable (plan R7).
 */
export function commandRecogniser(bin: string | null): (args: string) => boolean {
  if (bin) {
    const want = bin.slice(bin.lastIndexOf("/") + 1);
    return (args) => procBinName(args) === want;
  }
  return (args) => {
    const name = procBinName(args);
    return name.length > 0 && !WRAPPER_BINS.has(name);
  };
}

/**
 * A Command is looked for by its registered binary first, then by "any descendant
 * that isn't a shell wrapper". The fallback is not an edge case: `sh -c 'agent'`
 * and npx-style launchers exec into a different argv[0] than the one registered,
 * and a card that says "starting" forever while the agent is plainly running is a
 * worse lie than adopting the screen's own child.
 */
function commandRecognisers(provider: SessionProvider): Array<(args: string) => boolean> {
  const slug = commandSlug(provider);
  const bin = slug ? findCommand(slug)?.bin ?? null : null;
  return bin ? [commandRecogniser(bin), commandRecogniser(null)] : [commandRecogniser(null)];
}

function recogniserFor(provider: SessionProvider): (args: string) => boolean {
  if (provider === "codex") return isCodexProc;
  if (provider === "command-code") return isCommandCodeProc;
  if (!isCommandProvider(provider)) return isClaudeProc;
  return commandRecognisers(provider)[0]!;
}

/** Exact binary match if we can get it, screen-descendant otherwise. */
export function findCommandProcess(procs: readonly Proc[], screenPid: number, provider: SessionProvider): Proc | null {
  for (const recognises of commandRecognisers(provider)) {
    const found = findProviderProcess(procs, screenPid, provider, recognises);
    if (found) return found;
  }
  return null;
}

export function findProviderProcess(
  procs: readonly Proc[],
  screenPid: number,
  provider: SessionProvider,
  recognises: (args: string) => boolean = recogniserFor(provider),
): Proc | null {
  const byPid = new Map(procs.map((proc) => [proc.pid, proc]));
  for (const proc of procs) {
    if (!recognises(proc.args)) continue;
    let cursor: Proc | undefined = proc;
    for (let depth = 0; cursor && depth < 10; depth++) {
      if (cursor.pid === screenPid) return proc;
      cursor = byPid.get(cursor.ppid);
    }
  }
  return null;
}

export function hasRemoteControl(args: string): boolean {
  return args.split(/\s+/).includes("--remote-control");
}

function extractRemoteControlName(args: string): string | null {
  const tokens = args.split(/\s+/);
  const i = tokens.indexOf("--remote-control");
  if (i === -1) return null;
  const next = tokens[i + 1];
  return next && !next.startsWith("-") ? next : null;
}

/**
 * A process's working directory. Linux reads /proc; macOS has no procfs, so it
 * shells out to `lsof` (~15ms) — cached per pid, since a session's cwd never moves.
 */
const cwdCache = new Map<number, string | null>();

function procCwd(pid: number): string | null {
  if (!IS_DARWIN) {
    try { return readlinkSync(`/proc/${pid}/cwd`); } catch { return null; }
  }
  if (cwdCache.has(pid)) return cwdCache.get(pid)!;
  let cwd: string | null = null;
  try {
    const r = Bun.spawnSync(["lsof", "-a", "-d", "cwd", "-p", String(pid), "-Fn"], { env: childEnvironment() });
    // -Fn output: "p<pid>\nfcwd\nn/the/path\n"
    const line = r.stdout.toString().split("\n").find((l) => l.startsWith("n"));
    cwd = line ? line.slice(1) : null;
  } catch { cwd = null; }
  cwdCache.set(pid, cwd);
  return cwd;
}

function projectLabelFor(path: string | null): string | null {
  if (!path) return null;
  const row = db.query("SELECT label FROM projects WHERE path = ?").get(path) as { label: string } | null;
  return row?.label ?? null;
}

export interface LaunchRow {
  screen: string;
  name: string;
  project_path: string;
  created_at: number;
  claude_url: string | null;
  resume_id: string | null;
  remote_control: number;
  provider: SessionProvider;
  launch_id: string | null;
  phase: string | null;
  error_message: string | null;
  resume_archive_id: number | null;
}

export function reconcileCodexStartup(database: Database, launch: LaunchRow, observation: CodexStartupObservation) {
  if (observation !== "unknown") {
    database.query(
      "UPDATE launches SET phase = 'awaiting_session_start', error_message = NULL " +
      "WHERE launch_id = ? AND screen = ? AND provider = 'codex' AND phase = 'failed' AND error_message = ? " +
      "AND NOT EXISTS (SELECT 1 FROM codex_launch_state WHERE launch_id = launches.launch_id)",
    ).run(launch.launch_id, launch.screen, CODEX_READINESS_TIMEOUT_ERROR);
  }
  const current = database.query(
    "SELECT phase, error_message FROM launches WHERE launch_id = ? AND screen = ? AND provider = 'codex'",
  ).get(launch.launch_id, launch.screen) as { phase: string; error_message: string | null } | null;
  const hasState = !!database.query("SELECT 1 FROM codex_launch_state WHERE launch_id = ?").get(launch.launch_id);
  return {
    phase: current?.phase ?? launch.phase,
    error: current?.error_message ?? (current ? null : launch.error_message),
    waitingForTrust: !!current && current.phase === "awaiting_session_start" && !hasState && observation === "trust",
    inputReady: !!current && current.phase === "awaiting_session_start" && !hasState && observation === "input",
  };
}

const launchColumns = "screen, name, project_path, created_at, claude_url, resume_id, remote_control, provider, launch_id, phase, error_message, resume_archive_id";

function rowProvider(value: unknown): SessionProvider {
  return parseSessionProvider(value) ?? DEFAULT_SESSION_PROVIDER;
}

/** What to call a provider in an error the operator reads: a Command uses its label. */
export function providerDisplayName(provider: SessionProvider): string {
  const slug = commandSlug(provider);
  if (!slug) return capabilitiesFor(provider).displayName;
  return findCommand(slug)?.label ?? `Command “${slug}”`;
}

/** Only hook-confirmed Codex launches are conversations worth archiving. */
export function canArchiveManagedLaunch(provider: SessionProvider, phase: string | null): boolean {
  return provider !== "codex" || phase === "ready";
}

/** The launch line for a registered Command: every token quoted exactly once. */
export function buildCommandLaunch(command: Pick<CustomCommand, "bin" | "args">, cwd: string): string {
  const argv = [command.bin, ...command.args].map(shellQuote).join(" ");
  return `cd ${shellQuote(cwd)} && exec ${argv}`;
}

export interface ManagedCommandStart {
  screen: string;
  name: string;
  projectPath: string;
  provider: SessionProvider;
  /** Workspace prep (rsync/clone) that must succeed before the agent starts. */
  setupPrefix?: string;
}

/**
 * Launch a registered Command inside a managed screen. Preflight re-resolves the
 * binary, because a definition validated weeks ago can point at something that has
 * since been uninstalled — better a clear error than a screen that dies instantly.
 */
export async function startManagedCommand(options: ManagedCommandStart): Promise<{ ok: true } | { ok: false; error: string }> {
  const slug = commandSlug(options.provider);
  const command = slug ? findCommand(slug) : null;
  if (!command) return { ok: false, error: "That command is no longer registered." };

  const resolved = resolveBin(command.bin);
  if (!resolved.ok) return { ok: false, error: resolved.error };

  const inner = `${options.setupPrefix ?? ""}${buildCommandLaunch({ bin: resolved.path, args: command.args }, options.projectPath)}`;
  // The credential is handed to `screen` through its environment, which the agent
  // inherits. It must never go in argv: /proc/<pid>/cmdline is world-readable, so
  // `ps` on this box would print the token to anyone with an account. This is why
  // the Codex path's `exec env KEY=value` shape is not reused here — those markers
  // are non-secret, a token is not.
  const { code, err } = await mux.spawn(options.screen, inner, { env: commandEnv(slug) });
  if (code !== 0) return { ok: false, error: err || "session failed to start" };

  db.query(
    "INSERT INTO launches (screen, name, project_path, created_at, remote_control, provider, launch_id, phase, error_message, resume_archive_id) VALUES (?, ?, ?, ?, 0, ?, ?, 'ready', NULL, NULL) " +
    "ON CONFLICT(screen) DO UPDATE SET name = excluded.name, project_path = excluded.project_path, " +
    "created_at = excluded.created_at, remote_control = 0, provider = excluded.provider, " +
    "launch_id = excluded.launch_id, phase = 'ready', error_message = NULL, resume_archive_id = NULL",
  ).run(options.screen, options.name, options.projectPath, Date.now(), options.provider, randomUUID());
  return { ok: true };
}

export interface CommunicatingSessionOptions {
  screen: string;
  name: string;
  projectPath: string;
  provider: "claude" | "command-code";
  providerBin?: string;
  remoteControl: number;
  resumeId?: string | null;
  claudeUrl?: string | null;
  resumeArchiveId?: number | null;
  command: (mcpArgs: string[]) => string;
  env?: Record<string, string>;
}
interface CommunicatingSessionRuntime {
  database: Database;
  communicator: Communicator;
  configure: (provider: "claude" | "command-code", cwd: string, bin?: string) => Promise<string[]>;
  spawn: typeof mux.spawn;
  hasHolder: (screen: string) => Promise<boolean>;
  uuid: () => string;
  now: () => number;
}
const communicatingRuntime: CommunicatingSessionRuntime = {
  database: db, communicator, configure: (provider, cwd, bin) => providerCommunicatorArgs(provider, cwd, { commandCodeBin: bin }),
  spawn: mux.spawn, hasHolder: async screen => !!await mux.find(screen), uuid: randomUUID, now: Date.now,
};

/** Reserve identity before the child can initialize MCP; restore previous history if spawn fails. */
export async function startCommunicatingSession(options: CommunicatingSessionOptions, runtime: CommunicatingSessionRuntime = communicatingRuntime): Promise<{ ok: true } | { ok: false; error: string }> {
  let args: string[];
  try { args = await runtime.configure(options.provider, options.projectPath, options.providerBin); }
  catch (error) { return { ok: false, error: safeLaunchError((error as Error).message, "Could not configure session communication.") }; }
  const database = runtime.database;
  const previous = database.query(`SELECT ${launchColumns} FROM launches WHERE screen=?`).get(options.screen) as LaunchRow | null;
  if (previous?.phase === "preparing" || (previous && previous.provider !== options.provider)) return { ok: false, error: "Another managed launch already owns this session name." };
  try {
    if (await runtime.hasHolder(options.screen)) return { ok: false, error: "A session with this name is already running." };
  } catch { return { ok: false, error: "Could not verify whether this session is already running." }; }
  const current = database.query("SELECT launch_id,phase,created_at FROM launches WHERE screen=?").get(options.screen) as Pick<LaunchRow, "launch_id" | "phase" | "created_at"> | null;
  if (current?.launch_id !== previous?.launch_id || current?.phase !== previous?.phase || current?.created_at !== previous?.created_at) {
    return { ok: false, error: "Another launch reserved this session name while checking its holder." };
  }
  const launchId = runtime.uuid();
  try {
    database.query(`INSERT INTO launches (${launchColumns}) VALUES (?,?,?,?,?,?,?,?,?,'preparing',NULL,?)
      ON CONFLICT(screen) DO UPDATE SET name=excluded.name,project_path=excluded.project_path,created_at=excluded.created_at,
      claude_url=excluded.claude_url,resume_id=excluded.resume_id,remote_control=excluded.remote_control,provider=excluded.provider,
      launch_id=excluded.launch_id,phase=excluded.phase,error_message=NULL,resume_archive_id=excluded.resume_archive_id`)
      .run(options.screen,options.name,options.projectPath,runtime.now(),options.claudeUrl??null,options.resumeId??null,options.remoteControl,options.provider,launchId,options.resumeArchiveId??null);
    const { token } = runtime.communicator.prepare(launchId);
    const result = await runtime.spawn(options.screen, options.command(args), { env: { ...options.env, ...communicatorEnvironment(token, config.port) } });
    if (result.code !== 0) throw new Error(safeLaunchError(result.err, "Session failed to start."));
    database.query("UPDATE launches SET phase='ready' WHERE launch_id=? AND phase='preparing'").run(launchId);
    if (options.resumeArchiveId != null) database.query("DELETE FROM archive WHERE id=?").run(options.resumeArchiveId);
    return { ok: true };
  } catch (error) {
    runtime.communicator.revoke(launchId);
    database.transaction(() => {
      if (!database.query("SELECT 1 FROM launches WHERE screen=? AND launch_id=?").get(options.screen,launchId)) return;
      database.query("DELETE FROM launches WHERE launch_id=?").run(launchId);
      if (previous) database.query(`INSERT INTO launches (${launchColumns}) VALUES (${Array(12).fill("?").join(",")})`)
        .run(previous.screen,previous.name,previous.project_path,previous.created_at,previous.claude_url,previous.resume_id,previous.remote_control,previous.provider,previous.launch_id,previous.phase,previous.error_message,previous.resume_archive_id);
    })();
    return { ok: false, error: safeLaunchError((error as Error).message, "Session failed to start.") };
  }
}

export interface ManagedCommandCodeStart {
  screen: string;
  name: string;
  projectPath: string;
  /** Workspace prep (rsync/clone) that must succeed before the agent starts. */
  setupPrefix?: string;
  resumeId?: string | null;
  resumeArchiveId?: number | null;
}

/**
 * Launch a managed Command Code session.
 *
 * Preflight first: the CLI can be missing, too old, or unauthenticated, and inside a
 * detached screen all three failures look identical to the operator — a terminal that
 * attaches to nothing. The credential is handed to `screen` through its environment,
 * never argv, for the same reason a Command's token is: `/proc/<pid>/cmdline` is
 * world-readable, so `ps` would otherwise print the key to anyone with an account.
 */
export async function startManagedCommandCode(options: ManagedCommandCodeStart): Promise<{ ok: true } | { ok: false; error: string }> {
  const preflight = await preflightCommandCode();
  if (!preflight.ok) return { ok: false, error: preflight.message };

  const argv = buildCommandCodeInvocation({
    bin: preflight.bin,
    cwd: options.projectPath,
    name: options.name,
    resumeId: options.resumeId ?? null,
    unrestricted: config.unrestrictedAgents,
  });
  if (!argv) return { ok: false, error: "Could not construct a safe Command Code launch command." };

  return startCommunicatingSession({
    ...options, provider: "command-code", providerBin: preflight.bin, remoteControl: 0, env: commandCodeEnv(),
    command: () => `${options.setupPrefix ?? ""}cd ${shellQuote(options.projectPath)} && exec ${argv.map(shellQuote).join(" ")}`,
  });
}

export function screenlessLaunchAction(
  provider: SessionProvider,
  phase: string | null,
  ageMs: number,
): "wait" | "fail" | "archive" {
  if (!canArchiveManagedLaunch(provider, phase)) {
    return phase === "failed" || ageMs >= SCREEN_DISCOVERY_GRACE_MS ? "fail" : "wait";
  }
  return ageMs >= SCREEN_DISCOVERY_GRACE_MS ? "archive" : "wait";
}

/** Preserve a failed pre-ready launch so the operator can inspect and clean it up. */
export function failScreenlessCodexLaunch(database: Database, row: LaunchRow): LaunchRow | null {
  if (rowProvider(row.provider) !== "codex" || canArchiveManagedLaunch("codex", row.phase)) return null;
  const error = row.error_message || CODEX_EARLY_EXIT_ERROR;
  const changed = database.query(
    "UPDATE launches SET phase = 'failed', error_message = ? WHERE screen = ? AND provider = 'codex' AND launch_id IS ?",
  ).run(error, row.screen, row.launch_id);
  return changed.changes === 1
    ? { ...row, phase: "failed", error_message: error }
    : null;
}

/** Move a launch row into the archive. Safe to race — whoever deletes the row archives it. */
export function archiveManagedLaunch(
  database: Database,
  row: LaunchRow,
  endedAt: number,
  claudeUrl?: string | null,
): boolean {
  const archive = database.transaction(() => {
    const codexState = rowProvider(row.provider) === "codex" && row.launch_id
      ? database.query("SELECT session_id, model FROM codex_launch_state WHERE launch_id = ?").get(row.launch_id) as
          { session_id: string | null; model: string | null } | null
      : null;
    const gone = database.query("DELETE FROM launches WHERE screen = ?").run(row.screen);
    if (gone.changes === 0) return false; // someone else already archived it
    database.query("INSERT INTO archive (name, project_path, claude_url, resume_id, model, started_at, ended_at, remote_control, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(
        row.name,
        row.project_path,
        claudeUrl ?? row.claude_url,
        codexState?.session_id ?? row.resume_id,
        codexState?.model ?? null,
        row.created_at,
        endedAt,
        rowProvider(row.provider) === "codex" ? 0 : (row.remote_control ?? 1),
        rowProvider(row.provider),
      );
    return true;
  });
  return archive();
}

function archiveRow(row: LaunchRow, claudeUrl?: string | null): void {
  archiveManagedLaunch(db, row, Date.now(), claudeUrl);
}

export interface Activity { active: boolean; busy: boolean; waiting: boolean; asking: boolean; telemetryUnknown: boolean }

/** Lifetime CPU averages cannot override a completed turn or a blocked question. */
export function resolveActivity(cpuHigh: boolean, st: TurnState): Activity {
  return {
    active: cpuHigh,
    busy: st === "busy",
    waiting: st === "done" || st === "asking",
    asking: st === "asking",
    telemetryUnknown: st === "unknown",
  };
}

export async function listSessions(): Promise<SessionInfo[]> {
  const [procs, holders] = await Promise.all([listProcs(), mux.listAll()]);
  const screens = new Map<number, string>();
  let unknownHolder = 0;
  for (const holder of holders) if (holder.name.startsWith(SCREEN_PREFIX)) screens.set(holder.pid ?? --unknownHolder, holder.name);
  const byPid = new Map(procs.map((p) => [p.pid, p]));

  const claudeProcs = procs.filter((p) => isClaudeProc(p.args));

  const sessions: SessionInfo[] = [];
  const claimedScreens = new Set<string>();

  for (const proc of claudeProcs) {
    // Walk parents to find an owning cs-* session root
    let screenName: string | null = null;
    let cursor: Proc | undefined = proc;
    for (let depth = 0; cursor && depth < 10; depth++) {
      if (screens.has(cursor.pid)) { screenName = screens.get(cursor.pid)!; break; }
      cursor = byPid.get(cursor.ppid);
    }

    // Outside a cs-* screen, only a remote-controlled claude counts as an
    // External Session. Without that guard every ordinary `claude` the user
    // runs on the box — including the CLI they're reading this in — would show
    // up as a session they could "end".
    const remoteControl = hasRemoteControl(proc.args);
    if (!screenName && !remoteControl) continue;

    const project = procCwd(proc.pid);
    const cliName = extractRemoteControlName(proc.args);

    if (screenName) {
      const launch = db.query(`SELECT ${launchColumns} FROM launches WHERE screen = ?`).get(screenName) as
        LaunchRow | null;
      // Persisted provider identity is authoritative for managed screens. A
      // mismatched process is left for that provider's adapter instead of being
      // adopted as Claude from its executable name alone.
      if (launch && rowProvider(launch.provider) !== "claude") continue;
      claimedScreens.add(screenName);
      const cwd = project ?? launch?.project_path ?? null;
      // Resumed sessions reuse a transcript older than the process, so the
      // birth-time match fails — seed the cache straight from the stored id.
      if (launch?.resume_id && cwd && !transcriptCache.has(proc.pid)) {
        const p = join(PROJECTS_DIR, cwd.replace(/[^a-zA-Z0-9]/g, "-"), launch.resume_id + ".jsonl");
        if (existsSync(p)) transcriptCache.set(proc.pid, p);
      }
      const url = claudeUrlFor(proc.pid, cwd, proc.etimes) ?? launch?.claude_url ?? null;
      const resumeId = resumeIdFor(proc.pid, cwd, proc.etimes) ?? launch?.resume_id ?? null;
      // Persist url + resume id so they survive into the archive after the process dies
      if (launch && url && launch.claude_url !== url) {
        db.query("UPDATE launches SET claude_url = ? WHERE screen = ? AND provider = 'claude'").run(url, screenName);
      }
      if (launch && resumeId && launch.resume_id !== resumeId) {
        db.query("UPDATE launches SET resume_id = ? WHERE screen = ? AND provider = 'claude'").run(resumeId, screenName);
      }
      const cpuHigh = proc.pcpu >= ACTIVE_CPU_PCT;
      const st: TurnState = turnStateFor(proc.pid, cwd, proc.etimes);
      const act = resolveActivity(cpuHigh, st);
      sessions.push({
        id: `m:${screenName}`,
        kind: "managed",
        provider: rowProvider(launch?.provider),
        launchId: launch?.launch_id ?? null,
        phase: launch?.phase ?? null,
        errorMessage: launch?.error_message ?? null,
        name: cliName ?? launch?.name ?? screenName.slice(SCREEN_PREFIX.length),
        status: "running",
        workspace: isWorkspacePath(project ?? launch?.project_path ?? null),
        project: project ?? launch?.project_path ?? null,
        projectLabel: projectLabelFor(project ?? launch?.project_path ?? null),
        pid: proc.pid,
        uptimeSec: proc.etimes,
        cpu: proc.pcpu,
        active: act.active,
        busy: act.busy,
        waiting: act.waiting,
        asking: act.asking,
        telemetryUnknown: act.telemetryUnknown,
        claudeUrl: url,
        remoteControl,
        resumeId,
        model: claudeModelFor(proc.pid, project ?? launch?.project_path ?? null, proc.etimes),
        initial: displayInitial(cliName ?? launch?.name ?? screenName.slice(SCREEN_PREFIX.length)),
      });
    } else {
      const cpuHigh = proc.pcpu >= ACTIVE_CPU_PCT;
      const st: TurnState = turnStateFor(proc.pid, project, proc.etimes);
      const act = resolveActivity(cpuHigh, st);
      sessions.push({
        id: `e:${proc.pid}`,
        kind: "external",
        provider: "claude",
        launchId: null,
        phase: "ready",
        errorMessage: null,
        name: cliName ?? "unnamed",
        status: "running",
        workspace: isWorkspacePath(project),
        project,
        projectLabel: projectLabelFor(project),
        pid: proc.pid,
        uptimeSec: proc.etimes,
        cpu: proc.pcpu,
        active: act.active,
        busy: act.busy,
        waiting: act.waiting,
        asking: act.asking,
        telemetryUnknown: act.telemetryUnknown,
        claudeUrl: claudeUrlFor(proc.pid, project, proc.etimes),
        remoteControl,
        resumeId: resumeIdFor(proc.pid, project, proc.etimes),
        model: claudeModelFor(proc.pid, project, proc.etimes),
        initial: displayInitial(cliName ?? "unnamed"),
      });
    }
  }

  // Codex is managed-only: persisted provider ownership chooses the screens we
  // inspect, then process ancestry proves that the interactive TUI is live.
  const codexLaunches = db.query(`SELECT ${launchColumns} FROM launches WHERE provider = 'codex'`).all() as LaunchRow[];
  for (const launch of codexLaunches) {
    const screenEntry = [...screens.entries()].find(([, name]) => name === launch.screen);
    if (!screenEntry) continue;
    const proc = findProviderProcess(procs, screenEntry[0], "codex");
    if (!proc) continue;
    claimedScreens.add(launch.screen);
    let observation: CodexStartupObservation = "unknown";
    const mayObserveStartup = launch.phase === "awaiting_session_start"
      || (launch.phase === "failed" && launch.error_message === CODEX_READINESS_TIMEOUT_ERROR);
    const holder = holders.find(item => item.name === launch.screen && item.pid === screenEntry[0]);
    if (mayObserveStartup && launch.launch_id && holder
      && !db.query("SELECT 1 FROM codex_launch_state WHERE launch_id = ?").get(launch.launch_id)) {
      observation = await startupProbe(launch.launch_id, proc.pid, {
        backend: holder.backend, screen: launch.screen, zmxBin: mux.ZMX_BIN,
      }, DB_PATH);
    }
    const startup = reconcileCodexStartup(db, launch, observation);
    launch.phase = startup.phase;
    launch.error_message = startup.error;
    const startupWaitingForTrust = startup.waitingForTrust;
    const startupInputReady = startup.inputReady;
    const state = launch.launch_id
      ? db.query("SELECT session_id, model, turn_state, last_event, updated_at FROM codex_launch_state WHERE launch_id = ?").get(launch.launch_id) as
          { session_id: string | null; model: string | null; turn_state: string; last_event: string; updated_at: number } | null
      : null;
    const activity = codexActivity(state?.turn_state ?? null, state?.updated_at ?? null);
    const ready = launch.phase === "ready";
    const project = procCwd(proc.pid) ?? launch.project_path;
    sessions.push({
      id: `m:${launch.screen}`,
      kind: "managed",
      provider: "codex",
      launchId: launch.launch_id,
      phase: launch.phase,
      errorMessage: launch.error_message,
      name: launch.name,
      status: ready || startupInputReady || launch.phase === "failed" ? "running" : "starting",
      workspace: isWorkspacePath(project),
      project,
      projectLabel: projectLabelFor(project),
      pid: proc.pid,
      uptimeSec: proc.etimes,
      cpu: proc.pcpu,
      active: proc.pcpu >= ACTIVE_CPU_PCT,
      startupWaitingForTrust,
      startupInputReady,
      busy: ready && activity.busy,
      waiting: startupWaitingForTrust || (ready && activity.waiting),
      asking: startupWaitingForTrust || (ready && activity.asking),
      telemetryUnknown: ready && activity.telemetryUnknown,
      turnComplete: state?.last_event === "Stop",
      claudeUrl: null,
      remoteControl: false,
      resumeId: state?.session_id ?? launch.resume_id,
      model: state?.model ?? null,
      initial: displayInitial(launch.name),
    });
  }

  // Command Code is managed-only like Codex, but hookless: persisted ownership picks
  // the screen, process ancestry proves the agent is live, and the conversation id is
  // recovered from the meta file the agent writes for itself at startup. Without a
  // hook there is no turn state to report, so the card carries liveness and CPU and
  // never guesses at "working" or "needs you".
  const commandCodeLaunches = db.query(`SELECT ${launchColumns} FROM launches WHERE provider = 'command-code'`).all() as LaunchRow[];
  for (const launch of commandCodeLaunches) {
    const screenEntry = [...screens.entries()].find(([, name]) => name === launch.screen);
    if (!screenEntry) continue;
    const proc = findProviderProcess(procs, screenEntry[0], "command-code");
    if (!proc) continue;
    claimedScreens.add(launch.screen);
    const project = procCwd(proc.pid) ?? launch.project_path;
    // Persist the id once it appears, so it survives into the archive and can be resumed.
    const resumeId = launch.resume_id ?? findCommandCodeSessionId(project, launch.name, launch.created_at);
    if (resumeId && launch.resume_id !== resumeId) {
      db.query("UPDATE launches SET resume_id = ? WHERE screen = ? AND provider = 'command-code'")
        .run(resumeId, launch.screen);
    }
    const cpuHigh = proc.pcpu >= ACTIVE_CPU_PCT;
    sessions.push({
      id: `m:${launch.screen}`,
      kind: "managed",
      provider: "command-code",
      launchId: launch.launch_id,
      phase: launch.phase,
      errorMessage: launch.error_message,
      name: launch.name,
      status: "running",
      workspace: isWorkspacePath(project),
      project,
      projectLabel: projectLabelFor(project),
      pid: proc.pid,
      uptimeSec: proc.etimes,
      cpu: proc.pcpu,
      active: cpuHigh,
      busy: cpuHigh,
      waiting: false,
      asking: false,
      telemetryUnknown: false,
      claudeUrl: null,
      remoteControl: false,
      resumeId,
      model: commandCodeModelFor(proc.pid, project, resumeId),
      initial: displayInitial(launch.name),
    });
  }

  // Registered Commands are managed-only, like Codex: persisted ownership picks the
  // screen, process ancestry proves the agent is live. No hooks, so no turn state —
  // liveness and CPU are the only honest signals (plan R6).
  const commandLaunches = db.query(`SELECT ${launchColumns} FROM launches WHERE provider LIKE 'cmd:%'`).all() as LaunchRow[];
  for (const launch of commandLaunches) {
    const provider = rowProvider(launch.provider);
    const screenEntry = [...screens.entries()].find(([, name]) => name === launch.screen);
    if (!screenEntry) continue;
    const proc = findCommandProcess(procs, screenEntry[0], provider);
    if (!proc) continue;
    claimedScreens.add(launch.screen);
    const slug = commandSlug(provider);
    const definition = slug ? findCommand(slug) : null;
    const project = procCwd(proc.pid) ?? launch.project_path;
    sessions.push({
      id: `m:${launch.screen}`,
      kind: "managed",
      provider,
      launchId: launch.launch_id,
      phase: launch.phase,
      errorMessage: launch.error_message,
      name: launch.name,
      status: "running",
      workspace: isWorkspacePath(project),
      project,
      projectLabel: projectLabelFor(project),
      pid: proc.pid,
      uptimeSec: proc.etimes,
      cpu: proc.pcpu,
      active: proc.pcpu >= ACTIVE_CPU_PCT,
      busy: proc.pcpu >= ACTIVE_CPU_PCT,
      waiting: false,
      asking: false,
      telemetryUnknown: false,
      claudeUrl: null,
      remoteControl: false,
      resumeId: null,
      model: definition?.label ?? null,
      initial: displayInitial(launch.name),
    });
  }

  // Screens whose claude exited → "starting" (workspace prep in progress) or "ended" cards
  for (const [screenPid, screenName] of screens) {
    if (claimedScreens.has(screenName)) continue;
    const launch = db.query(`SELECT ${launchColumns} FROM launches WHERE screen = ?`).get(screenName) as LaunchRow | null;
    // Never adopt an unrelated Codex TUI merely because someone put it in a
    // cs-* screen. Codex ownership always starts from a current launch row.
    if (!launch && findProviderProcess(procs, screenPid, "codex")) continue;
    const starting = !!launch && Date.now() - launch.created_at < STARTING_GRACE_MS;
    const codexState = launch?.provider === "codex" && launch.launch_id
      ? db.query("SELECT session_id, model, turn_state, last_event, updated_at FROM codex_launch_state WHERE launch_id = ?").get(launch.launch_id) as
          { session_id: string | null; model: string | null; turn_state: string; last_event: string; updated_at: number } | null
      : null;
    sessions.push({
      id: `m:${screenName}`,
      kind: "managed",
      provider: rowProvider(launch?.provider),
      launchId: launch?.launch_id ?? null,
      phase: launch?.phase ?? null,
      errorMessage: launch?.error_message ?? null,
      name: launch?.name ?? screenName.slice(SCREEN_PREFIX.length),
      status: starting ? "starting" : "ended",
      workspace: isWorkspacePath(launch?.project_path ?? null),
      project: launch?.project_path ?? null,
      projectLabel: projectLabelFor(launch?.project_path ?? null),
      pid: null,
      uptimeSec: null,
      cpu: null,
      active: false,
      busy: false,
      waiting: false,
      asking: false,
      telemetryUnknown: false,
      claudeUrl: null,
      remoteControl: launch ? launch.remote_control === 1 : true,
      resumeId: codexState?.session_id ?? launch?.resume_id ?? null,
      model: codexState?.model ?? null,
      initial: displayInitial(launch?.name ?? screenName.slice(SCREEN_PREFIX.length)),
    });
  }

  // Launch rows whose screen vanished entirely → the session ended; move to archive.
  // 30s guard covers the race right after launch before the holder lists the session.
  const liveScreenNames = new Set(screens.values());
  const rows = db.query(`SELECT ${launchColumns} FROM launches`).all() as LaunchRow[];
  for (const row of rows) {
    if (liveScreenNames.has(row.screen)) continue;
    const action = screenlessLaunchAction(rowProvider(row.provider), row.phase, Date.now() - row.created_at);
    if (action === "wait") continue;
    if (action === "fail") {
      const failed = failScreenlessCodexLaunch(db, row);
      if (!failed) continue;
      const state = failed.launch_id
        ? db.query("SELECT session_id, model FROM codex_launch_state WHERE launch_id = ?").get(failed.launch_id) as
            { session_id: string | null; model: string | null } | null
        : null;
      sessions.push({
        id: `m:${failed.screen}`,
        kind: "managed",
        provider: "codex",
        launchId: failed.launch_id,
        phase: failed.phase,
        errorMessage: failed.error_message,
        name: failed.name,
        // The screen is gone, so this must not advertise a terminal attach.
        // phase/errorMessage still drive the failed-launch cleanup dialog.
        status: "ended",
        workspace: isWorkspacePath(failed.project_path),
        project: failed.project_path,
        projectLabel: projectLabelFor(failed.project_path),
        pid: null,
        uptimeSec: null,
        cpu: null,
        active: false,
        busy: false,
        waiting: false,
        asking: false,
        telemetryUnknown: false,
        claudeUrl: null,
        remoteControl: false,
        resumeId: state?.session_id ?? failed.resume_id,
        model: state?.model ?? null,
        initial: displayInitial(failed.name),
      });
      continue;
    }
    archiveRow(row);
  }

  const livePids = new Set(sessions.map((s) => s.pid).filter(Boolean));
  for (const pid of urlCache.keys()) if (!livePids.has(pid)) urlCache.delete(pid);
  for (const pid of transcriptCache.keys()) if (!livePids.has(pid)) transcriptCache.delete(pid);
  for (const pid of modelCache.keys()) if (!livePids.has(pid)) modelCache.delete(pid);
  for (const pid of waitingCache.keys()) if (!livePids.has(pid)) waitingCache.delete(pid);

  const order = { running: 0, starting: 1, ended: 2 } as const;
  sessions.sort((a, b) => (a.status === b.status ? a.name.localeCompare(b.name) : order[a.status] - order[b.status]));
  return sessions.map(session => ({ ...session, activity: sessionActivity(session) }));
}

/**
 * User-set prefix prepended to every session name at launch, so server-born
 * chats are easy to spot (and delete) in the claude.ai session list.
 */
export function sessionPrefix(): string {
  const p = getMeta("session_prefix") ?? "";
  return PREFIX_RE.test(p) ? p : "";
}

function prefixedName(name: string): string {
  const p = sessionPrefix();
  if (!p || name.toLowerCase().startsWith(p.toLowerCase())) return name;
  return p + name;
}

/** The id a Launch under `name` gets — prefix applied, as the launchers do. */
export function managedSessionId(name: string): string {
  return `m:${SCREEN_PREFIX}${prefixedName(name).toLowerCase()}`;
}

/** Avatar letter: first letter of the name AFTER the current prefix is stripped. */
function displayInitial(name: string): string {
  const p = sessionPrefix();
  let s = name;
  if (p && s.toLowerCase().startsWith(p.toLowerCase())) s = s.slice(p.length);
  s = s.replace(/^[-_\s]+/, "");
  return ((s || name).trim()[0] || name[0] || "?").toUpperCase();
}

/* ---------- workspaces (fresh launches) ---------- */

const isWorkspacePath = (p: string | null): boolean => !!p && p.startsWith(WORKSPACES_DIR + "/");

const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,120}$/;

function normalizeRepo(input: string): { url: string; slug: string; branch: string | null } | null {
  let s = input.trim();
  let branch: string | null = null;
  const hashAt = s.indexOf("#");
  if (hashAt !== -1) {
    branch = s.slice(hashAt + 1);
    s = s.slice(0, hashAt);
    if (!BRANCH_RE.test(branch) || branch.includes("..")) return null;
  }
  const m = s.match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!m || m[1] === ".." || m[2] === "..") return null;
  return { url: `https://github.com/${m[1]}/${m[2]}.git`, slug: `${m[1]}/${m[2]}`, branch };
}

/**
 * If an allowlisted Project is already a clone of this repo, use it as a fast-copy base.
 * Linked worktrees (.git is a pointer file) are skipped — copying one would share git
 * state with the original checkout instead of being independent.
 * Branch default when none requested: dev → origin/HEAD → master → main.
 */
function localBaseFor(url: string, requested: string | null): { path: string; branch: string } | null {
  const canon = url.toLowerCase().replace(/\.git$/, "");
  const rows = db.query("SELECT path FROM projects").all() as { path: string }[];
  for (const { path } of rows) {
    try { if (!statSync(join(path, ".git")).isDirectory()) continue; } catch { continue; }
    const git = (...args: string[]) => Bun.spawnSync(["git", "-C", path, ...args], { env: childEnvironment() }).stdout.toString().trim();
    const origin = git("remote", "get-url", "origin");
    if (!origin || origin.toLowerCase().replace(/\.git$/, "") !== canon) continue;
    const branch =
      requested ||
      (git("show-ref", "--verify", "refs/remotes/origin/dev") ? "dev" : "") ||
      git("symbolic-ref", "--short", "refs/remotes/origin/HEAD").replace(/^origin\//, "") ||
      (git("show-ref", "--verify", "refs/remotes/origin/master") ? "master" : "") ||
      (git("show-ref", "--verify", "refs/remotes/origin/main") ? "main" : "");
    if (branch && BRANCH_RE.test(branch)) return { path, branch };
  }
  return null;
}

export async function launchWorkspaceSession(name: string, repoInput: string, remoteControl = true, provider: SessionProvider = DEFAULT_SESSION_PROVIDER): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!NAME_RE.test(name)) {
    return { ok: false, error: "Name must be 1-31 chars: letters, numbers, dashes." };
  }
  name = prefixedName(name);
  if (!FULL_NAME_RE.test(name)) {
    return { ok: false, error: "Name is too long once the prefix is added." };
  }
  const repo = normalizeRepo(String(repoInput ?? ""));
  if (!repo) return { ok: false, error: "Repo must be owner/name or a GitHub URL." };

  const screenName = SCREEN_PREFIX + name.toLowerCase();
  const screens = await listScreens();
  if ([...screens.values()].includes(screenName)) {
    return { ok: false, error: `A session named “${name}” is already running.` };
  }

  const { out: dfOut } = await run(["df", "--output=avail", "-BG", "/"]);
  const availG = Number(dfOut.trim().split("\n").pop()?.replace(/\D/g, "") ?? "0");
  if (availG < 5) return { ok: false, error: `Only ${availG}G disk left — clean up workspaces first.` };

  const ws = join(WORKSPACES_DIR, name.toLowerCase());
  if (!isWorkspacePath(ws)) return { ok: false, error: "Bad workspace path." };

  const base = localBaseFor(repo.url, repo.branch);
  const prep = base
    ? `rsync -a --delete --exclude=/.git/worktrees ${shellQuote(base.path + "/")} ${shellQuote(ws + "/")} && cd ${shellQuote(ws)} && rm -rf .git/worktrees && ` +
      `git fetch origin ${shellQuote(base.branch)} && git checkout -f -B ${shellQuote(base.branch)} 'origin/${base.branch}' && git reset --hard 'origin/${base.branch}'`
    : `rm -rf ${shellQuote(ws)} && git clone ${repo.branch ? `-b ${shellQuote(repo.branch)} ` : ""}${shellQuote(repo.url)} ${shellQuote(ws)} && cd ${shellQuote(ws)}` +
      (repo.branch ? "" : ` && { git checkout -f -B dev origin/dev 2>/dev/null || true ; }`);

  if (provider !== "claude") {
    const setupPrefix = `mkdir -p ${shellQuote(WORKSPACES_DIR)} && { ${prep} ; } > ${shellQuote(join(WORKSPACES_DIR, name.toLowerCase() + ".setup.log"))} 2>&1 && `;
    if (provider === "codex") return startManagedCodex({ screen: screenName, name, projectPath: ws, setupPrefix });
    if (provider === "command-code") return startManagedCommandCode({ screen: screenName, name, projectPath: ws, setupPrefix });
    return startManagedCommand({ screen: screenName, name, projectPath: ws, provider, setupPrefix });
  }

  const claudeBin = Bun.which("claude") ?? join(homedir(), ".local", "bin", "claude");
  const trustScript = new URL("./trust.ts", import.meta.url).pathname;
  return startCommunicatingSession({
    screen: screenName, name, projectPath: ws, provider: "claude", remoteControl: remoteControl ? 1 : 0,
    command: mcp =>
    `mkdir -p ${shellQuote(WORKSPACES_DIR)} && { ${prep}${config.unrestrictedAgents ? ` && ${shellQuote(process.execPath)} ${shellQuote(trustScript)} ${shellQuote(ws)}` : ""} ; } > ${shellQuote(join(WORKSPACES_DIR, name.toLowerCase() + ".setup.log"))} 2>&1 && ` +
    `exec ${shellQuote(claudeBin)} ${mcp.map(shellQuote).join(" ")} ${remoteControl ? `--remote-control '${name}' ` : ""}${claudePermissionArgs()}`,
  });
}

/* ---------- Synced Launch (xcm CLI) ---------- */

/** Safe single-quoting for embedding arbitrary text (a prompt) in a bash -lc string. */
const shellQuote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

const CODEX_ENV_KEYS = ["CS_DB_PATH", "CS_LAUNCH_ID", "CS_SCREEN"] as const;

/** Quote the already-validated invocation exactly once at the bash/screen boundary. */
export function buildCodexScreenCommand(invocation: CodexInvocation): string | null {
  const keys = Object.keys(invocation.env).sort();
  if (keys.join("\0") !== [...CODEX_ENV_KEYS].sort().join("\0") || invocation.argv.length === 0) return null;
  const markers = CODEX_ENV_KEYS.map((key) => `${key}=${shellQuote(invocation.env[key] ?? "")}`);
  return `exec env ${markers.join(" ")} ${invocation.argv.map(shellQuote).join(" ")}`;
}

/**
 * A Command Code conversation is resumable only when its transcript survives. A
 * session that was launched and never spoken to has an id but no transcript, and
 * `--session` on one of those dies inside the detached screen it was launched in.
 */
export function canResumeCommandCodeArchive(projectPath: string | null, name: string, resumeId: string | null): boolean {
  const id = normalizeCommandCodeSessionId(resumeId);
  return !!projectPath
    && existsSync(projectPath)
    && FULL_NAME_RE.test(name)
    && !!id
    && findCommandCodeTranscript(projectPath, id) !== null;
}

export function canResumeCodexArchive(projectPath: string | null, name: string, resumeId: string | null): boolean {
  return !!projectPath
    && existsSync(projectPath)
    && FULL_NAME_RE.test(name)
    && normalizeCodexResumeId(resumeId) != null;
}

export function normalizeCodexResumeId(resumeId: string | null | undefined): string | null {
  return resumeId && isCodexSessionId(resumeId) ? resumeId.toLowerCase() : null;
}

function safeLaunchError(raw: string, fallback: string): string {
  const value = raw.replace(/cscomm_[A-Za-z0-9_-]{43}/g, "[redacted]").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return (value || fallback).slice(0, 240);
}

export interface ManagedCodexStart {
  screen: string;
  name: string;
  projectPath: string;
  setupPrefix?: string;
  resumeId?: string | null;
  resumeArchiveId?: number | null;
}

export interface ManagedCodexRuntime {
  database: Database;
  dbPath: string;
  preflight: () => ReturnType<typeof preflightCodex>;
  execute: (command: string[], env?: Record<string, string>) => Promise<{ code: number; out: string; err: string }>;
  uuid: () => string;
  now: () => number;
}

const defaultManagedCodexRuntime: ManagedCodexRuntime = {
  database: db,
  dbPath: DB_PATH,
  preflight: () => preflightCodex(),
  execute: run,
  uuid: randomUUID,
  now: Date.now,
};

/** Preflight, persist ownership, then spawn the managed interactive TUI. */
export async function startManagedCodex(
  options: ManagedCodexStart,
  runtime: ManagedCodexRuntime = defaultManagedCodexRuntime,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const preflight = await runtime.preflight();
  if (!preflight.ok) return { ok: false, error: preflight.message };

  const existing = runtime.database.query(
    "SELECT name FROM launches WHERE screen = ?",
  ).get(options.screen) as { name: string } | null;
  if (existing) {
    return { ok: false, error: `A managed session record already owns “${existing.name}”.` };
  }

  const launchId = runtime.uuid();
  const mcpArgs = await providerCommunicatorArgs("codex", options.projectPath);
  const invocation = buildCodexInvocation({
    bin: preflight.bin,
    cwd: options.projectPath,
    screen: options.screen,
    launchId,
    dbPath: runtime.dbPath,
    resumeId: options.resumeId,
    unrestricted: config.unrestrictedAgents,
    mcpArgs,
  });
  const command = invocation ? buildCodexScreenCommand(invocation) : null;
  if (!command) return { ok: false, error: "Could not construct a safe Codex launch command." };

  try {
    runtime.database.query(
      "INSERT INTO launches (screen, name, project_path, created_at, resume_id, remote_control, provider, launch_id, phase, error_message, resume_archive_id) " +
      "VALUES (?, ?, ?, ?, ?, 0, 'codex', ?, 'preparing', NULL, ?)",
    ).run(
      options.screen,
      options.name,
      options.projectPath,
      runtime.now(),
      options.resumeId ?? null,
      launchId,
      options.resumeArchiveId ?? null,
    );
  } catch {
    return { ok: false, error: `A managed session record already owns “${options.name}”.` };
  }

  const launchCommunicator = new Communicator(runtime.database, { isLive: async () => false });
  let result: { code: number; out: string; err: string };
  try {
    const { token } = launchCommunicator.prepare(launchId);
    result = await runtime.execute(mux.spawnArgv(mux.newSessionBackend(), options.screen, `${options.setupPrefix ?? ""}${command}`), communicatorEnvironment(token, config.port));
  } catch { result = { code: 1, out: "", err: "Could not start Codex with its session communicator." }; }
  if (result.code !== 0) {
    launchCommunicator.revoke(launchId);
    const error = safeLaunchError(result.err, "session failed to start Codex");
    runtime.database.query(
      "UPDATE launches SET phase = 'failed', error_message = ? WHERE launch_id = ? AND provider = 'codex'",
    ).run(error, launchId);
    return { ok: false, error };
  }

  // SessionStart may race this update. Never regress a hook-confirmed ready row.
  runtime.database.query(
    "UPDATE launches SET phase = 'awaiting_session_start' WHERE launch_id = ? AND provider = 'codex' AND phase = 'preparing'",
  ).run(launchId);
  return { ok: true };
}

/** Reuse gh's credential helper; never copy tokens into a cloned workspace. */
export async function ensurePushCreds(ws: string): Promise<void> {
  const origin = (await run(["git", "-C", ws, "remote", "get-url", "origin"])).out.trim();
  const match = origin.match(/^(?:git@github\.com:|https:\/\/github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  if (!match) return;
  const gh = Bun.which("gh");
  if (!gh || (await run([gh, "auth", "status", "--hostname", "github.com"])).code !== 0) return;
  await run(["git", "-C", ws, "remote", "set-url", "origin", `https://github.com/${match[1]}/${match[2]}.git`]);
  await run(["git", "-C", ws, "config", "--replace-all", "credential.helper", ""]);
  await run(["git", "-C", ws, "config", "--add", "credential.helper", `!${shellQuote(gh)} auth git-credential`]);
}

export interface SyncedStatus {
  state: "live" | "resumable" | "none";
  name: string;          // prefixed session name
  workspacePath: string;
  claudeUrl: string | null;
  resumeId: string | null;
}

/**
 * What `xcm --server` should do for a branch-derived name:
 *  - live      → a session is already running; caller sends the prompt in the app.
 *  - resumable → it ended but its Workspace survives; resume it, seeded with a prompt.
 *  - none      → fresh Synced Launch (prepare + rsync overlay + launch).
 */
export async function syncedStatus(rawName: string): Promise<{ ok: true; status: SyncedStatus } | { ok: false; error: string }> {
  if (!NAME_RE.test(rawName)) return { ok: false, error: "Name must be 1-31 chars: letters, numbers, dashes." };
  const name = prefixedName(rawName);
  if (!FULL_NAME_RE.test(name)) return { ok: false, error: "Name is too long once the prefix is added." };
  const screenName = SCREEN_PREFIX + name.toLowerCase();
  const workspacePath = join(WORKSPACES_DIR, name.toLowerCase());

  const screens = await listScreens();
  if ([...screens.values()].includes(screenName)) {
    const launch = db.query("SELECT provider, claude_url FROM launches WHERE screen = ?").get(screenName) as { provider: SessionProvider; claude_url: string | null } | null;
    if (launch && rowProvider(launch.provider) !== "claude") {
      return { ok: false, error: `A ${providerDisplayName(rowProvider(launch.provider))} session already owns “${name}”.` };
    }
    return { ok: true, status: { state: "live", name, workspacePath, claudeUrl: launch?.claude_url ?? null, resumeId: null } };
  }
  // A launch row whose screen has died but hasn't been archived yet, or an archived row.
  const launch = db.query("SELECT project_path, claude_url, resume_id FROM launches WHERE screen = ? AND provider = 'claude'").get(screenName) as
    { project_path: string; claude_url: string | null; resume_id: string | null } | null;
  const arch = db.query("SELECT project_path, claude_url, resume_id FROM archive WHERE name = ? AND provider = 'claude' ORDER BY ended_at DESC LIMIT 1").get(name) as
    { project_path: string | null; claude_url: string | null; resume_id: string | null } | null;
  const prior = launch ?? arch;
  if (prior && prior.project_path && existsSync(prior.project_path)) {
    return { ok: true, status: { state: "resumable", name, workspacePath: prior.project_path, claudeUrl: prior.claude_url, resumeId: prior.resume_id } };
  }
  return { ok: true, status: { state: "none", name, workspacePath, claudeUrl: null, resumeId: null } };
}

/**
 * Seed a Workspace for a Synced Launch: fast-copy the base Project (bringing
 * gitignored deps + .env) so the caller's `rsync` overlay lands on a runnable tree.
 * The overlay carries the real .git, so branch state is finalised there — the
 * checkout here is best-effort (a brand-new local branch may not exist on origin).
 */
export async function prepareSynced(rawName: string, repoInput: string, branchInput: string | null): Promise<{ ok: true; workspacePath: string } | { ok: false; error: string }> {
  if (!NAME_RE.test(rawName)) return { ok: false, error: "Name must be 1-31 chars: letters, numbers, dashes." };
  const name = prefixedName(rawName);
  if (!FULL_NAME_RE.test(name)) return { ok: false, error: "Name is too long once the prefix is added." };
  const repo = normalizeRepo(String(repoInput ?? ""));
  if (!repo) return { ok: false, error: "Repo must be owner/name or a GitHub URL." };
  const branch = (branchInput || repo.branch || "").trim() || null;
  if (branch && (!BRANCH_RE.test(branch) || branch.includes(".."))) return { ok: false, error: "Bad branch name." };
  const ws = join(WORKSPACES_DIR, name.toLowerCase());
  if (!isWorkspacePath(ws)) return { ok: false, error: "Bad workspace path." };

  const { out: dfOut } = await run(["df", "--output=avail", "-BG", "/"]);
  const availG = Number(dfOut.trim().split("\n").pop()?.replace(/\D/g, "") ?? "0");
  if (availG < 5) return { ok: false, error: `Only ${availG}G disk left — clean up workspaces first.` };

  const base = localBaseFor(repo.url, branch);
  const b = base?.branch ?? branch;
  const prep = base
    ? `rsync -a --delete --exclude=/.git/worktrees ${shellQuote(base.path + "/")} ${shellQuote(ws + "/")} && cd ${shellQuote(ws)} && rm -rf .git/worktrees && ` +
      (b ? `{ git fetch origin ${shellQuote(b)} && git checkout -f -B ${shellQuote(b)} 'origin/${b}' && git reset --hard 'origin/${b}' || echo 'branch not on origin yet; overlay will set state'; }` : "true")
    : `rm -rf ${shellQuote(ws)} && git clone ${branch ? `-b ${shellQuote(branch)} ` : ""}${shellQuote(repo.url)} ${shellQuote(ws)}`;
  const inner = `mkdir -p ${shellQuote(WORKSPACES_DIR)} && { ${prep} ; } > ${shellQuote(join(WORKSPACES_DIR, name.toLowerCase() + ".setup.log"))} 2>&1`;
  const { code, err } = await run(["bash", "-lc", inner]);
  if (code !== 0) return { ok: false, error: err || `prepare failed — see ${name.toLowerCase()}.setup.log` };
  return { ok: true, workspacePath: ws };
}

/**
 * Start (or resume) a remote-controlled Session on an already-prepared+synced
 * Workspace, seeded with an optional prompt. Called after the caller's rsync overlay.
 */
// `claude-auto-danger`'s mode: the auto-mode classifier on top of bypass, so the
// session starts in auto and shift+tab still reaches bypass. Opt-in per launch.
const AUTO_MODE_ARGS = "--permission-mode auto --enable-auto-mode ";
const claudePermissionArgs = () => config.unrestrictedAgents ? "--dangerously-skip-permissions " : "";

export async function launchSynced(
  rawName: string,
  prompt: string | null,
  resumeId: string | null,
  opts: { autoMode?: boolean } = {},
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!NAME_RE.test(rawName)) return { ok: false, error: "Name must be 1-31 chars: letters, numbers, dashes." };
  const name = prefixedName(rawName);
  if (!FULL_NAME_RE.test(name)) return { ok: false, error: "Name is too long once the prefix is added." };
  const ws = join(WORKSPACES_DIR, name.toLowerCase());
  if (!isWorkspacePath(ws) || !existsSync(ws)) return { ok: false, error: "Workspace is missing — prepare first." };
  const screenName = SCREEN_PREFIX + name.toLowerCase();
  const owner = db.query("SELECT provider FROM launches WHERE screen = ?").get(screenName) as { provider: SessionProvider } | null;
  if (owner && rowProvider(owner.provider) !== "claude") {
    return { ok: false, error: `A Codex session already owns “${name}”.` };
  }
  const screens = await listScreens();
  if ([...screens.values()].includes(screenName)) return { ok: false, error: `A session named “${name}” is already running.` };

  await ensurePushCreds(ws); // so the session can git-push the branch back

  // Only pass --resume if that exact conversation still exists on disk; a resume of
  // a deleted transcript fails and kills the screen. Otherwise start fresh (the
  // workspace was just re-synced anyway) — the seed prompt still lands.
  const rid = resumeId && RESUME_ID_RE.test(resumeId) && existsSync(transcriptPathFor(ws, resumeId)) ? resumeId : null;
  const resumeArg = rid ? `--resume '${rid}' ` : "";
  const promptArg = prompt && prompt.trim() ? " " + shellQuote(prompt) : "";
  const claudeBin = Bun.which("claude") ?? join(homedir(), ".local", "bin", "claude");
  const trustScript = new URL("./trust.ts", import.meta.url).pathname;
  const started = await startCommunicatingSession({
    screen: screenName, name, projectPath: ws, provider: "claude", remoteControl: 1, resumeId: rid,
    command: mcp =>
    `cd ${shellQuote(ws)} && ${config.unrestrictedAgents ? `${shellQuote(process.execPath)} ${shellQuote(trustScript)} ${shellQuote(ws)} && ` : ""}` +
    `exec ${shellQuote(claudeBin)} ${mcp.map(shellQuote).join(" ")} ${resumeArg}${opts.autoMode && config.unrestrictedAgents ? AUTO_MODE_ARGS : ""}--remote-control '${name}' ${claudePermissionArgs()}${promptArg}`,
  });
  if (!started.ok) return started;
  const archived = db.query(
    "SELECT id FROM archive WHERE name = ? AND provider = 'claude' AND (? IS NULL OR resume_id = ?) ORDER BY ended_at DESC LIMIT 1",
  ).get(name, rid, rid) as { id: number } | null;
  if (archived) db.query("DELETE FROM archive WHERE id = ?").run(archived.id);
  return { ok: true };
}

export interface WorkspaceState {
  workspace: boolean;
  path: string | null;
  dirty: boolean;     // uncommitted changes
  unpushed: boolean;  // local commits missing from every remote
}

export async function workspaceState(id: string): Promise<WorkspaceState> {
  const none: WorkspaceState = { workspace: false, path: null, dirty: false, unpushed: false };
  if (!id.startsWith("m:")) return none;
  const launch = db.query("SELECT project_path FROM launches WHERE screen = ?").get(id.slice(2)) as
    { project_path: string } | null;
  const path = launch?.project_path ?? null;
  if (!isWorkspacePath(path) || !existsSync(path!)) return none;
  const status = await run(["git", "-C", path!, "status", "--porcelain"]);
  const ahead = await run(["git", "-C", path!, "log", "--branches", "--not", "--remotes", "--oneline", "-1"]);
  return {
    workspace: true,
    path,
    dirty: status.out.trim().length > 0,
    unpushed: ahead.out.trim().length > 0,
  };
}

let repoCache: { at: number; repos: string[] } | null = null;

export async function listRepos(): Promise<string[]> {
  if (repoCache && Date.now() - repoCache.at < 300_000) return repoCache.repos;
  const gh = Bun.which("gh") ?? "/usr/bin/gh";
  const results = await Promise.all([
    run([gh, "repo", "list", "--limit", "100", "--json", "nameWithOwner"]),
    ...config.repoOwners.map(owner => run([gh, "repo", "list", owner, "--limit", "100", "--json", "nameWithOwner"])),
  ]);
  const repos = new Set<string>();
  for (const r of results) {
    try { for (const o of JSON.parse(r.out)) repos.add(o.nameWithOwner); } catch {}
  }
  repoCache = { at: Date.now(), repos: [...repos].sort() };
  return repoCache.repos;
}

/** Pre-accept Claude Code's folder-trust dialog for a project path, in-process. */
function ensureTrusted(path: string): void {
  const file = join(homedir(), ".claude.json");
  try {
    const config = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
    config.projects ??= {};
    if (config.projects[path]?.hasTrustDialogAccepted === true) return;
    config.projects[path] = { ...(config.projects[path] ?? {}), hasTrustDialogAccepted: true };
    writeFileSync(file, JSON.stringify(config, null, 2));
  } catch (e) {
    console.error("ensureTrusted failed for", path, e);
  }
}

export async function launchSession(name: string, projectId: number, remoteControl = true, provider: SessionProvider = DEFAULT_SESSION_PROVIDER): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!NAME_RE.test(name)) {
    return { ok: false, error: "Name must be 1-31 chars: letters, numbers, dashes." };
  }
  name = prefixedName(name);
  if (!FULL_NAME_RE.test(name)) {
    return { ok: false, error: "Name is too long once the prefix is added." };
  }
  const project = db.query("SELECT path FROM projects WHERE id = ?").get(projectId) as { path: string } | null;
  if (!project) return { ok: false, error: "Unknown project." };

  const screenName = SCREEN_PREFIX + name.toLowerCase();
  const screens = await listScreens();
  if ([...screens.values()].includes(screenName)) {
    return { ok: false, error: `A session named “${name}” is already running.` };
  }

  if (provider === "codex") {
    return startManagedCodex({ screen: screenName, name, projectPath: project.path });
  }

  if (provider === "command-code") {
    return startManagedCommandCode({ screen: screenName, name, projectPath: project.path });
  }

  if (isCommandProvider(provider)) {
    return startManagedCommand({ screen: screenName, name, projectPath: project.path, provider });
  }

  // Pre-accept the folder-trust dialog for this project, or claude blocks on
  // "Is this a project you trust?" inside the detached screen forever. The
  // workspace launch path does this via trust.ts; plain project launches need
  // it too (a folder registered through the Projects sheet isn't trusted yet).
  if (config.unrestrictedAgents) ensureTrusted(project.path);

  const claudeBin = Bun.which("claude") ?? join(homedir(), ".local", "bin", "claude");
  // name and project are validated above; single-quoting is safe for both
  // Remote control off → a plain TUI session in the screen, reachable through the
  // web terminal instead of the Claude app. Everything else is identical.
  const rc = remoteControl ? `--remote-control '${name}' ` : "";
  return startCommunicatingSession({
    screen: screenName, name, projectPath: project.path, provider: "claude", remoteControl: remoteControl ? 1 : 0,
    command: mcp => `cd ${shellQuote(project.path)} && exec ${shellQuote(claudeBin)} ${mcp.map(shellQuote).join(" ")} ${rc}${claudePermissionArgs()}`,
  });
}

/** Find the provider's actual interactive child inside a managed screen. */
async function providerPidForScreen(screenName: string, provider: SessionProvider): Promise<number | null> {
  const [procs, screens] = await Promise.all([listProcs(), listScreens()]);
  const screenPid = [...screens.entries()].find(([, name]) => name === screenName)?.[0];
  if (!screenPid) return null;
  const proc = isCommandProvider(provider)
    ? findCommandProcess(procs, screenPid, provider)
    : findProviderProcess(procs, screenPid, provider);
  return proc?.pid ?? null;
}

/**
 * A zombie still answers kill(pid, 0). Under zmx the agent is the session's root
 * child, and zmx reaps it only once the pty closes — which a background process
 * holding the tty can delay — so "exited" has to include "zombie".
 */
function exited(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return true; }
  if (IS_DARWIN) return false;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) === "Z";
  } catch { return true; }
}

/** SIGTERM a pid and wait for it to exit, so claude disconnects cleanly from claude.ai. */
async function gracefulKill(pid: number, waitMs = 8000): Promise<void> {
  try { process.kill(pid, "SIGTERM"); } catch { return; }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await Bun.sleep(400);
    if (exited(pid)) return;
  }
}

export async function killSession(id: string, force = false, deleteWorkspace = false, deleteChat = false): Promise<{ ok: boolean; error?: string }> {
  if (id.startsWith("m:")) {
    const screenName = id.slice(2);
    if (!screenName.startsWith(SCREEN_PREFIX) || !/^[a-zA-Z0-9_-]+$/.test(screenName.slice(SCREEN_PREFIX.length))) {
      return { ok: false, error: "Bad session id." };
    }
    const launch = db.query(`SELECT ${launchColumns} FROM launches WHERE screen = ?`).get(screenName) as
      LaunchRow | null;
    if (deleteChat && launch && rowProvider(launch.provider) !== "claude") {
      return { ok: false, error: "Chat deletion is only available for Claude sessions." };
    }
    const provider = rowProvider(launch?.provider);
    const legacyClaudePid = launch ? null : await providerPidForScreen(screenName, "claude");
    if (!launch && !legacyClaudePid) {
      return { ok: false, error: "That screen is not an app-managed session." };
    }
    // Signal the real provider child first, then use ending the holder as the
    // bounded fallback for wrappers or a process that does not exit cleanly.
    const pid = legacyClaudePid ?? await providerPidForScreen(screenName, provider);
    if (pid && !force) await gracefulKill(pid);
    await mux.quit(screenName);
    const chatUrl = (pid ? urlCache.get(pid) : undefined) ?? launch?.claude_url ?? null;
    if (launch && canArchiveManagedLaunch(provider, launch.phase)) archiveRow(launch, chatUrl);
    else if (launch) db.query("DELETE FROM launches WHERE screen = ?").run(screenName);
    if (deleteChat && provider === "claude") queueChatDeletion(chatUrl);
    if (deleteWorkspace && launch && isWorkspacePath(launch.project_path) && !launch.project_path.includes("..")) {
      await run(["rm", "-rf", launch.project_path, `${launch.project_path}.setup.log`]);
    }
    return { ok: true };
  }
  if (id.startsWith("e:")) {
    const pid = Number(id.slice(2));
    if (!Number.isInteger(pid) || pid <= 1) return { ok: false, error: "Bad pid." };
    // Only signal a process that is actually claude — with or without remote
    // control, both are Sessions this app owns.
    const procs = await listProcs();
    const target = procs.find((p) => p.pid === pid && isClaudeProc(p.args));
    if (!target) return { ok: false, error: "That session is already gone." };
    try { process.kill(pid, force ? "SIGKILL" : "SIGTERM"); } catch { return { ok: false, error: "Failed to signal process." }; }
    db.query("INSERT INTO archive (name, project_path, claude_url, started_at, ended_at, provider) VALUES (?, ?, ?, ?, ?, 'claude')")
      .run(extractRemoteControlName(target.args) ?? "unnamed", procCwd(pid), urlCache.get(pid) ?? null,
           Date.now() - target.etimes * 1000, Date.now());
    if (deleteChat) queueChatDeletion(urlCache.get(pid) ?? null);
    return { ok: true };
  }
  return { ok: false, error: "Bad session id." };
}

export interface ArchivedInfo {
  id: number;
  provider: SessionProvider;
  name: string;
  initial: string;
  project: string | null;
  claudeUrl: string | null;
  remoteControl: boolean;    // how it was launched — a resume rebuilds the same command
  resumeId: string | null;   // local id for `claude --resume <id>` in a terminal
  model: string | null;
  startedAt: number | null;
  endedAt: number;
  workspacePresent: boolean; // its folder still exists on disk
  canResume: boolean;        // its folder still exists, so the conversation can be reopened
}

export function listArchive(): ArchivedInfo[] {
  const rows = db.query(
    "SELECT id, name, project_path, claude_url, resume_id, model, started_at, ended_at, remote_control, provider FROM archive ORDER BY ended_at DESC LIMIT 200",
  ).all() as Array<{ id: number; name: string; project_path: string | null; claude_url: string | null; resume_id: string | null; model: string | null; started_at: number | null; ended_at: number; remote_control: number; provider: SessionProvider }>;
  return rows.map((r) => ({
    id: r.id,
    provider: rowProvider(r.provider),
    name: r.name,
    initial: displayInitial(r.name),
    project: r.project_path,
    claudeUrl: r.claude_url,
    remoteControl: r.remote_control !== 0,
    resumeId: r.resume_id,
    model: r.model,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    workspacePresent: isWorkspacePath(r.project_path) && existsSync(r.project_path!),
    canResume: archiveCanResume(rowProvider(r.provider), r.project_path, r.name, r.resume_id),
  }));
}

/** Can an archived row be reopened? Every provider answers for its own storage. */
function archiveCanResume(provider: SessionProvider, projectPath: string | null, name: string, resumeId: string | null): boolean {
  // A Command has no portable "resume this conversation" contract, so it declines
  // rather than relaunching a fresh session dressed up as the old one (plan R5).
  if (isCommandProvider(provider)) return false;
  if (provider === "codex") return canResumeCodexArchive(projectPath, name, resumeId);
  if (provider === "command-code") return canResumeCommandCodeArchive(projectPath, name, resumeId);
  return canResumeArchived(projectPath, name, resumeId);
}

/**
 * Relaunch an archived session in its original folder, resuming the same
 * conversation: `claude --resume <id>` (or `--continue` when no id was captured)
 * with remote control re-enabled. Does NOT re-clone a workspace — the folder
 * must still exist. Moves the row back out of the archive.
 */
export async function resumeArchived(id: number, expectedProvider: SessionProvider = DEFAULT_SESSION_PROVIDER): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = db.query("SELECT name, project_path, claude_url, resume_id, remote_control, provider FROM archive WHERE id = ?").get(id) as
    { name: string; project_path: string | null; claude_url: string | null; resume_id: string | null; remote_control: number; provider: SessionProvider } | null;
  if (!row) return { ok: false, error: "That session is no longer in history." };
  const provider = rowProvider(row.provider);
  if (provider !== expectedProvider) return { ok: false, error: `That archive belongs to ${providerDisplayName(provider)}.` };
  if (isCommandProvider(provider)) {
    return { ok: false, error: `${providerDisplayName(provider)} has no conversation to resume — start a new session instead.` };
  }
  const name = row.name;
  if (!FULL_NAME_RE.test(name)) return { ok: false, error: "That session name can't be resumed." };
  const proj = row.project_path;
  if (!proj || !existsSync(proj)) {
    return { ok: false, error: "Its folder is gone — nothing to resume into." };
  }
  const screenName = SCREEN_PREFIX + name.toLowerCase();
  const screens = await listScreens();
  if ([...screens.values()].includes(screenName)) {
    return { ok: false, error: `A session named “${name}” is already running.` };
  }

  if (provider === "codex") {
    const resumeId = normalizeCodexResumeId(row.resume_id);
    if (!resumeId) {
      return { ok: false, error: "This Codex session has no exact conversation ID to resume." };
    }
    return startManagedCodex({
      screen: screenName,
      name,
      projectPath: proj,
      resumeId,
      resumeArchiveId: id,
    });
  }

  if (provider === "command-code") {
    const resumeId = normalizeCommandCodeSessionId(row.resume_id);
    if (!resumeId) {
      return { ok: false, error: "This Command Code session has no conversation ID to resume." };
    }
    if (!findCommandCodeTranscript(proj, resumeId)) {
      return { ok: false, error: "That Command Code conversation is gone — nothing left to resume in this folder." };
    }
    return startManagedCommandCode({
      screen: screenName,
      name,
      projectPath: proj,
      resumeId,
      resumeArchiveId: id,
    });
  }

  if (proj.includes("'")) return { ok: false, error: "That project path can't be resumed safely." };
  // The stored conversation may have been deleted since it was archived; resuming a
  // gone transcript would fail and kill the screen silently. Check what survives.
  const rid = row.resume_id && RESUME_ID_RE.test(row.resume_id) ? row.resume_id : null;
  const exactExists = !!rid && existsSync(transcriptPathFor(proj, rid));
  const plan = planResume(exactExists, exactExists || projectHasAnyTranscript(proj));
  if ("blocked" in plan) {
    return { ok: false, error: "That Claude conversation was deleted — nothing left to resume in this folder." };
  }
  const resumeArg = plan.arg === "--resume" ? `--resume '${rid}'` : "--continue";
  const claudeBin = Bun.which("claude") ?? join(homedir(), ".local", "bin", "claude");
  const rc = row.remote_control === 0 ? "" : `--remote-control '${name}' `;
  return startCommunicatingSession({
    screen: screenName, name, projectPath: proj, provider: "claude", remoteControl: row.remote_control ?? 1,
    claudeUrl: row.claude_url, resumeId: row.resume_id, resumeArchiveId: id,
    command: mcp => `cd ${shellQuote(proj)} && exec ${shellQuote(claudeBin)} ${mcp.map(shellQuote).join(" ")} ${resumeArg} ${rc}${claudePermissionArgs()}`,
  });
}

export async function deleteArchived(id: number, deleteWorkspace = false, deleteChat = false): Promise<{ ok: boolean; error?: string }> {
  const row = db.query("SELECT project_path, claude_url, provider FROM archive WHERE id = ?").get(id) as
    { project_path: string | null; claude_url: string | null; provider: SessionProvider } | null;
  if (!row) return { ok: true };
  if (deleteChat && rowProvider(row.provider) !== "claude") {
    return { ok: false, error: "Chat deletion is only available for Claude sessions." };
  }
  if (deleteWorkspace && isWorkspacePath(row.project_path) && !row.project_path!.includes("..")) {
    await run(["rm", "-rf", row.project_path!, `${row.project_path}.setup.log`]);
  }
  if (deleteChat) queueChatDeletion(row.claude_url);
  db.query("DELETE FROM archive WHERE id = ?").run(id);
  return { ok: true };
}

export function clearArchive(): { cleared: number } {
  return { cleared: db.query("DELETE FROM archive").run().changes };
}

export async function killAll(): Promise<{ killed: number }> {
  const sessions = await listSessions();
  const results = await Promise.all(sessions.map((s) => killSession(s.id)));
  return { killed: results.filter((r) => r.ok).length };
}
