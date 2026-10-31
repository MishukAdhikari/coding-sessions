import { childEnvironment } from "./child-env";
import { accessSync, constants, lstatSync } from "node:fs";
import { isAbsolute, normalize } from "node:path";
import { isCodexSessionId } from "./codex-state";

export const MINIMUM_CODEX_VERSION = [0, 166, 0] as const;
export const CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS = 5_000;
export const CODEX_REQUIREMENTS_PATH = "/etc/codex/requirements.toml";
export const CODEX_MANAGED_BUN_PATH = "/usr/local/lib/xcloud-sessions/bin/bun";
export const CODEX_MANAGED_HOOK_DIR = "/usr/local/lib/xcloud-sessions/codex-hooks";
export const CODEX_MANAGED_HOOK_PATH = `${CODEX_MANAGED_HOOK_DIR}/codex-hook.ts`;
export const CODEX_MANAGED_STATE_PATH = `${CODEX_MANAGED_HOOK_DIR}/codex-state.ts`;
export const CODEX_MANAGED_HOOK_COMMAND = `${CODEX_MANAGED_BUN_PATH} ${CODEX_MANAGED_HOOK_PATH}`;

const SCREEN_PATTERN = /^cs-[a-zA-Z0-9._-]{1,96}$/;
const BIN_PATTERN = /^(?:\/[a-zA-Z0-9._+@%/-]+|[a-zA-Z0-9._+-]+)$/;
const REQUIRED_CODEX_HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
] as const;

const MANAGED_HOOK_POLICY: Record<typeof REQUIRED_CODEX_HOOK_EVENTS[number], {
  matcher: string | null;
  timeout: number;
}> = {
  SessionStart: { matcher: "^(startup|resume|clear|compact)$", timeout: 5 },
  UserPromptSubmit: { matcher: null, timeout: 5 },
  PreToolUse: { matcher: "^(request_user_input|AskUserQuestion)$", timeout: 5 },
  PostToolUse: { matcher: "^(request_user_input|AskUserQuestion)$", timeout: 5 },
  PermissionRequest: { matcher: null, timeout: 5 },
  Stop: { matcher: null, timeout: 5 },
  SessionEnd: { matcher: null, timeout: 3 },
};

export interface CodexInvocation {
  argv: string[];
  env: Record<string, string>;
}

export interface CodexInvocationOptions {
  bin: string;
  cwd: string;
  screen: string;
  launchId: string;
  dbPath: string;
  resumeId?: string | null;
  unrestricted?: boolean;
  mcpArgs?: string[];
}

/** Build an argv vector; callers must never reconstruct it from a shell string. */
export function buildCodexInvocation(options: CodexInvocationOptions): CodexInvocation | null {
  const { bin, cwd, screen, launchId, dbPath, resumeId } = options;
  if (
    !BIN_PATTERN.test(bin)
    || !isAbsolute(cwd)
    || cwd.length > 4096
    || !SCREEN_PATTERN.test(screen)
    || !isCodexSessionId(launchId)
    || !isAbsolute(dbPath)
    || dbPath.length > 4096
    || (resumeId != null && !isCodexSessionId(resumeId))
  ) return null;

  const argv = [bin, "--no-daemon", ...(options.unrestricted ? ["--dangerously-bypass-approvals-and-sandbox"] : []), "-C", normalize(cwd)];
  if (options.unrestricted) {
    // Use a table value: Codex splits dotted override keys even inside quoted paths.
    const projectKey = JSON.stringify(normalize(cwd)).replace(/\x7f/g, "\\u007f");
    argv.push("-c", `projects={${projectKey}={trust_level="trusted"}}`);
  }
  if (options.mcpArgs) argv.push(...options.mcpArgs);
  if (resumeId) argv.push("resume", resumeId.toLowerCase());
  return {
    argv,
    env: {
      CS_DB_PATH: normalize(dbPath),
      CS_LAUNCH_ID: launchId.toLowerCase(),
      CS_SCREEN: screen,
    },
  };
}

export function parseCodexVersion(output: string): [number, number, number] | null {
  const match = output.match(/(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:[-+\s]|$)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionAtLeast(actual: readonly number[], minimum: readonly number[]): boolean {
  for (let index = 0; index < 3; index++) {
    const difference = (actual[index] ?? 0) - (minimum[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }
  return true;
}

function hasManagedHookConfiguration(text: string | null): boolean {
  if (!text) return false;
  try {
    const config = Bun.TOML.parse(text) as Record<string, unknown>;
    const features = config.features as Record<string, unknown> | undefined;
    const hooks = config.hooks as Record<string, unknown> | undefined;
    if (features?.hooks !== true || hooks?.managed_dir !== CODEX_MANAGED_HOOK_DIR) return false;

    const configuredEvents = Object.keys(hooks).filter((key) => key !== "managed_dir");
    if (configuredEvents.some((event) => !REQUIRED_CODEX_HOOK_EVENTS.includes(
      event as typeof REQUIRED_CODEX_HOOK_EVENTS[number],
    ))) return false;

    for (const event of REQUIRED_CODEX_HOOK_EVENTS) {
      const groups = hooks[event];
      const policy = MANAGED_HOOK_POLICY[event];
      if (!Array.isArray(groups) || groups.length !== 1 || !groups.every((group: unknown) => {
        if (!group || typeof group !== "object") return false;
        const hookGroup = group as Record<string, unknown>;
        if ((hookGroup.matcher ?? null) !== policy.matcher) return false;
        const handlers = hookGroup.hooks;
        return Array.isArray(handlers) && handlers.length === 1 && handlers.every((handler: unknown) => {
          if (!handler || typeof handler !== "object") return false;
          const configured = handler as Record<string, unknown>;
          return configured.type === "command"
            && configured.command === CODEX_MANAGED_HOOK_COMMAND
            && configured.timeout === policy.timeout;
        });
      })) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export interface CommandResult {
  code: number;
  out: string;
  err: string;
  timedOut?: boolean;
}

export interface CodexManagedPathInspection {
  uid: number;
  mode: number;
  kind: "file" | "directory" | "symlink" | "other";
  executable: boolean;
}

export interface CodexPreflightDependencies {
  which: () => string | null | Promise<string | null>;
  run: (argv: string[], timeoutMs: number) => Promise<CommandResult>;
  readText: (path: string) => string | null | Promise<string | null>;
  inspectPath: (path: string) => CodexManagedPathInspection | null | Promise<CodexManagedPathInspection | null>;
}

export type CodexPreflightCode =
  | "missing_binary"
  | "unsupported_version"
  | "not_authenticated"
  | "hooks_unavailable"
  | "managed_hook_missing"
  | "managed_hook_untrusted"
  | "command_timeout";

export type CodexPreflightResult =
  | { ok: true; bin: string; version: string }
  | { ok: false; code: CodexPreflightCode; message: string };

async function defaultRun(argv: string[], timeoutMs: number): Promise<CommandResult> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    const process = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe", env: childEnvironment() });
    const completed = Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]).then(([code, out, err]) => ({ code, out, err, timedOut: false }));
    const deadline = new Promise<CommandResult>((resolve) => {
      timeout = setTimeout(() => {
        try { process.kill(9); } catch { /* The process may have exited at the deadline. */ }
        resolve({ code: 124, out: "", err: "Codex preflight command timed out", timedOut: true });
      }, timeoutMs);
    });
    return await Promise.race([completed, deadline]);
  } catch (error) {
    return {
      code: 127,
      out: "",
      err: error instanceof Error ? error.message : "Command failed",
      timedOut: false,
    };
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function inspectManagedPath(path: string): CodexManagedPathInspection | null {
  try {
    const stats = lstatSync(path);
    let executable = false;
    try {
      accessSync(path, constants.X_OK);
      executable = true;
    } catch {
      // The service user must be able to execute the pinned interpreter.
    }
    return {
      uid: stats.uid,
      mode: stats.mode,
      kind: stats.isSymbolicLink()
        ? "symlink"
        : stats.isFile()
          ? "file"
          : stats.isDirectory()
            ? "directory"
            : "other",
      executable,
    };
  } catch {
    return null;
  }
}

export const defaultCodexPreflightDependencies: CodexPreflightDependencies = {
  which: () => Bun.which("codex"),
  run: defaultRun,
  readText: async (path) => {
    try {
      const file = Bun.file(path);
      return await file.exists() ? await file.text() : null;
    } catch {
      return null;
    }
  },
  inspectPath: inspectManagedPath,
};

interface ManagedPathExpectation {
  kind: "file" | "directory";
  executable: boolean;
}

type ManagedPathTrustResult =
  | { ok: true }
  | { ok: false; missing: boolean; path: string; reason: string };

function absolutePathComponents(path: string): string[] {
  const components = normalize(path).split("/").filter(Boolean);
  const paths = ["/"];
  let current = "";
  for (const component of components) {
    current += `/${component}`;
    paths.push(current);
  }
  return paths;
}

function managedPathExpectations(): Map<string, ManagedPathExpectation> {
  const expectations = new Map<string, ManagedPathExpectation>();
  for (const target of [
    CODEX_REQUIREMENTS_PATH,
    CODEX_MANAGED_BUN_PATH,
    CODEX_MANAGED_HOOK_PATH,
    CODEX_MANAGED_STATE_PATH,
  ]) {
    const components = absolutePathComponents(target);
    for (let index = 0; index < components.length; index++) {
      const path = components[index]!;
      const terminal = index === components.length - 1;
      expectations.set(path, {
        kind: terminal ? "file" : "directory",
        executable: terminal && target === CODEX_MANAGED_BUN_PATH,
      });
    }
  }
  return expectations;
}

async function verifyManagedPathTrust(
  inspectPath: CodexPreflightDependencies["inspectPath"],
): Promise<ManagedPathTrustResult> {
  for (const [path, expected] of managedPathExpectations()) {
    const inspection = await inspectPath(path);
    if (!inspection) return { ok: false, missing: true, path, reason: "path is missing" };
    if (inspection.kind === "symlink") {
      return { ok: false, missing: false, path, reason: "symbolic links are not allowed" };
    }
    if (inspection.kind !== expected.kind) {
      return { ok: false, missing: false, path, reason: `expected a regular ${expected.kind}` };
    }
    if (inspection.uid !== 0) {
      return { ok: false, missing: false, path, reason: "path is not owned by root" };
    }
    if ((inspection.mode & 0o022) !== 0) {
      return { ok: false, missing: false, path, reason: "path is group- or world-writable" };
    }
    if (expected.executable && !inspection.executable) {
      return { ok: false, missing: false, path, reason: "interpreter is not executable by the service user" };
    }
  }
  return { ok: true };
}

function commandTimeout(operation: string): CodexPreflightResult {
  return {
    ok: false,
    code: "command_timeout",
    message: `Codex preflight timed out while ${operation}. Run the corresponding Codex command as the service user and resolve the hang before retrying.`,
  };
}

/** Verify the stable CLI and the root-managed lifecycle hook before launch. */
export async function preflightCodex(
  dependencies: CodexPreflightDependencies = defaultCodexPreflightDependencies,
): Promise<CodexPreflightResult> {
  const bin = await dependencies.which();
  if (!bin) {
    return { ok: false, code: "missing_binary", message: "Codex CLI is not installed for the service user." };
  }

  const versionResult = await dependencies.run([bin, "--version"], CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS);
  if (versionResult.timedOut) return commandTimeout("checking the CLI version");
  const version = parseCodexVersion(`${versionResult.out}\n${versionResult.err}`);
  if (versionResult.code !== 0 || !version || !versionAtLeast(version, MINIMUM_CODEX_VERSION)) {
    return {
      ok: false,
      code: "unsupported_version",
      message: `Codex CLI ${MINIMUM_CODEX_VERSION.join(".")} or newer is required.`,
    };
  }

  const login = await dependencies.run([bin, "login", "status"], CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS);
  if (login.timedOut) return commandTimeout("checking login status");
  if (login.code !== 0) {
    return { ok: false, code: "not_authenticated", message: "Codex is not authenticated for the service user." };
  }

  const features = await dependencies.run([bin, "features", "list"], CODEX_PREFLIGHT_COMMAND_TIMEOUT_MS);
  if (features.timedOut) return commandTimeout("checking stable hook support");
  if (features.code !== 0 || !/^hooks\s+stable\s+true\s*$/m.test(`${features.out}\n${features.err}`)) {
    return { ok: false, code: "hooks_unavailable", message: "This Codex CLI does not expose stable hooks." };
  }

  const pathTrust = await verifyManagedPathTrust(dependencies.inspectPath);
  if (!pathTrust.ok) {
    return {
      ok: false,
      code: pathTrust.missing ? "managed_hook_missing" : "managed_hook_untrusted",
      message: `The managed Codex hook trust check failed for ${pathTrust.path}: ${pathTrust.reason}. Reinstall the managed hook chain as root before retrying.`,
    };
  }

  const [requirements, hook, stateReducer] = await Promise.all([
    dependencies.readText(CODEX_REQUIREMENTS_PATH),
    dependencies.readText(CODEX_MANAGED_HOOK_PATH),
    dependencies.readText(CODEX_MANAGED_STATE_PATH),
  ]);
  if (requirements == null || hook == null || stateReducer == null) {
    return {
      ok: false,
      code: "managed_hook_missing",
      message: "The xCloud Sessions managed Codex hook is not provisioned by an administrator.",
    };
  }
  if (!hasManagedHookConfiguration(requirements)) {
    return {
      ok: false,
      code: "managed_hook_untrusted",
      message: "The managed Codex hook configuration does not contain only the exact administrator-managed command. Reinstall /etc/codex/requirements.toml as root before retrying.",
    };
  }

  return { ok: true, bin, version: version.join(".") };
}
