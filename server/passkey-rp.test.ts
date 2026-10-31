import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { credentialUsable } from "./auth";

test("a passkey registered under another relying party is never offered", () => {
  // The exact case a domain move creates: the row survives, the credential cannot.
  expect(credentialUsable("xcloud-claude.example.com", "example.com")).toBe(false);
  expect(credentialUsable("claude.iamshifat.com", "example.com")).toBe(false);
});

test("a passkey registered under the current relying party is usable", () => {
  expect(credentialUsable("example.com", "example.com")).toBe(true);
});

test("a row from before the column existed is trusted until a login proves otherwise", () => {
  // On a server whose RP never moved, this is the operator's working passkey —
  // hiding it would lock them out of one-tap sign in for no reason.
  expect(credentialUsable(null, "example.com")).toBe(true);
  expect(credentialUsable(null, "claude.iamshifat.com")).toBe(true);
});

test("the column is additive, so an existing database keeps its credentials", () => {
  const database = new Database(":memory:");
  database.exec(`CREATE TABLE credentials (
    id INTEGER PRIMARY KEY, cred_id TEXT NOT NULL UNIQUE, public_key BLOB NOT NULL,
    counter INTEGER NOT NULL DEFAULT 0, transports TEXT, label TEXT, created_at INTEGER NOT NULL)`);
  database.query("INSERT INTO credentials (cred_id, public_key, counter, label, created_at) VALUES (?, ?, 0, ?, ?)")
    .run("legacy-cred", new Uint8Array([1, 2, 3]), "Mac", Date.now());

  applyDatabaseSchema(database);

  const rows = database.query("SELECT cred_id, label, rp_id FROM credentials").all() as
    Array<{ cred_id: string; label: string; rp_id: string | null }>;
  expect(rows).toEqual([{ cred_id: "legacy-cred", label: "Mac", rp_id: null }]);
});
