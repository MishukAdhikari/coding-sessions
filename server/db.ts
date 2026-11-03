import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, lstatSync, existsSync } from "node:fs";
import { join } from "node:path";
import { config } from "./config";
import { applyDatabaseSchema } from "./db-schema";

process.umask(0o077);
mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
if (lstatSync(config.dataDir).isSymbolicLink()) throw new Error("State directory must not be a symlink.");
chmodSync(config.dataDir, 0o700);
export const DB_PATH = join(config.dataDir, "app.db");
if (existsSync(DB_PATH) && lstatSync(DB_PATH).isSymbolicLink()) throw new Error("Database must not be a symlink.");
export const db = new Database(DB_PATH, { create: true });
chmodSync(DB_PATH, 0o600);
applyDatabaseSchema(db);

export function getMeta(key: string): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

export function setMeta(key: string, value: string): void {
  db.query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
}
