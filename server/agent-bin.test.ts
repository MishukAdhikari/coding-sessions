import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBin } from "./agent-bin";
import { bunCodexAuthProcessRunner } from "./codex-auth";
import { defaultCodexPreflightDependencies } from "./codex";
import { shellCommand } from "./terminal";
import { AGENT_PRESETS } from "./agent-presets";

const AGENTS = ["claude", "codex", "command-code", "gemini", "kimi", "qwen", "opencode"];
const never = () => null;

test("every agent: found on PATH (installed by hand), in ~/.local/bin (installed by the app), or not at all", () => {
  const home = mkdtempSync(join(tmpdir(), "agent-bin-"));
  try {
    mkdirSync(join(home, ".local", "bin"), { recursive: true });
    for (const name of AGENTS) {
      expect(agentBin(name, home, never)).toBeNull();
      expect(agentBin(name, home, (n) => n === name ? `/usr/bin/${n}` : null)).toBe(`/usr/bin/${name}`);
      writeFileSync(join(home, ".local", "bin", name), "");
      expect(agentBin(name, home, never)).toBe(join(home, ".local", "bin", name));
      // PATH wins over ~/.local/bin, as the shell would pick it.
      expect(agentBin(name, home, () => `/opt/${name}`)).toBe(`/opt/${name}`);
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("an agent installed beside another does not change where either is found", () => {
  const files = new Set(["/h/.local/bin/codex", "/h/.local/bin/opencode"]);
  const exists = (path: string) => files.has(path);
  expect(agentBin("codex", "/h", never, exists)).toBe("/h/.local/bin/codex");
  expect(agentBin("opencode", "/h", never, exists)).toBe("/h/.local/bin/opencode");
  expect(agentBin("gemini", "/h", never, exists)).toBeNull();
});

test("Codex sign-in and launch use the same lookup as the account list", async () => {
  expect(await bunCodexAuthProcessRunner.which()).toBe(agentBin("codex"));
  expect(await defaultCodexPreflightDependencies.which()).toBe(agentBin("codex"));
});

test("Sign in in a terminal runs exactly the agent's own login, then a shell", () => {
  const bin = (name: string) => `/home/svc/.local/bin/${name}`;
  expect(shellCommand(undefined, bin)).toBe("exec bash -l");
  expect(shellCommand("opencode", bin)).toBe("'/home/svc/.local/bin/opencode' 'auth' 'login'; exec bash -l");
  expect(shellCommand("kimi", bin)).toBe("'/home/svc/.local/bin/kimi' 'login'; exec bash -l");
  expect(shellCommand("gemini", bin)).toBe("'/home/svc/.local/bin/gemini'; exec bash -l");
  expect(shellCommand("qwen", bin)).toBe("'/home/svc/.local/bin/qwen'; exec bash -l");
  // Only the fixed preset list: anything else from a request is refused, not run.
  for (const bad of ["codex", "opencode; rm -rf ~", "", "../x"]) expect(shellCommand(bad, bin)).toBeNull();
  // Paths are quoted, so a space or quote in the home folder cannot split the command.
  expect(shellCommand("opencode", () => "/home/it's me/opencode")).toBe("'/home/it'\\''s me/opencode' 'auth' 'login'; exec bash -l");
});

test("no login command carries a secret: no env var value, key or token on the line", () => {
  for (const preset of AGENT_PRESETS) {
    const line = shellCommand(preset.id, (b) => `/bin/${b}`)!;
    expect(line).not.toMatch(/KEY|TOKEN|SECRET|=|\$/i);
    expect(preset.loginHint.length).toBeGreaterThan(0);
  }
});
