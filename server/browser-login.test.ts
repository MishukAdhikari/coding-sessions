import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("optional browser login refuses an unspecified email before browser or network activity", async () => {
  const home = mkdtempSync(join(tmpdir(), "xcs-browser-email-"));
  try {
    const child = Bun.spawn([process.execPath, new URL("../scripts/browser-login.cjs", import.meta.url).pathname], {
      env: { HOME: home, PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe",
    });
    expect(await child.exited).toBe(1);
    const status = JSON.parse(readFileSync(join(home, ".config/claude-browser/auth-status.json"), "utf8"));
    expect(status.state).toBe("error");
    expect(status.message).toBe("Configure CAI_EMAIL before starting browser login.");
  } finally { rmSync(home, { recursive: true, force: true }); }
});
