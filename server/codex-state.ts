import type { Database } from "bun:sqlite";
import { isAbsolute, normalize } from "node:path";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SCREEN_PATTERN = /^cs-[a-zA-Z0-9._-]{1,96}$/;
const MAX_CWD_LENGTH = 4096;
const MAX_MODEL_LENGTH = 160;
const STALE_ACTIVITY_MS = 30 * 60_000;
const RESUME_IDENTITY_MISMATCH_ERROR = "Codex reported a different conversation than the archived session requested.";

const HOOK_EVENTS = new Set([
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "Stop",
  "SessionEnd",
]);

export type CodexTurnState = "starting" | "working" | "waiting" | "asking" | "ended";

export function isCodexSessionId(value: string): boolean {
  return UUID_PATTERN.test(value);
}

export interface CodexHookInput {
  sessionId: string;
  cwd: string;
  model: string | null;
  event: string;
  source: string | null;
  toolName: string | null;
}

function boundedString(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : null;
}

/**
 * Parse only the documented fields required for lifecycle state. Deliberately
 * discard prompts, tool inputs, transcripts, and every unknown hook property.
 */
export function parseCodexHookInput(value: unknown): CodexHookInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const sessionId = boundedString(input.session_id, 64);
  const cwd = boundedString(input.cwd, MAX_CWD_LENGTH);
  const event = boundedString(input.hook_event_name, 64);
  if (!sessionId || !isCodexSessionId(sessionId) || !cwd || !isAbsolute(cwd) || !event || !HOOK_EVENTS.has(event)) {
    return null;
  }

  const model = input.model == null ? null : boundedString(input.model, MAX_MODEL_LENGTH);
  if (input.model != null && !model) return null;
  const source = input.source == null ? null : boundedString(input.source, 64);
  if (input.source != null && !source) return null;
  const rawToolName = input.tool_name ?? input.toolName;
  const toolName = rawToolName == null ? null : boundedString(rawToolName, 160);
  if (rawToolName != null && !toolName) return null;

  return {
    sessionId: sessionId.toLowerCase(),
    cwd: normalize(cwd),
    model,
    event,
    source,
    toolName,
  };
}

/** Translate hook events to the app's provider-neutral activity vocabulary. */
export function reduceCodexHook(input: CodexHookInput): CodexTurnState | null {
  switch (input.event) {
    case "SessionStart":
      // Compaction happens during a turn; treating it as a new idle session
      // would create a false "waiting" transition.
      return input.source === "compact" ? null : "waiting";
    case "UserPromptSubmit":
      return "working";
    case "PreToolUse":
      return input.toolName === "request_user_input" || input.toolName === "AskUserQuestion"
        ? "asking"
        : null;
    case "PostToolUse":
      return "working";
    case "PermissionRequest":
      return "asking";
    case "Stop":
      return "waiting";
    case "SessionEnd":
      return "ended";
    default:
      return null;
  }
}

interface LaunchBinding {
  screen: string;
  launch_id: string | null;
  project_path: string;
  provider: string;
  resume_archive_id: number | null;
}

/**
 * Apply one normalized hook event only to the exact launch that injected its
 * marker environment. A new non-compaction SessionStart may rebind a launch;
 * every later event must match that bound session UUID.
 */
export function applyCodexHook(
  database: Database,
  screen: string,
  launchId: string,
  input: CodexHookInput,
  now = Date.now(),
): boolean {
  if (!SCREEN_PATTERN.test(screen) || !isCodexSessionId(launchId) || !Number.isFinite(now)) return false;
  const turnState = reduceCodexHook(input);
  if (!turnState) return false;

  const transaction = database.transaction(() => {
    const launch = database.query(
      "SELECT screen, launch_id, project_path, provider, resume_archive_id FROM launches WHERE launch_id = ?",
    ).get(launchId) as LaunchBinding | null;
    if (
      !launch
      || launch.provider !== "codex"
      || launch.screen !== screen
      || launch.launch_id !== launchId
      || normalize(launch.project_path) !== input.cwd
    ) return false;

    if (input.event === "SessionStart") {
      if (launch.resume_archive_id != null) {
        const archive = database.query(
          "SELECT resume_id FROM archive WHERE id = ? AND provider = 'codex'",
        ).get(launch.resume_archive_id) as { resume_id: string | null } | null;
        const expectedSessionId = archive?.resume_id && isCodexSessionId(archive.resume_id)
          ? archive.resume_id.toLowerCase()
          : null;
        if (expectedSessionId !== input.sessionId) {
          database.query(
            "UPDATE launches SET phase = 'failed', error_message = ? WHERE launch_id = ? AND screen = ? AND provider = 'codex'",
          ).run(RESUME_IDENTITY_MISMATCH_ERROR, launchId, screen);
          return false;
        }
      }

      database.query(`
        INSERT INTO codex_launch_state
          (launch_id, screen, session_id, model, turn_state, last_event, canonical_cwd, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(launch_id) DO UPDATE SET
          screen = excluded.screen,
          session_id = excluded.session_id,
          model = excluded.model,
          turn_state = excluded.turn_state,
          last_event = excluded.last_event,
          canonical_cwd = excluded.canonical_cwd,
          updated_at = excluded.updated_at
      `).run(launchId, screen, input.sessionId, input.model, turnState, input.event, input.cwd, now);
      database.query(
        "UPDATE launches SET resume_id = ?, phase = 'ready', error_message = NULL WHERE launch_id = ? AND screen = ? AND provider = 'codex'",
      ).run(input.sessionId, launchId, screen);

      // A resume is proven only when Codex itself reports SessionStart for the
      // exact UUID. Until then the archive remains available for another try.
      if (launch.resume_archive_id != null) {
        // The archive identity was normalized and proven above, so delete by
        // its stable row id rather than relying on UUID text casing.
        const deleted = database.query(
          "DELETE FROM archive WHERE id = ? AND provider = 'codex'",
        ).run(launch.resume_archive_id);
        if (deleted.changes === 1) {
          database.query(
            "UPDATE launches SET resume_archive_id = NULL WHERE launch_id = ?",
          ).run(launchId);
        }
      }
      return true;
    }

    const changed = database.query(`
      UPDATE codex_launch_state
      SET model = COALESCE(?, model), turn_state = ?, last_event = ?, updated_at = ?
      WHERE launch_id = ? AND screen = ? AND session_id = ? AND canonical_cwd = ?
    `).run(input.model, turnState, input.event, now, launchId, screen, input.sessionId, input.cwd);
    return changed.changes === 1;
  });

  try {
    return transaction();
  } catch {
    return false;
  }
}

export interface CodexActivity {
  busy: boolean;
  waiting: boolean;
  asking: boolean;
  telemetryUnknown: boolean;
}

export function codexActivity(turnState: string | null, updatedAt: number | null, now = Date.now()): CodexActivity {
  if (updatedAt == null || !Number.isFinite(updatedAt) || now - updatedAt > STALE_ACTIVITY_MS) {
    return { busy: false, waiting: false, asking: false, telemetryUnknown: true };
  }
  return {
    busy: turnState === "working",
    waiting: turnState === "waiting",
    asking: turnState === "asking",
    telemetryUnknown: false,
  };
}
