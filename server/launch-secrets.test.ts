import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { createLaunchFingerprints, launchSecretsDir, launchSecretsPath, refreshLaunchSecrets, renderSecretsFile, writeLaunchSecrets } from "./launch-secrets";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "cs-launch-secrets-"));
  roots.push(root);
  return join(root, "secrets");
}
function launches(...ids: string[]) {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  ids.forEach((id, i) => database.query("INSERT INTO launches (screen,name,project_path,created_at,provider,launch_id) VALUES (?,?,?,1,'claude',?)").run(`cs-${i}`, `s${i}`, "/tmp", id));
  return database;
}

test("the file is private and sourcing it in sh yields every value byte for byte", async () => {
  const dir = scratch();
  const tricky = { PLAIN: "abc", QUOTES: `it's "quoted" \\ $HOME \`id\``, LINES: "one\ntwo", SPACES: "  padded  " };
  const path = writeLaunchSecrets(dir, "launch-1", tricky);
  expect(path).toBe(launchSecretsPath(dir, "launch-1"));
  expect(statSync(path).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  for (const [name, value] of Object.entries(tricky)) {
    const out = Bun.spawnSync(["sh", "-c", `. "$1" && printf %s "$${name}"`, "sh", path]);
    expect(out.stdout.toString()).toBe(value);
  }
});

test("names that are not env vars are never written", () => {
  expect(renderSecretsFile({ "BAD-NAME": "x", "$(id)": "y", GOOD: "z" })).not.toMatch(/BAD-NAME|\$\(id\)/);
});

test("refresh rewrites current launches and removes files of launches that are gone", async () => {
  const dir = scratch();
  const database = launches("launch-a", "launch-b");
  writeLaunchSecrets(dir, "launch-gone", { OLD: "stale" });
  let env: Record<string, string> = { TOKEN: "one" };
  expect(await refreshLaunchSecrets({ database, dir, env: async () => env })).toEqual({ written: 2, removed: 1 });
  expect(readdirSync(dir).sort()).toEqual(["launch-a.env", "launch-b.env"]);
  env = { TOKEN: "two" };
  database.query("DELETE FROM launches WHERE launch_id='launch-b'").run();
  await refreshLaunchSecrets({ database, dir, env: async () => env });
  expect(readdirSync(dir)).toEqual(["launch-a.env"]);
  const out = Bun.spawnSync(["sh", "-c", `. "$1" && printf %s "$TOKEN"`, "sh", join(dir, "launch-a.env")]);
  expect(out.stdout.toString()).toBe("two");
});

test("a failing environment build never throws out of refresh", async () => {
  const dir = scratch();
  const database = launches("launch-a");
  expect(await refreshLaunchSecrets({ database, dir, env: async () => { throw new Error("boom"); } })).toEqual({ written: 0, removed: 0 });
});

test("a symlinked directory and path-like launch ids are refused", () => {
  const dir = scratch();
  const target = mkdtempSync(join(tmpdir(), "cs-target-"));
  roots.push(target);
  symlinkSync(target, dir);
  expect(() => writeLaunchSecrets(dir, "launch-a", { A: "b" })).toThrow(/real directory/);
  expect(existsSync(join(target, "launch-a.env"))).toBe(false);
  for (const id of ["../escape", "a/b", "", "x".repeat(65)]) expect(() => launchSecretsPath(scratch(), id)).toThrow();
  writeFileSync(join(target, "keep"), "");
});

test("the files live in a runtime directory, never the data directory", () => {
  expect(launchSecretsDir({ CS_RUNTIME_DIR: "/run/coding-sessions" })).toBe("/run/coding-sessions/coding-sessions-secrets");
  expect(launchSecretsDir({ XDG_RUNTIME_DIR: "/run/user/1000" })).toBe("/run/user/1000/coding-sessions-secrets");
  expect(launchSecretsDir({})).toStartWith(tmpdir());
});

test("fingerprints tell current, outdated, missing and unknown apart without keeping values", () => {
  const prints = createLaunchFingerprints();
  prints.record("launch-a", { SAME: "v1", CHANGED: "old" });
  expect(prints.compare("launch-a", "SAME", "v1")).toBe("current");
  expect(prints.compare("launch-a", "CHANGED", "new")).toBe("outdated");
  expect(prints.compare("launch-a", "CHANGED", undefined)).toBe("outdated");
  expect(prints.compare("launch-a", "NEW", "x")).toBe("missing");
  expect(prints.compare("launch-b", "SAME", "v1")).toBe("unknown");
  prints.forget(new Set());
  expect(prints.compare("launch-a", "SAME", "v1")).toBe("unknown");
});
