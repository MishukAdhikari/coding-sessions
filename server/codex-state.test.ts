import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import {
  applyCodexHook,
  codexActivity,
  parseCodexHookInput,
  reduceCodexHook,
} from "./codex-state";

const launchId = "019fb1b3-f208-73f2-ba13-0665f58ae4a0";
const sessionId = "019fb1c0-aaaa-7bbb-8ccc-0123456789ab";

function hook(event: string, extra: Record<string, unknown> = {}) {
  return {
    session_id: sessionId,
    cwd: "/srv/project",
    model: "gpt-5.6",
    hook_event_name: event,
    ...extra,
  };
}

test("validates documented hook fields without retaining prompt or tool payload", () => {
  expect(parseCodexHookInput(hook("UserPromptSubmit", { prompt: "secret" }))).toEqual({
    sessionId,
    cwd: "/srv/project",
    model: "gpt-5.6",
    event: "UserPromptSubmit",
    source: null,
    toolName: null,
  });
  expect(parseCodexHookInput({ ...hook("Stop"), session_id: "not-a-uuid" })).toBeNull();
  expect(parseCodexHookInput({ ...hook("Stop"), cwd: "relative" })).toBeNull();
  expect(parseCodexHookInput({ ...hook("MadeUp") })).toBeNull();
});

test("reduces the managed Codex lifecycle to normalized activity", () => {
  expect(reduceCodexHook(parseCodexHookInput(hook("SessionStart", { source: "startup" }))!)).toBe("waiting");
  expect(reduceCodexHook(parseCodexHookInput(hook("UserPromptSubmit"))!)).toBe("working");
  expect(reduceCodexHook(parseCodexHookInput(hook("PreToolUse", { tool_name: "request_user_input" }))!)).toBe("asking");
  expect(reduceCodexHook(parseCodexHookInput(hook("PreToolUse", { tool_name: "AskUserQuestion" }))!)).toBe("asking");
  expect(reduceCodexHook(parseCodexHookInput(hook("PostToolUse", { tool_name: "request_user_input" }))!)).toBe("working");
  expect(reduceCodexHook(parseCodexHookInput(hook("PermissionRequest"))!)).toBe("asking");
  expect(reduceCodexHook(parseCodexHookInput(hook("PreToolUse", { tool_name: "Bash" }))!)).toBeNull();
  expect(reduceCodexHook(parseCodexHookInput(hook("Stop"))!)).toBe("waiting");
  expect(reduceCodexHook(parseCodexHookInput(hook("SessionEnd"))!)).toBe("ended");
  expect(reduceCodexHook(parseCodexHookInput(hook("SessionStart", { source: "compact" }))!)).toBeNull();
});

test("hook writes are scoped to the current provider, screen, launch, cwd, and session", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run("cs-demo", "demo", "/srv/project", 1, "codex", launchId, "awaiting_session_start");

  const start = parseCodexHookInput(hook("SessionStart", { source: "startup" }))!;
  expect(applyCodexHook(database, "cs-demo", launchId, start, 10)).toBe(true);
  expect(database.query("SELECT resume_id, phase FROM launches WHERE screen = 'cs-demo'").get()).toEqual({
    resume_id: sessionId,
    phase: "ready",
  });
  expect(database.query("SELECT session_id, turn_state, model FROM codex_launch_state").get()).toEqual({
    session_id: sessionId,
    turn_state: "waiting",
    model: "gpt-5.6",
  });

  expect(applyCodexHook(database, "cs-other", launchId, parseCodexHookInput(hook("Stop"))!, 11)).toBe(false);
  expect(applyCodexHook(database, "cs-demo", "019fb1b3-f208-73f2-ba13-0665f58ae4ff", parseCodexHookInput(hook("Stop"))!, 12)).toBe(false);
  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput({ ...hook("Stop"), cwd: "/srv/other" })!, 13)).toBe(false);
  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput({ ...hook("Stop"), session_id: "019fb1c0-bbbb-7ccc-8ddd-0123456789ab" })!, 14)).toBe(false);
  expect(database.query("SELECT turn_state, updated_at FROM codex_launch_state").get()).toEqual({
    turn_state: "waiting",
    updated_at: 10,
  });
  database.close();
});

test("a new SessionStart rebinds the screen and rejects late events from the old session", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("cs-demo", "demo", "/srv/project", 1, "codex", launchId);
  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput(hook("SessionStart", { source: "startup" }))!, 10)).toBe(true);

  const nextId = "019fb1c0-cccc-7ddd-8eee-0123456789ab";
  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput({ ...hook("SessionStart", { source: "clear" }), session_id: nextId })!, 20)).toBe(true);
  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput(hook("Stop"))!, 21)).toBe(false);
  expect(database.query("SELECT session_id, updated_at FROM codex_launch_state").get()).toEqual({ session_id: nextId, updated_at: 20 });
  database.close();
});

test("a pending resume rejects a different SessionStart id without rebinding", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const archiveId = Number(database.query(
    "INSERT INTO archive (name, project_path, resume_id, provider, ended_at) VALUES (?, ?, ?, 'codex', ?)",
  ).run("demo", "/srv/project", sessionId.toUpperCase(), 1).lastInsertRowid);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, resume_id, provider, launch_id, phase, resume_archive_id) VALUES (?, ?, ?, ?, ?, 'codex', ?, 'awaiting_session_start', ?)",
  ).run("cs-demo", "demo", "/srv/project", 2, sessionId, launchId, archiveId);

  const differentId = "019fb1c0-dddd-7eee-8fff-0123456789ab";
  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput({
    ...hook("SessionStart", { source: "clear" }),
    session_id: differentId,
  })!, 10)).toBe(false);
  expect(database.query("SELECT id FROM archive WHERE id = ?").get(archiveId)).toEqual({ id: archiveId });
  expect(database.query(
    "SELECT resume_id, phase, error_message, resume_archive_id FROM launches WHERE launch_id = ?",
  ).get(launchId)).toEqual({
    resume_id: sessionId,
    phase: "failed",
    error_message: "Codex reported a different conversation than the archived session requested.",
    resume_archive_id: archiveId,
  });
  expect(database.query("SELECT launch_id FROM codex_launch_state WHERE launch_id = ?").get(launchId)).toBeNull();

  database.close();
});

test("a pending resume is consumed only by its exact SessionStart id", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const archiveId = Number(database.query(
    "INSERT INTO archive (name, project_path, resume_id, provider, ended_at) VALUES (?, ?, ?, 'codex', ?)",
  ).run("demo", "/srv/project", sessionId.toUpperCase(), 1).lastInsertRowid);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, resume_id, provider, launch_id, phase, resume_archive_id) VALUES (?, ?, ?, ?, ?, 'codex', ?, 'awaiting_session_start', ?)",
  ).run("cs-demo", "demo", "/srv/project", 2, sessionId, launchId, archiveId);

  expect(applyCodexHook(database, "cs-demo", launchId, parseCodexHookInput(hook("SessionStart", { source: "resume" }))!, 20)).toBe(true);
  expect(database.query("SELECT id FROM archive WHERE id = ?").get(archiveId)).toBeNull();
  expect(database.query("SELECT phase, resume_id, resume_archive_id FROM launches WHERE launch_id = ?").get(launchId)).toEqual({
    phase: "ready",
    resume_id: sessionId,
    resume_archive_id: null,
  });
  database.close();
});

test("live hook activity degrades to telemetry unknown after thirty minutes", () => {
  expect(codexActivity("asking", 1_000, 1_000 + 29 * 60_000)).toMatchObject({ asking: true, telemetryUnknown: false });
  expect(codexActivity("asking", 1_000, 1_000 + 31 * 60_000)).toEqual({
    busy: false,
    waiting: false,
    asking: false,
    telemetryUnknown: true,
  });
  expect(codexActivity("waiting", 1_000, 1_000 + 31 * 60_000).telemetryUnknown).toBe(true);
});
