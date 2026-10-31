import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { buildCodexInvocation } from "./codex";
import * as mux from "./mux";
import { applyDatabaseSchema } from "./db-schema";
import {
  buildCodexScreenCommand,
  archiveManagedLaunch,
  canArchiveManagedLaunch,
  canResumeCodexArchive,
  CODEX_SESSION_START_TIMEOUT_SEC,
  codexSessionStartTimedOut,
  failScreenlessCodexLaunch,
  findProviderProcess,
  normalizeCodexResumeId,
  screenlessLaunchAction,
  startManagedCodex,
  run,
  reconcileCodexStartup,
  type ManagedCodexRuntime,
  type LaunchRow,
  type Proc,
} from "./sessions";

const launchId = "019fb1b3-f208-73f2-ba13-0665f58ae4a0";
const resumeId = "019fb1c0-aaaa-7bbb-8ccc-0123456789ab";

test("session subprocesses receive the mux directory set after Bun started", async () => {
  const expected = process.env.ZMX_DIR;
  expect(expected).toBeTruthy();
  const result = await run([process.execPath, "-e", "process.stdout.write(process.env.ZMX_DIR ?? '')"]);
  expect(result.code).toBe(0);
  expect(result.out).toBe(expected);
  const override = await run([process.execPath, "-e", "process.stdout.write(process.env.ZMX_DIR ?? '')"], { ZMX_DIR: "/tmp/test-mux-override" });
  expect(override.out).toBe("/tmp/test-mux-override");
  expect(process.env.ZMX_DIR).toBe(expected);
});

test("managed Codex ownership follows process ancestry to the real TUI child", () => {
  const procs: Proc[] = [
    { pid: 100, ppid: 1, etimes: 60, pcpu: 0, args: "SCREEN -dmS cs-demo bash -lc exec codex" },
    { pid: 101, ppid: 100, etimes: 59, pcpu: 0, args: "bash -lc exec codex" },
    { pid: 102, ppid: 101, etimes: 58, pcpu: 1, args: "codex --dangerously-bypass-approvals-and-sandbox -C /srv/demo" },
    { pid: 103, ppid: 100, etimes: 58, pcpu: 0, args: "codex app-server" },
    { pid: 200, ppid: 1, etimes: 10, pcpu: 2, args: "codex -C /srv/unmanaged" },
  ];

  expect(findProviderProcess(procs, 100, "codex")?.pid).toBe(102);
  expect(findProviderProcess(procs, 999, "codex")).toBeNull();
});

test("the screen boundary inherits the service environment and injects only bounded CS markers", () => {
  const invocation = buildCodexInvocation({
    bin: "/usr/bin/codex",
    cwd: "/srv/project's-copy",
    screen: "cs-demo",
    launchId,
    dbPath: "/var/www/xcloud-sessions/data/app.db",
    resumeId,
  });
  expect(invocation).not.toBeNull();

  const command = buildCodexScreenCommand(invocation!);
  expect(command).toStartWith("exec env CS_DB_PATH=");
  expect(command).toContain("CS_LAUNCH_ID=");
  expect(command).toContain("CS_SCREEN=");
  expect(command).toContain("'/srv/project'\\''s-copy'");
  expect(command).toContain(`'resume' '${resumeId}'`);
  expect(command).not.toContain("--last");
  expect(command).not.toContain("--dangerously-bypass-hook-trust");
  expect(buildCodexScreenCommand({
    ...invocation!,
    env: { ...invocation!.env, HOME: "/tmp/attacker" },
  })).toBeNull();
});

test("Codex archive resume requires an existing folder and one exact UUID", () => {
  expect(canResumeCodexArchive(process.cwd(), "demo", resumeId)).toBe(true);
  expect(canResumeCodexArchive(process.cwd(), "demo", null)).toBe(false);
  expect(canResumeCodexArchive(process.cwd(), "demo", "--last")).toBe(false);
  expect(canResumeCodexArchive("/definitely/missing/xcloud-folder", "demo", resumeId)).toBe(false);
});

test("Codex archive resume IDs normalize only exact UUIDs", () => {
  expect(normalizeCodexResumeId(resumeId.toUpperCase())).toBe(resumeId);
  expect(normalizeCodexResumeId(null)).toBeNull();
  expect(normalizeCodexResumeId("--last")).toBeNull();
});

test("awaiting SessionStart becomes a bounded failure based on the Codex child uptime", () => {
  expect(codexSessionStartTimedOut("awaiting_session_start", CODEX_SESSION_START_TIMEOUT_SEC)).toBe(false);
  expect(codexSessionStartTimedOut("awaiting_session_start", CODEX_SESSION_START_TIMEOUT_SEC + 1)).toBe(true);
  expect(codexSessionStartTimedOut("ready", CODEX_SESSION_START_TIMEOUT_SEC + 1)).toBe(false);
});

test("only hook-confirmed Codex launches become new archive conversations", () => {
  expect(canArchiveManagedLaunch("codex", "preparing")).toBe(false);
  expect(canArchiveManagedLaunch("codex", "awaiting_session_start")).toBe(false);
  expect(canArchiveManagedLaunch("codex", "failed")).toBe(false);
  expect(canArchiveManagedLaunch("codex", "ready")).toBe(true);
  expect(canArchiveManagedLaunch("claude", "ready")).toBe(true);
  expect(screenlessLaunchAction("codex", "failed", 0)).toBe("fail");
  expect(screenlessLaunchAction("codex", "awaiting_session_start", 29_999)).toBe("wait");
  expect(screenlessLaunchAction("codex", "awaiting_session_start", 30_000)).toBe("fail");
  expect(screenlessLaunchAction("codex", "ready", 30_000)).toBe("archive");
});

test("a screenless pre-ready Codex launch becomes a durable cleanup card", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const archiveId = Number(database.query(
    "INSERT INTO archive (name, project_path, resume_id, provider, ended_at) VALUES ('demo', '/srv/demo', ?, 'codex', 1)",
  ).run(resumeId).lastInsertRowid);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, resume_id, provider, launch_id, phase, resume_archive_id) " +
    "VALUES ('cs-demo', 'demo', '/srv/demo', 2, ?, 'codex', ?, 'awaiting_session_start', ?)",
  ).run(resumeId, launchId, archiveId);
  const launch = database.query(
    "SELECT screen, name, project_path, created_at, claude_url, resume_id, remote_control, provider, launch_id, phase, error_message, resume_archive_id " +
    "FROM launches WHERE screen = 'cs-demo'",
  ).get() as LaunchRow;

  expect(failScreenlessCodexLaunch(database, launch)).toMatchObject({
    phase: "failed",
    error_message: "Codex exited before its managed SessionStart hook reported readiness.",
    resume_archive_id: archiveId,
  });
  expect(database.query(
    "SELECT phase, error_message, resume_archive_id FROM launches WHERE screen = 'cs-demo'",
  ).get()).toEqual({
    phase: "failed",
    error_message: "Codex exited before its managed SessionStart hook reported readiness.",
    resume_archive_id: archiveId,
  });
  expect(database.query("SELECT id FROM archive WHERE id = ?").get(archiveId)).toEqual({ id: archiveId });
  database.close();
});

test("a stale same-screen launch row is not silently rebound to a new Codex process", async () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES (?, ?, ?, ?, 'codex', ?)",
  ).run("cs-demo", "demo", "/srv/demo", 1, "019fb1b3-f208-73f2-ba13-0665f58ae4ff");

  const runtime: ManagedCodexRuntime = {
    database,
    dbPath: "/var/lib/xcloud/app.db",
    preflight: async () => ({ ok: true, bin: "/usr/bin/codex", version: "0.146.0" }),
    execute: async () => ({ code: 0, out: "", err: "" }),
    uuid: () => launchId,
    now: () => 2,
  };
  expect(await startManagedCodex({
    screen: "cs-demo",
    name: "demo",
    projectPath: "/srv/demo",
  }, runtime)).toEqual({ ok: false, error: "A managed session record already owns “demo”." });
  expect(database.query("SELECT launch_id FROM launches WHERE screen = 'cs-demo'").get()).toEqual({
    launch_id: "019fb1b3-f208-73f2-ba13-0665f58ae4ff",
  });
  database.close();
});

test("Codex preflight completes before launch ownership or screen state is mutated", async () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  let executed = false;
  const runtime: ManagedCodexRuntime = {
    database,
    dbPath: "/var/lib/xcloud/app.db",
    preflight: async () => {
      expect(database.query("SELECT COUNT(*) AS count FROM launches").get()).toEqual({ count: 0 });
      return { ok: false, code: "not_authenticated", message: "Codex login is required." };
    },
    execute: async () => {
      executed = true;
      return { code: 0, out: "", err: "" };
    },
    uuid: () => launchId,
    now: () => 2,
  };

  expect(await startManagedCodex({ screen: "cs-demo", name: "demo", projectPath: "/srv/demo" }, runtime)).toEqual({
    ok: false,
    error: "Codex login is required.",
  });
  expect(executed).toBe(false);
  expect(database.query("SELECT COUNT(*) AS count FROM launches").get()).toEqual({ count: 0 });
  database.close();
});

test("launch ownership exists before screen starts and advances only to awaiting SessionStart", async () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  let screenCommand: string[] | null = null;
  const runtime: ManagedCodexRuntime = {
    database,
    dbPath: "/var/lib/xcloud/app.db",
    preflight: async () => ({ ok: true, bin: "/usr/bin/codex", version: "0.146.0" }),
    execute: async (command) => {
      screenCommand = command;
      expect(database.query("SELECT provider, phase, remote_control FROM launches WHERE screen = 'cs-demo'").get()).toEqual({
        provider: "codex",
        phase: "preparing",
        remote_control: 0,
      });
      return { code: 0, out: "", err: "" };
    },
    uuid: () => launchId,
    now: () => 2,
  };

  expect(await startManagedCodex({
    screen: "cs-demo",
    name: "demo",
    projectPath: "/srv/demo",
    resumeId,
  }, runtime)).toEqual({ ok: true });
  // Whichever holder this machine launches with, the session is `cs-demo` running `bash -lc`.
  expect(screenCommand?.slice(0, -1)).toEqual(mux.spawnArgv(mux.newSessionBackend(), "cs-demo", "").slice(0, -1));
  expect(screenCommand?.at(-1)).toContain(`'resume' '${resumeId}'`);
  expect(screenCommand?.at(-1)).not.toContain("--last");
  expect(database.query("SELECT phase FROM launches WHERE screen = 'cs-demo'").get()).toEqual({
    phase: "awaiting_session_start",
  });
  database.close();
});

test("a failed Codex resume keeps its archive and records a sanitized retryable launch error", async () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const archiveId = Number(database.query(
    "INSERT INTO archive (name, project_path, resume_id, provider, ended_at) VALUES ('demo', '/srv/demo', ?, 'codex', 1)",
  ).run(resumeId).lastInsertRowid);
  const runtime: ManagedCodexRuntime = {
    database,
    dbPath: "/var/lib/xcloud/app.db",
    preflight: async () => ({ ok: true, bin: "/usr/bin/codex", version: "0.146.0" }),
    execute: async () => ({ code: 1, out: "", err: "screen\nfailed\u0000with details" }),
    uuid: () => launchId,
    now: () => 2,
  };

  expect(await startManagedCodex({
    screen: "cs-demo",
    name: "demo",
    projectPath: "/srv/demo",
    resumeId,
    resumeArchiveId: archiveId,
  }, runtime)).toEqual({ ok: false, error: "screen failed with details" });
  expect(database.query("SELECT id FROM archive WHERE id = ?").get(archiveId)).toEqual({ id: archiveId });
  expect(database.query("SELECT phase, error_message, resume_archive_id FROM launches WHERE screen = 'cs-demo'").get()).toEqual({
    phase: "failed",
    error_message: "screen failed with details",
    resume_archive_id: archiveId,
  });
  database.close();
});

test("archiving Codex captures the hook-confirmed exact UUID and final model before cascade cleanup", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase, remote_control) " +
    "VALUES ('cs-demo', 'demo', '/srv/demo', 10, 'codex', ?, 'ready', 0)",
  ).run(launchId);
  database.query(
    "INSERT INTO codex_launch_state (launch_id, screen, session_id, model, turn_state, canonical_cwd, updated_at) " +
    "VALUES (?, 'cs-demo', ?, 'gpt-5.6', 'waiting', '/srv/demo', 20)",
  ).run(launchId, resumeId);
  const launch = database.query(
    "SELECT screen, name, project_path, created_at, claude_url, resume_id, remote_control, provider, launch_id, phase, error_message, resume_archive_id " +
    "FROM launches WHERE screen = 'cs-demo'",
  ).get() as LaunchRow;

  expect(archiveManagedLaunch(database, launch, 30)).toBe(true);
  expect(database.query(
    "SELECT provider, resume_id, model, remote_control, started_at, ended_at FROM archive",
  ).get()).toEqual({
    provider: "codex",
    resume_id: resumeId,
    model: "gpt-5.6",
    remote_control: 0,
    started_at: 10,
    ended_at: 30,
  });
  expect(database.query("SELECT COUNT(*) AS count FROM codex_launch_state").get()).toEqual({ count: 0 });
  expect(archiveManagedLaunch(database, launch, 40)).toBe(false);
  database.close();
});

test("archiving a managed launch rolls back its deletion when history persistence fails", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase) " +
    "VALUES ('cs-demo', 'demo', '/srv/demo', 10, 'codex', ?, 'ready')",
  ).run(launchId);
  database.query(
    "INSERT INTO codex_launch_state (launch_id, screen, session_id, turn_state, canonical_cwd, updated_at) " +
    "VALUES (?, 'cs-demo', ?, 'waiting', '/srv/demo', 20)",
  ).run(launchId, resumeId);
  database.exec(`
    CREATE TRIGGER reject_archive_insert
    BEFORE INSERT ON archive
    BEGIN
      SELECT RAISE(ABORT, 'archive unavailable');
    END;
  `);
  const launch = database.query(
    "SELECT screen, name, project_path, created_at, claude_url, resume_id, remote_control, provider, launch_id, phase, error_message, resume_archive_id " +
    "FROM launches WHERE screen = 'cs-demo'",
  ).get() as LaunchRow;

  expect(() => archiveManagedLaunch(database, launch, 30)).toThrow("archive unavailable");
  expect(database.query("SELECT screen FROM launches WHERE screen = 'cs-demo'").get()).toEqual({ screen: "cs-demo" });
  expect(database.query("SELECT launch_id FROM codex_launch_state WHERE launch_id = ?").get(launchId)).toEqual({ launch_id: launchId });
  database.close();
});


test("folder trust suppresses only readiness timeout and hooks remain the readiness authority", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  try {
    database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase) VALUES ('cs-demo', 'demo', '/srv/demo', 1, 'codex', ?, 'awaiting_session_start')").run(launchId);
    const row = () => database.query("SELECT * FROM launches WHERE launch_id = ?").get(launchId) as LaunchRow;
    expect(reconcileCodexStartup(database, row(), 300, true)).toEqual({ phase: "awaiting_session_start", error: null, waitingForTrust: true });
    const timedOut = reconcileCodexStartup(database, row(), 300, false);
    expect(timedOut.phase).toBe("failed");
    expect(timedOut.waitingForTrust).toBe(false);
    expect(reconcileCodexStartup(database, row(), 300, true).waitingForTrust).toBe(true);
    const staleRow = row();
    database.query("UPDATE launches SET phase = 'ready' WHERE launch_id = ?").run(launchId);
    expect(reconcileCodexStartup(database, staleRow, 300, true)).toEqual({ phase: "ready", error: null, waitingForTrust: false });
    expect(reconcileCodexStartup(database, staleRow, 300, false).phase).toBe("ready");
    database.query("UPDATE launches SET phase = 'failed', error_message = 'Codex exited before its managed SessionStart hook reported readiness.' WHERE launch_id = ?").run(launchId);
    expect(reconcileCodexStartup(database, row(), 300, true).waitingForTrust).toBe(false);
    expect(row().phase).toBe("failed");
  } finally { database.close(); }
});

test("a stale launch id cannot recover a replacement screen or override hook state", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  try {
    database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id, phase) VALUES ('cs-demo', 'demo', '/srv/demo', 1, 'codex', ?, 'awaiting_session_start')").run(launchId);
    const row = database.query("SELECT * FROM launches WHERE launch_id = ?").get(launchId) as LaunchRow;
    expect(reconcileCodexStartup(database, { ...row, launch_id: resumeId }, 300, true).waitingForTrust).toBe(false);
    database.query("INSERT INTO codex_launch_state (launch_id, screen, session_id, turn_state, canonical_cwd, updated_at) VALUES (?, 'cs-demo', ?, 'waiting', '/srv/demo', 2)").run(launchId, resumeId);
    expect(reconcileCodexStartup(database, row, 300, true).waitingForTrust).toBe(false);
    expect(reconcileCodexStartup(database, row, 300, false).phase).toBe("awaiting_session_start");
  } finally { database.close(); }
});
