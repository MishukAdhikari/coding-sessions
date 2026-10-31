import { test, expect } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapPassword } from "./bootstrap";

test("bootstrap persists a private credential without regenerating it on retry", () => {
  const dir = mkdtempSync(join(tmpdir(), "xcs-bootstrap-"));
  try {
    const initial = bootstrapPassword(dir, {});
    expect(initial.password.length).toBeGreaterThanOrEqual(24);
    expect(statSync(initial.path).mode & 0o777).toBe(0o600);
    expect(bootstrapPassword(dir, {})).toEqual(initial);
  } finally { rmSync(dir, { recursive: true }); }
});
test("explicit protected bootstrap file is required and weak values fail", () => {
  const dir = mkdtempSync(join(tmpdir(), "xcs-bootstrap-"));
  try {
    const path = join(dir, "password");
    expect(() => bootstrapPassword(dir, { XCS_ADMIN_PASSWORD_FILE: path })).toThrow();
    writeFileSync(path, "too-short", { mode: 0o600 });
    expect(() => bootstrapPassword(dir, { XCS_ADMIN_PASSWORD_FILE: path })).toThrow();
    writeFileSync(path, "a-long-fixture-password");
    expect(bootstrapPassword(dir, { XCS_ADMIN_PASSWORD_FILE: path }).password).toBe("a-long-fixture-password");
  } finally { rmSync(dir, { recursive: true }); }
});
