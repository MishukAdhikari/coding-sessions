import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";

test("legacy launch and archive rows migrate to Claude", () => {
  const database = new Database(":memory:");
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE launches (
      screen TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE archive (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      project_path TEXT,
      claude_url TEXT,
      started_at INTEGER,
      ended_at INTEGER NOT NULL
    );
    INSERT INTO launches (screen, name, project_path, created_at)
      VALUES ('cs-old', 'old', '/srv/old', 1);
    INSERT INTO archive (name, project_path, ended_at)
      VALUES ('older', '/srv/older', 2);
  `);

  applyDatabaseSchema(database);

  expect(database.query("SELECT provider FROM launches WHERE screen = 'cs-old'").get()).toEqual({ provider: "claude" });
  expect(database.query("SELECT provider FROM archive WHERE name = 'older'").get()).toEqual({ provider: "claude" });

  const columns = database.query("PRAGMA table_info(launches)").all() as Array<{ name: string }>;
  expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
    "provider",
    "launch_id",
    "phase",
    "error_message",
    "resume_archive_id",
  ]));

  const archiveColumns = database.query("PRAGMA table_info(archive)").all() as Array<{ name: string }>;
  expect(archiveColumns.map((column) => column.name)).toContain("model");

  // A passkey without its relying party cannot be told apart from a dead one.
  const credentialColumns = database.query("PRAGMA table_info(credentials)").all() as Array<{ name: string }>;
  expect(credentialColumns.map((column) => column.name)).toContain("rp_id");

  database.query(
    "INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("cs-new", "new", "/srv/new", 3, "codex", "launch-1");
  database.query(
    "INSERT INTO codex_launch_state (launch_id, screen, turn_state, canonical_cwd, updated_at) VALUES (?, ?, ?, ?, ?)",
  ).run("launch-1", "cs-new", "starting", "/srv/new", 4);
  database.query("DELETE FROM launches WHERE screen = ?").run("cs-new");
  expect(database.query("SELECT COUNT(*) AS count FROM codex_launch_state").get()).toEqual({ count: 0 });

  database.close();
});
