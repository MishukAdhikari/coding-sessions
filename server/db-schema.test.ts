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

test("connector auth migration keeps bearer and anonymous rows working, adds epochs and OAuth tables", () => {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  // Simulate a database from the generic-connector release: no auth columns yet.
  database.exec(`
    DROP TABLE mcp_connectors;
    CREATE TABLE mcp_connectors (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, url TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1, credential TEXT, credential_set_at INTEGER, granted_tools TEXT NOT NULL DEFAULT '[]',
      default_providers TEXT NOT NULL DEFAULT '[]', catalog TEXT, catalog_at INTEGER, catalog_stale INTEGER NOT NULL DEFAULT 0,
      server_info TEXT, check_status TEXT, check_detail TEXT, check_at INTEGER, check_ok_at INTEGER, created_at INTEGER NOT NULL);
    INSERT INTO mcp_connectors (id,name,slug,url,credential,granted_tools,default_providers,created_at)
      VALUES ('b','Bearer','bearer','https://a.example/mcp','xcs:secret:v1:x','["t"]','["codex"]',1),
             ('n','Open','open','https://b.example/mcp',NULL,'["u"]','[]',1);
    INSERT INTO connector_launch_grants VALUES ('b','launch-1',1);
  `);
  applyDatabaseSchema(database);
  applyDatabaseSchema(database);
  expect(database.query("SELECT id,auth_mode,auth_epoch,token_version,credential,granted_tools FROM mcp_connectors ORDER BY id").all()).toEqual([
    { id: "b", auth_mode: "bearer", auth_epoch: 0, token_version: 0, credential: "xcs:secret:v1:x", granted_tools: '["t"]' },
    { id: "n", auth_mode: "none", auth_epoch: 0, token_version: 0, credential: null, granted_tools: '["u"]' },
  ]);
  expect(database.query("SELECT COUNT(*) AS n FROM connector_launch_grants").get()).toEqual({ n: 1 });
  for (const table of ["connector_oauth_grants", "connector_oauth_pending"]) {
    expect(database.query("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)).toEqual({ name: table });
  }
  // OAuth state belongs to its connector and goes with it.
  database.query("UPDATE mcp_connectors SET auth_mode='oauth' WHERE id='n'").run();
  database.query(`INSERT INTO connector_oauth_pending (state_hash,connector_id,auth_epoch,session_hash,issuer,resource,client_id,redirect_uri,verifier,
      registration,token_endpoint,token_auth_method,created_at,expires_at)
    VALUES ('h','n',0,'s','https://as.example','https://b.example/mcp','c','https://app.example/oauth/connectors/callback','v','dcr','https://as.example/token','none',1,2)`).run();
  database.query("DELETE FROM mcp_connectors WHERE id='n'").run();
  expect(database.query("SELECT COUNT(*) AS n FROM connector_oauth_pending").get()).toEqual({ n: 0 });
  expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  database.close();
});
