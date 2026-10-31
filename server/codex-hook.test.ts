import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { handleCodexHookPayload, readBoundedJson } from "./codex-hook";

const launchId = "019fb1b3-f208-73f2-ba13-0665f58ae4a0";
const sessionId = "019fb1c0-aaaa-7bbb-8ccc-0123456789ab";

test("bounded hook input accepts JSON and rejects oversized or malformed input", async () => {
  const json = new Response(JSON.stringify({ ok: true })).body!;
  expect(await readBoundedJson(json, 64)).toEqual({ ok: true });
  expect(await readBoundedJson(new Response("x".repeat(65)).body!, 64)).toBeNull();
  expect(await readBoundedJson(new Response("not json").body!, 64)).toBeNull();
});

test("hook handler opens only an existing marked database and applies normalized state", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES (?, ?, ?, ?, 'codex', ?)",
  ).run("cs-demo", "demo", "/srv/project", 1, launchId);

  const openDatabase = () => database;
  const payload = {
    session_id: sessionId,
    cwd: "/srv/project",
    model: "gpt-5.6",
    hook_event_name: "SessionStart",
    source: "startup",
    prompt: "must not be stored",
  };
  expect(handleCodexHookPayload(payload, {
    CS_DB_PATH: "/srv/app.db",
    CS_SCREEN: "cs-demo",
    CS_LAUNCH_ID: launchId,
  }, openDatabase, 10)).toBe(true);
  expect(database.query("SELECT session_id, turn_state FROM codex_launch_state").get()).toEqual({
    session_id: sessionId,
    turn_state: "waiting",
  });
  expect(handleCodexHookPayload(payload, {
    CS_DB_PATH: "relative.db",
    CS_SCREEN: "cs-demo",
    CS_LAUNCH_ID: launchId,
  }, openDatabase, 11)).toBe(false);
  database.close();
});

test("hook handler never opens storage without every app launch marker", () => {
  const payload = {
    session_id: sessionId,
    cwd: "/srv/project",
    hook_event_name: "SessionStart",
    source: "startup",
  };
  let opens = 0;
  const openDatabase = () => {
    opens += 1;
    throw new Error("must not open");
  };
  const environments = [
    {},
    { CS_DB_PATH: "/srv/app.db", CS_SCREEN: "cs-demo" },
    { CS_DB_PATH: "/srv/app.db", CS_LAUNCH_ID: launchId },
    { CS_SCREEN: "cs-demo", CS_LAUNCH_ID: launchId },
  ];

  for (const environment of environments) {
    expect(handleCodexHookPayload(payload, environment, openDatabase, 10)).toBe(false);
  }
  expect(opens).toBe(0);
});

test("standalone managed hook accepts existing legacy launches without mixing marker families", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES ('cs-demo', 'demo', '/srv/project', 1, 'codex', ?)").run(launchId);
  const payload = { session_id: sessionId, cwd: "/srv/project", hook_event_name: "SessionStart", source: "startup" };
  const legacy = { XCS_DB_PATH: "/srv/app.db", XCS_SCREEN: "cs-demo", XCS_LAUNCH_ID: launchId };
  let opens = 0;
  const open = () => { opens++; return database; };
  expect(handleCodexHookPayload(payload, { ...legacy, CS_SCREEN: "cs-other" }, open, 10)).toBe(false);
  expect(opens).toBe(0);
  expect(handleCodexHookPayload(payload, legacy, open, 10)).toBe(true);
  expect(database.query("SELECT phase FROM launches").get()).toEqual({ phase: "ready" });
  database.close();
});


test("default hook opener updates an existing SQLite file without creating missing databases", () => {
  const directory = mkdtempSync(join(tmpdir(), "cs-hook-open-"));
  const path = join(directory, "app.db");
  const database = new Database(path);
  try {
    applyDatabaseSchema(database);
    database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id,phase) VALUES ('cs-demo','demo','/srv/project',1,'codex',?,'awaiting_session_start')").run(launchId);
    const payload = { session_id: sessionId, cwd: "/srv/project", hook_event_name: "SessionStart", source: "startup" };
    const environment = { CS_DB_PATH: path, CS_SCREEN: "cs-demo", CS_LAUNCH_ID: launchId };
    expect(handleCodexHookPayload(payload, environment)).toBe(true);
    expect(database.query("SELECT phase FROM launches").get()).toEqual({ phase: "ready" });
    const missing = join(directory, "missing.db");
    expect(handleCodexHookPayload(payload, { ...environment, CS_DB_PATH: missing })).toBe(false);
    expect(existsSync(missing)).toBe(false);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
