import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateProjectPath } from "./project-path";

/**
 * `access(W_OK)` is uid-based and root bypasses mode bits entirely, so the two
 * permission scenarios below would pass vacuously when tests run as root (CI in
 * a root container, for one). Skip them rather than let them report false green.
 */
const isRoot = process.getuid?.() === 0;
const unlessRoot = isRoot ? test.skip : test;

const temps: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "xs-project-path-"));
  temps.push(dir);
  return dir;
}

afterEach(() => {
  // Restore mode first — a 555 directory cannot have its children removed.
  for (const dir of temps.splice(0)) {
    try { chmodSync(dir, 0o755); } catch {}
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  }
});

describe("validateProjectPath", () => {
  test("rejects a relative path", () => {
    const r = validateProjectPath("foo/bar", false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("absolute path");
  });

  test("rejects a non-string path", () => {
    expect(validateProjectPath(undefined, true).ok).toBe(false);
  });

  test("rejects a missing folder when create is not requested", () => {
    const r = validateProjectPath(join(tempDir(), "nope"), false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("doesn’t exist");
  });

  test("creates a missing folder when create is requested", () => {
    const target = join(tempDir(), "made", "nested");
    const r = validateProjectPath(target, true);
    expect(r).toEqual({ ok: true, path: target });
    expect(existsSync(target)).toBe(true);
  });

  test("accepts an existing writable directory", () => {
    const dir = tempDir();
    expect(validateProjectPath(dir, false)).toEqual({ ok: true, path: dir });
  });

  test("rejects a path that exists but is a file", () => {
    const file = join(tempDir(), "a-file");
    writeFileSync(file, "x");
    const r = validateProjectPath(file, false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("not a directory");
  });

  test("treats a trailing slash as the same folder", () => {
    const dir = tempDir();
    // projects.path is UNIQUE, so these must normalize to one string or the
    // same directory lands in the table twice.
    expect(validateProjectPath(`${dir}/`, false)).toEqual({ ok: true, path: dir });
  });

  // The regression this module exists for: existing + a directory was previously
  // enough to be accepted, and the write failure only surfaced later in a session.
  unlessRoot("rejects an existing directory it cannot write to", () => {
    const dir = tempDir();
    chmodSync(dir, 0o555);
    const r = validateProjectPath(dir, false);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("can’t write to");
    expect(r.ok === false && r.error).toContain(dir);
  });

  unlessRoot("reports a permission-denied mkdir instead of throwing", () => {
    const parent = tempDir();
    chmodSync(parent, 0o555);
    const r = validateProjectPath(join(parent, "child"), true);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain("can’t create");
  });
});
