import { expect, test } from "bun:test";
import { sessionActivity } from "./session-activity";
import type { SessionInfo } from "./sessions";
import { applyCodexHook, codexActivity, parseCodexHookInput } from "./codex-state";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";

const session = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
  id: "m:cs-demo", kind: "managed", provider: "claude", launchId: null, phase: "ready",
  errorMessage: null, name: "demo", status: "running", workspace: false, project: null,
  projectLabel: null, pid: 1, uptimeSec: 1, cpu: 0, active: false, busy: false,
  waiting: false, asking: false, telemetryUnknown: false, claudeUrl: null,
  remoteControl: false, resumeId: null, model: null, initial: "D", ...overrides,
});

test("lifecycle, evidence and question take priority over busy flags", () => {
  expect(sessionActivity(session({ busy: true }))).toBe("running");
  expect(sessionActivity(session({ busy: true, asking: true }))).toBe("waiting");
  expect(sessionActivity(session({ waiting: true }))).toBe("finished");
  expect(sessionActivity(session({ busy: true, telemetryUnknown: true }))).toBe("connected");
  expect(sessionActivity(session({ busy: true, status: "starting" }))).toBe("starting");
  expect(sessionActivity(session({ busy: true, status: "ended" }))).toBe("ended");
  expect(sessionActivity(session({ status: "ended", phase: "failed" }))).toBe("failed");
});

test("hookless providers never infer progress or completion from CPU flags", () => {
  for (const provider of ["command-code", "cmd:custom"] as const) {
    expect(sessionActivity(session({ provider, busy: true, waiting: true }))).toBe("connected");
  }
});

test("Codex hook lifecycle distinguishes ready, work, input and a finished turn", () => {
  const db = new Database(":memory:");
  applyDatabaseSchema(db);
  const launchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  db.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase) VALUES ('cs-demo', 'demo', '/srv/demo', 1, 'codex', ?, 'awaiting_session_start')").run(launchId);
  for (const [event, expected] of [
    ["SessionStart", "ready"], ["UserPromptSubmit", "running"],
    ["PermissionRequest", "waiting"], ["PostToolUse", "running"],
    ["Stop", "finished"], ["UserPromptSubmit", "running"],
  ]) {
    const input = parseCodexHookInput({ session_id: sessionId, cwd: "/srv/demo", hook_event_name: event })!;
    expect(applyCodexHook(db, "cs-demo", launchId, input, 1000)).toBe(true);
    const row = db.query("SELECT turn_state, last_event, updated_at FROM codex_launch_state").get() as { turn_state: string; last_event: string; updated_at: number };
    const flags = codexActivity(row.turn_state, row.updated_at, 1000);
    expect(sessionActivity(session({ provider: "codex", ...flags, turnComplete: row.last_event === "Stop" }))).toBe(expected);
  }
  db.close();
});

test("confirmed pre-hook folder trust waits for input without claiming readiness", () => {
  const pending = session({ provider: "codex", phase: "awaiting_session_start", status: "starting", startupWaitingForTrust: true, telemetryUnknown: true });
  expect(sessionActivity(pending)).toBe("waiting");
  expect(sessionActivity({ ...pending, phase: "failed" })).toBe("failed");
  expect(sessionActivity({ ...pending, status: "ended" })).toBe("ended");
  expect(sessionActivity({ ...pending, startupWaitingForTrust: false })).toBe("starting");
});
