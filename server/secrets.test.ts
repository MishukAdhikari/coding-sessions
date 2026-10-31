import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { createSecretCodec, loadTokenKey, readProtectedSecret } from "./secrets";
import { applyDatabaseSchema } from "./db-schema";
import { commandEnv, createCommand, listCommands, setCommandToken } from "./commands";
import { commandCodeEnv, hasCommandCodeToken, setCommandCodeToken, COMMAND_CODE_TOKEN_KEY } from "./command-code";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const temp = () => { const dir = mkdtempSync(join(tmpdir(), "xcs-secret-test-")); dirs.push(dir); return dir; };
const database = () => { const db = new Database(":memory:"); applyDatabaseSchema(db); return db; };

test("authenticated secrets use fresh nonces and preserve arbitrary plaintext", () => {
  const codec = createSecretCodec(randomBytes(32));
  const value = "dummy credential \u0000 unicode 🗝";
  const first = codec.sealSecret(value, "context");
  const second = codec.sealSecret(value, "context");
  expect(first).not.toBe(second);
  expect(first).not.toContain(value);
  expect(codec.openSecret(first, "context")).toBe(value);
  expect(codec.openSecret(second, "context")).toBe(value);
});

test("tampering, wrong keys, missing keys, context swaps and future versions fail closed", () => {
  const codec = createSecretCodec(randomBytes(32));
  const encrypted = codec.sealSecret("dummy-token", "first");
  const packed = Buffer.from(encrypted.slice("xcs:secret:v1:".length), "base64");
  packed[packed.length - 1] = packed[packed.length - 1]! ^ 1;
  const tampered = "xcs:secret:v1:" + packed.toString("base64");
  const wrong = createSecretCodec(randomBytes(32));
  for (const open of [
    () => codec.openSecret(tampered, "first"),
    () => codec.openSecret(encrypted, "second"),
    () => wrong.openSecret(encrypted, "first"),
    () => createSecretCodec(null).openSecret(encrypted, "first"),
    () => codec.openSecret("xcs:secret:v2:unknown", "first"),
    () => codec.openSecret("xcs:secret:v1:invalid", "first"),
  ]) expect(open).toThrow("Protected secret is unavailable.");
});

test("legacy plaintext reads work with or without a configured key", () => {
  expect(createSecretCodec(null).sealSecret("old-token", "a")).toBe("old-token");
  expect(createSecretCodec(null).openSecret("old-token", "a")).toBe("old-token");
  expect(createSecretCodec(randomBytes(32)).openSecret("old-token", "a")).toBe("old-token");
  expect(() => createSecretCodec(null).sealSecret("xcs:secret:v9:value", "a")).toThrow();
  expect(() => createSecretCodec(new Uint8Array(31))).toThrow();
});

test("protected reader accepts private files and rejects exposed, linked and nonregular files", () => {
  const dir = temp();
  const file = join(dir, "key");
  writeFileSync(file, "dummy", { mode: 0o600 });
  expect(readProtectedSecret(file)).toBe("dummy");
  chmodSync(file, 0o400);
  expect(readProtectedSecret(file)).toBe("dummy");
  for (const mode of [0o640, 0o604, 0o601, 0o620]) {
    chmodSync(file, mode);
    expect(() => readProtectedSecret(file)).toThrow("Protected secret is unavailable.");
  }
  chmodSync(file, 0o600);
  const link = join(dir, "link");
  symlinkSync(file, link);
  expect(() => readProtectedSecret(link)).toThrow();
  const folder = join(dir, "folder");
  mkdirSync(folder, { mode: 0o700 });
  expect(() => readProtectedSecret(folder)).toThrow();
  expect(() => readProtectedSecret(join(dir, "missing"))).toThrow("Protected secret is unavailable.");
  writeFileSync(file, "x".repeat(65537));
  expect(() => readProtectedSecret(file)).toThrow();
});

test("key loading uses protected files, canonical base64, explicit precedence and no raw env key", () => {
  const dir = temp();
  const file = join(dir, "token-encryption-key");
  const key = randomBytes(32);
  writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600 });
  expect(loadTokenKey({ CREDENTIALS_DIRECTORY: dir })).toEqual(key);
  expect(loadTokenKey({ CS_TOKEN_KEY_FILE: file, CREDENTIALS_DIRECTORY: "/missing" })).toEqual(key);
  expect(loadTokenKey({ XCS_TOKEN_KEY_FILE: file })).toEqual(key);
  expect(() => loadTokenKey({ CS_TOKEN_KEY_FILE: join(dir, "missing"), XCS_TOKEN_KEY_FILE: file })).toThrow();
  expect(loadTokenKey({ CS_TOKEN_KEY: key.toString("base64") })).toBeNull();
  expect(loadTokenKey({})).toBeNull();
  expect(() => loadTokenKey({ CS_TOKEN_KEY_FILE: join(dir, "missing") })).toThrow();
  expect(() => loadTokenKey({ CREDENTIALS_DIRECTORY: join(dir, "missing") })).toThrow();
  for (const invalid of ["", "not-base64", Buffer.alloc(31).toString("base64"), key.toString("base64").replace(/=$/, "")]) {
    writeFileSync(file, invalid);
    expect(() => loadTokenKey({ CS_TOKEN_KEY_FILE: file })).toThrow();
  }
});

test("custom-command tokens encrypt at rest, stay absent from API models and bind to row and env", () => {
  const db = database();
  try {
    const codec = createSecretCodec(randomBytes(32));
    const first = createCommand({ label: "First", bin: "sh", envVar: "FIRST_KEY" }, db);
    const second = createCommand({ label: "Second", bin: "sh", envVar: "SECOND_KEY" }, db);
    if (!first.ok || !second.ok) throw new Error("Fixture commands failed");
    expect(setCommandToken(first.command.id, "dummy-token", db, codec)).toEqual({ ok: true });
    const row = db.query("SELECT token FROM custom_commands WHERE id = ?").get(first.command.id) as { token: string };
    expect(row.token).toStartWith("xcs:secret:v1:");
    expect(commandEnv("first", db, codec)).toEqual({ FIRST_KEY: "dummy-token" });
    const commands = listCommands(db);
    expect(commands.find(c => c.id === first.command.id)?.hasToken).toBe(true);
    expect(JSON.stringify(commands)).not.toContain("dummy-token");
    expect(JSON.stringify(commands)).not.toContain(row.token);
    db.query("UPDATE custom_commands SET token = ? WHERE id = ?").run(row.token, second.command.id);
    expect(() => commandEnv("second", db, codec)).toThrow();
    db.query("UPDATE custom_commands SET env_var = 'OTHER_KEY' WHERE id = ?").run(first.command.id);
    expect(() => commandEnv("first", db, codec)).toThrow();
  } finally { db.close(); }
});

test("Command Code presence does not decrypt; only delivery decrypts and rejects unavailable keys", () => {
  const db = database();
  try {
    const codec = createSecretCodec(randomBytes(32));
    expect(setCommandCodeToken("dummy-code-key", db, codec)).toEqual({ ok: true });
    const row = db.query("SELECT value FROM meta WHERE key = ?").get(COMMAND_CODE_TOKEN_KEY) as { value: string };
    expect(row.value).toStartWith("xcs:secret:v1:");
    expect(hasCommandCodeToken(db)).toBe(true);
    expect(commandCodeEnv(db, codec)).toEqual({ COMMAND_CODE_API_KEY: "dummy-code-key" });
    expect(() => commandCodeEnv(db, createSecretCodec(null))).toThrow();
    expect(() => codec.openSecret(row.value, "command-code:OTHER_KEY")).toThrow();
    db.query("UPDATE meta SET value = ? WHERE key = ?").run("legacy-key", COMMAND_CODE_TOKEN_KEY);
    expect(commandCodeEnv(db, codec)).toEqual({ COMMAND_CODE_API_KEY: "legacy-key" });
  } finally { db.close(); }
});
