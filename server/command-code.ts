/**
 * Command Code — the third built-in provider.
 *
 * What this agent can and cannot deliver is decided by two facts about its CLI.
 * It persists every conversation as `~/.commandcode/projects/<munged-cwd>/<uuid>.jsonl`
 * and will reopen one by id, so exact resume is real here — unlike a registered
 * Command, which has no portable resume contract and honestly declines. It ships
 * no lifecycle hook this app can subscribe to, so turn state is not real here —
 * liveness and CPU are the only honest signals, and `semanticStatus` says so.
 *
 * Everything below builds an argv, never a shell string, and the credential is
 * handed over through the environment: `/proc/<pid>/cmdline` is world-readable.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, normalize } from "node:path";
import type { Database } from "bun:sqlite";
import { db } from "./db";
import { childEnvironment } from "./child-env";
import { sealSecret, openSecret, type SecretCodec } from "./secrets";

export const MINIMUM_COMMAND_CODE_VERSION = [1, 28, 0] as const;
export const COMMAND_CODE_PREFLIGHT_COMMAND_TIMEOUT_MS = 8_000;
export const COMMAND_CODE_HOME = join(homedir(), ".commandcode");
export const COMMAND_CODE_PROJECTS_DIR = join(COMMAND_CODE_HOME, "projects");
/** The env var the CLI reads its credential from — its own documented name. */
export const COMMAND_CODE_API_KEY_ENV = "COMMAND_CODE_API_KEY";
/** Where the operator's key lives. Write-only: no route ever reads it back out. */
export const COMMAND_CODE_TOKEN_KEY = "command_code_api_key";

const TOKEN_MAX = 4096;
/**
 * An absolute path may contain spaces — npm puts this CLI under "Application
 * Support" on a developer's Mac — because every token is quoted exactly once at
 * the shell boundary. Control characters never survive a command line intact, and
 * a bare name has to look like a name so argv[0] cannot smuggle an argument.
 */
const isLaunchableBin = (bin: string) =>
  bin.length <= 4096
  && (/^\/[^\u0000-\u001f\u007f]+$/.test(bin) || /^[a-zA-Z0-9._+-]+$/.test(bin));
const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,42}$/;
const SESSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const hasControlChars = (value: string) => /[\u0000-\u001f\u007f]/.test(value);

/** A conversation id is a UUID; anything else must never reach `--session`. */
export function normalizeCommandCodeSessionId(value: unknown): string | null {
  return typeof value === "string" && SESSION_ID_RE.test(value) ? value.toLowerCase() : null;
}

export const isCommandCodeSessionId = (value: unknown): value is string =>
  normalizeCommandCodeSessionId(value) !== null;

/* ---------- launch ---------- */

export interface CommandCodeInvocationOptions {
  bin: string;
  cwd: string;
  /** The Session name. Passed as `-n` so the agent stamps it into the session's meta. */
  name: string;
  resumeId?: string | null;
  unrestricted?: boolean;
}

/** Standard launches preserve CLI trust and approval prompts. */
export function buildCommandCodeInvocation(options: CommandCodeInvocationOptions): string[] | null {
  const { bin, cwd, name, resumeId } = options;
  const resume = resumeId == null ? null : normalizeCommandCodeSessionId(resumeId);
  if (
    !isLaunchableBin(bin)
    || !isAbsolute(cwd)
    || cwd.length > 4096
    || !NAME_PATTERN.test(name)
    || (resumeId != null && !resume)
  ) return null;

  const argv = [bin, ...(options.unrestricted === true ? ["--trust", "--yolo"] : []), "--no-auto-update", "-n", name];
  if (resume) argv.push("--session", resume);
  return argv;
}

/* ---------- process recognition ---------- */

const COMMAND_CODE_BINS = new Set(["command-code", "commandcode", "cmdc", "cmd"]);
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno"]);
const basename = (token: string) => token.slice(token.lastIndexOf("/") + 1);

/**
 * Recognise the agent inside a managed screen.
 *
 * Command Code rewrites its own process title seconds after exec, so `ps` stops
 * showing an argv at all and starts showing "<glyph> Command Code · <folder>".
 * Both shapes are therefore live: the interpreter argv during startup, the title
 * for the rest of the session's life. Matching either is safe because this only
 * ever runs against descendants of a screen a `command-code` launch row owns.
 */
export function isCommandCodeProc(args: string): boolean {
  const value = args.trim();
  if (!value) return false;
  if (/^(?:\S{1,4}\s+)?Command Code(?:\s|$)/.test(value)) return true;

  const tokens = value.split(/\s+/).filter(Boolean);
  const head = basename(tokens[0] ?? "");
  if (COMMAND_CODE_BINS.has(head)) return true;
  // `#!/usr/bin/env node` means the script path is argv[1] until the title lands.
  return INTERPRETERS.has(head) && tokens.slice(1, 3).some((token) => COMMAND_CODE_BINS.has(basename(token)));
}

/* ---------- conversation discovery ---------- */

/**
 * The agent's own name for a project directory: the absolute path kebab-cased,
 * camel humps split ("/Users/me/Code/xCloud" → "users-me-code-x-cloud").
 *
 * This is a fast path, never a source of truth — `findCommandCodeSessionId` falls
 * back to every project directory if this one holds nothing, so a change to the
 * agent's naming costs a directory scan rather than a broken resume.
 */
export function commandCodeProjectDirName(cwd: string): string {
  return cwd
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface CommandCodeFsDependencies {
  listDirs: (dir: string) => string[];
  listFiles: (dir: string) => string[];
  readText: (path: string) => string | null;
  mtimeMs: (path: string) => number | null;
}

const listEntries = (dir: string, wantDirectory: boolean): string[] => {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => (wantDirectory ? entry.isDirectory() : entry.isFile()))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

export const defaultCommandCodeFs: CommandCodeFsDependencies = {
  listDirs: (dir) => listEntries(dir, true),
  listFiles: (dir) => listEntries(dir, false),
  readText: (path) => {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
  mtimeMs: (path) => {
    try { return statSync(path).mtimeMs; } catch { return null; }
  },
};

/** Project directories to search: the derived one first, then everything else. */
function candidateDirs(cwd: string, fs: CommandCodeFsDependencies): string[] {
  const derived = commandCodeProjectDirName(cwd);
  const all = fs.listDirs(COMMAND_CODE_PROJECTS_DIR);
  const ordered = all.includes(derived) ? [derived, ...all.filter((name) => name !== derived)] : all;
  return ordered.map((name) => join(COMMAND_CODE_PROJECTS_DIR, name));
}

/**
 * Find the conversation id a launch actually created.
 *
 * The agent writes `<uuid>.meta.json` holding the `-n` title as soon as it boots —
 * before any message exists — so a session is identifiable from the moment it is
 * live. A candidate must carry this launch's name *and* be no older than the
 * launch itself, or relaunching a name would adopt the previous conversation's id
 * and "resume" would silently reopen the wrong history.
 */
export function findCommandCodeSessionId(
  cwd: string,
  name: string,
  startedAtMs: number,
  fs: CommandCodeFsDependencies = defaultCommandCodeFs,
): string | null {
  const floor = startedAtMs - 5_000; // clock slack between our timestamp and the agent's write
  for (const dir of candidateDirs(cwd, fs)) {
    const found = newestSessionIn(dir, name, floor, fs);
    if (found) return found; // the derived directory is searched first
  }
  return null;
}

/** The newest conversation in one project directory carrying this launch's name. */
function newestSessionIn(
  dir: string,
  name: string,
  floorMs: number,
  fs: CommandCodeFsDependencies,
): string | null {
  let best: { id: string; at: number } | null = null;
  for (const file of fs.listFiles(dir)) {
    if (!file.endsWith(".meta.json")) continue;
    const id = normalizeCommandCodeSessionId(file.slice(0, -".meta.json".length));
    if (!id) continue;
    const at = fs.mtimeMs(join(dir, file));
    if (at == null || at < floorMs) continue;
    const raw = fs.readText(join(dir, file));
    if (!raw) continue;
    let title: unknown;
    try { title = (JSON.parse(raw) as Record<string, unknown>).title; } catch { continue; }
    if (title !== name) continue;
    if (best === null || at > best.at) best = { id, at };
  }
  return best === null ? null : best.id;
}

/**
 * The transcript for a conversation, if one survives. A session that was launched
 * and never spoken to has a meta file but no transcript, and `--session` on a
 * conversation with no transcript is a launch that dies inside a detached screen.
 */
export function findCommandCodeTranscript(
  cwd: string,
  sessionId: string,
  fs: CommandCodeFsDependencies = defaultCommandCodeFs,
): string | null {
  const id = normalizeCommandCodeSessionId(sessionId);
  if (!id) return null;
  for (const dir of candidateDirs(cwd, fs)) {
    const file = fs.listFiles(dir).find((entry) => entry.toLowerCase() === `${id}.jsonl`);
    if (file) return join(dir, file);
  }
  return null;
}

/**
 * The model a session is actually running, read from the last one its transcript
 * recorded. Vendor-qualified ids ("deepseek/deepseek-v4-pro") lose only the
 * routing prefix — this agent runs open models whose names are the useful half.
 */
export function commandCodeModel(transcriptTail: string): string | null {
  const matches = [...transcriptTail.matchAll(/"model"\s*:\s*"([^"]{1,80})"/g)];
  const raw = matches.at(-1)?.[1] ?? null;
  if (!raw) return null;
  const trimmed = raw.slice(raw.lastIndexOf("/") + 1).trim();
  return trimmed || null;
}

/* ---------- credential ---------- */

/**
 * Store the operator's API key. Write-only by design, exactly like a Command's
 * token: no route returns it, the UI is told only whether one is set, and it
 * reaches the agent through the environment rather than a command line.
 */
export function setCommandCodeToken(token: unknown, database: Database = db, secrets: SecretCodec = { sealSecret, openSecret }): { ok: true } | { ok: false; error: string } {
  const value = String(token ?? "").trim();
  if (!value) return { ok: false, error: "Paste an API key to store." };
  if (value.length > TOKEN_MAX) return { ok: false, error: "That API key is implausibly long." };
  if (hasControlChars(value)) return { ok: false, error: "That API key contains control characters." };
  database.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(COMMAND_CODE_TOKEN_KEY, secrets.sealSecret(value, `command-code:${COMMAND_CODE_API_KEY_ENV}`));
  return { ok: true };
}

export function clearCommandCodeToken(database: Database = db): boolean {
  return database.query("DELETE FROM meta WHERE key = ?").run(COMMAND_CODE_TOKEN_KEY).changes > 0;
}

function storedToken(database: Database = db): string | null {
  const row = database.query("SELECT value FROM meta WHERE key = ?").get(COMMAND_CODE_TOKEN_KEY) as
    { value: string } | null;
  const value = row?.value?.trim();
  return value ? value : null;
}

export const hasCommandCodeToken = (database: Database = db): boolean => storedToken(database) !== null;

/** The environment a Command Code session starts with — empty when no key is stored. */
export function commandCodeEnv(database: Database = db, secrets: SecretCodec = { sealSecret, openSecret }): Record<string, string> {
  const token = storedToken(database);
  return token ? { [COMMAND_CODE_API_KEY_ENV]: secrets.openSecret(token, `command-code:${COMMAND_CODE_API_KEY_ENV}`) } : {};
}

/* ---------- preflight ---------- */

export function parseCommandCodeVersion(output: string): [number, number, number] | null {
  const match = output.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < 3; index++) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

export interface CommandResult { code: number; out: string; err: string; timedOut?: boolean }

export interface CommandCodePreflightDependencies {
  which: () => string | null | Promise<string | null>;
  run: (argv: string[], timeoutMs: number, env?: Record<string, string>) => Promise<CommandResult>;
  env: () => Record<string, string>;
}

export type CommandCodePreflightCode =
  | "missing_binary"
  | "unsupported_version"
  | "not_authenticated"
  | "command_timeout";

export type CommandCodePreflightResult =
  | { ok: true; bin: string; version: string }
  | { ok: false; code: CommandCodePreflightCode; message: string };

async function defaultRun(argv: string[], timeoutMs: number, env?: Record<string, string>): Promise<CommandResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const child = Bun.spawn(argv, {
      stdout: "pipe",
      stderr: "pipe",
      env: childEnvironment(env),
    });
    const completed = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([code, out, err]) => ({ code, out, err, timedOut: false }));
    const deadline = new Promise<CommandResult>((resolve) => {
      timeout = setTimeout(() => {
        try { child.kill(9); } catch { /* it may have exited at the deadline */ }
        resolve({ code: 124, out: "", err: "Command Code preflight timed out", timedOut: true });
      }, timeoutMs);
    });
    return await Promise.race([completed, deadline]);
  } catch (error) {
    return { code: 127, out: "", err: error instanceof Error ? error.message : "Command failed", timedOut: false };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export const defaultCommandCodePreflightDependencies: CommandCodePreflightDependencies = {
  which: () => Bun.which("command-code"),
  run: defaultRun,
  env: () => commandCodeEnv(),
};

function commandTimeout(operation: string): CommandCodePreflightResult {
  return {
    ok: false,
    code: "command_timeout",
    message: `Command Code preflight timed out while ${operation}. Run that command as the service user and resolve the hang before retrying.`,
  };
}

/**
 * Verify the CLI before a launch that would otherwise die inside a detached screen.
 *
 * The auth check runs `status` under the same environment the session will get, so
 * a stored key is validated as the credential it will actually be — not merely
 * present in the database. A box signed in with `command-code login` passes with no
 * key stored at all; that is the same posture Codex takes.
 */
export async function preflightCommandCode(
  dependencies: CommandCodePreflightDependencies = defaultCommandCodePreflightDependencies,
): Promise<CommandCodePreflightResult> {
  const bin = await dependencies.which();
  if (!bin) {
    return {
      ok: false,
      code: "missing_binary",
      message: "The Command Code CLI is not installed for the service user (npm i -g command-code).",
    };
  }

  // `--no-auto-update` on the probes too: a preflight asks the box a question, and
  // must never be the thing that starts an `npm i -g` rewriting the binary mid-check.
  const versionResult = await dependencies.run([bin, "--no-auto-update", "--version"], COMMAND_CODE_PREFLIGHT_COMMAND_TIMEOUT_MS);
  if (versionResult.timedOut) return commandTimeout("checking the CLI version");
  const version = parseCommandCodeVersion(`${versionResult.out}\n${versionResult.err}`);
  if (versionResult.code !== 0 || !version || !versionAtLeast(version, MINIMUM_COMMAND_CODE_VERSION)) {
    return {
      ok: false,
      code: "unsupported_version",
      message: `Command Code ${MINIMUM_COMMAND_CODE_VERSION.join(".")} or newer is required.`,
    };
  }

  const status = await dependencies.run(
    [bin, "--no-auto-update", "status"],
    COMMAND_CODE_PREFLIGHT_COMMAND_TIMEOUT_MS,
    dependencies.env(),
  );
  if (status.timedOut) return commandTimeout("checking authentication status");
  if (status.code !== 0) {
    return {
      ok: false,
      code: "not_authenticated",
      message: "Command Code is not authenticated on this server. Store an API key in Agent authentication.",
    };
  }

  return { ok: true, bin: normalize(bin), version: version.join(".") };
}
