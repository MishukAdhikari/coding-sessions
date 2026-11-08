import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acpPaths, checkPrivateDir, ensurePrivateDirs } from "./paths";

const dirs: string[] = [];
// realpath-free short base: /tmp keeps socket paths under the limit on macOS too
const temp = () => { const d = mkdtempSync(join("/tmp", "csacp-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("acpPaths", () => {
  test("derives every file from the holder name", () => {
    const r = acpPaths("/data", "cs-demo");
    expect(r.ok && r.paths).toEqual({
      root: "/data/acp", dir: "/data/acp/cs-demo", socket: "/data/acp/cs-demo/bridge.sock",
      events: "/data/acp/cs-demo/events.jsonl", state: "/data/acp/cs-demo/state.json",
    });
  });

  test.each(["../x", "cs-../../etc", "cs-a/b", "CS-demo", "cs-", "demo", "cs-a b", `cs-${"a".repeat(44)}`])("refuses %p", (name) => {
    expect(acpPaths("/data", name).ok).toBe(false);
  });

  test("refuses a socket path of 100 bytes or more", () => {
    const longDir = `/${"d".repeat(80)}`;
    const r = acpPaths(longDir, "cs-abcdefgh");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("CS_DATA_DIR");
  });
});

describe("private directories", () => {
  test("creates the acp root and session dir 0700", () => {
    const base = temp();
    const r = acpPaths(base, "cs-demo");
    if (!r.ok) throw new Error(r.error);
    expect(ensurePrivateDirs(r.paths)).toEqual({ ok: true });
    expect(statSync(r.paths.root).mode & 0o777).toBe(0o700);
    expect(statSync(r.paths.dir).mode & 0o777).toBe(0o700);
  });

  test("refuses a group-writable session dir", () => {
    const base = temp();
    const r = acpPaths(base, "cs-demo");
    if (!r.ok) throw new Error(r.error);
    mkdirSync(r.paths.dir, { recursive: true });
    chmodSync(r.paths.root, 0o700);
    chmodSync(r.paths.dir, 0o770);
    expect(ensurePrivateDirs(r.paths).ok).toBe(false);
  });

  test("refuses a symlinked session dir", () => {
    const base = temp();
    const elsewhere = temp();
    const r = acpPaths(base, "cs-demo");
    if (!r.ok) throw new Error(r.error);
    mkdirSync(r.paths.root, { mode: 0o700 });
    chmodSync(r.paths.root, 0o700);
    symlinkSync(elsewhere, r.paths.dir);
    expect(checkPrivateDir(r.paths.dir).ok).toBe(false);
    expect(ensurePrivateDirs(r.paths).ok).toBe(false);
  });
});
