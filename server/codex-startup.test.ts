import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedTerminalCommand, createStartupProbe, isCodexInputReady, isCodexFolderTrustPrompt, matchesCodexLaunchMarkers, readStartupViewport } from "./codex-startup";

const prompt = `You are in /work/example
  Trust this folder? Codex can read, edit, and run files here, subject to your permission settings. Folder settings
  may influence its behavior.
› 1. Trust and continue
  2. Back to Agent Command Center
`;
const target = { backend: "zmx" as const, screen: "cs-demo", zmxBin: "/bin/zmx" };

test("only the complete current folder-trust dialog is evidence of pending input", () => {
  expect(isCodexFolderTrustPrompt(prompt)).toBe(true);
  expect(isCodexFolderTrustPrompt(prompt.replace("› 1.", "1.").replace("  2.", "› 2."))).toBe(true);
  expect(isCodexFolderTrustPrompt(`\x1b[32m${prompt}\x1b[0m`)).toBe(true);
  for (const text of ["", "Trust this folder?", "An assistant discussed Trust and continue", prompt + "OpenAI Codex\nReady for your prompt", prompt + "Process exited", prompt.replace("2. Back to Agent Command Center", "")]) {
    expect(isCodexFolderTrustPrompt(text)).toBe(false);
  }
});

test("process marker binding requires the exact launch, screen and database", () => {
  const raw = "CS_LAUNCH_ID=first\0CS_SCREEN=cs-demo\0CS_DB_PATH=/data/app.db\0";
  expect(matchesCodexLaunchMarkers(raw, "first", "cs-demo", "/data/app.db")).toBe(true);
  expect(matchesCodexLaunchMarkers(raw, "second", "cs-demo", "/data/app.db")).toBe(false);
  expect(matchesCodexLaunchMarkers(raw, "first", "cs-other", "/data/app.db")).toBe(false);
  expect(matchesCodexLaunchMarkers(raw, "first", "cs-demo", "/other/app.db")).toBe(false);
  expect(matchesCodexLaunchMarkers(raw + "CS_LAUNCH_ID=second\0", "first", "cs-demo", "/data/app.db")).toBe(false);
});

const idle = `>_ OpenAI Codex (v0.166.0)
  /tmp/project

› Ask Codex to do anything

  GPT-5.6-Sol xhigh Fast · /tmp/project
  ? for shortcuts                    ⚠ 9 warnings · f2 to view
`;

test("only a current Codex input prompt and footer allow the first prompt", () => {
  expect(isCodexInputReady(idle)).toBe(true);
  expect(isCodexInputReady(`\x1b[32m${idle}\x1b[0m`)).toBe(true);
  for (const text of ["", "Ready", prompt, "Trust these hooks?\n› 1. Trust and continue", idle + prompt,
    idle + "Warnings · 1 of 9 · Startup\nProblem loading a skill\nk keep & next · esc dismiss & close · ^o copy · ←/→ warning",
    idle + "Process exited", idle.replace("› Ask Codex to do anything", "› typed input"),
    idle.replace("? for shortcuts", "Approval required"), idle + "\n".repeat(50)]) {
    expect(isCodexInputReady(text)).toBe(false);
  }
});

test("startup probes cache viewport reads but revalidate exact launch binding on every access", async () => {
  let now = 0, reads = 0;
  let text: string | null = prompt;
  let valid = true;
  const bindings: unknown[][] = [];
  const probe = createStartupProbe(async () => { reads++; return text; }, () => now,
    (...args) => { bindings.push(args); return valid; });
  expect(await Promise.all([probe("first", 1, target, "/data/app.db"), probe("first", 1, target, "/data/app.db")])).toEqual(["trust", "trust"]);
  expect(reads).toBe(1);
  expect(bindings).toEqual(Array.from({ length: 4 }, () => [1, "first", "cs-demo", "/data/app.db"]));
  valid = false;
  expect(await probe("first", 1, target, "/data/app.db")).toBe("unknown");
  expect(reads).toBe(1);
  valid = true;
  text = idle;
  expect(await probe("second", 1, target, "/data/app.db")).toBe("input");
  expect(await probe("first", 2, target, "/data/app.db")).toBe("input");
  now = 10_000;
  expect(await probe("first", 1, target, "/data/app.db")).toBe("input");
  text = null;
  now += 10_000;
  expect(await probe("first", 1, target, "/data/app.db")).toBe("unknown");
  const replacedDuringRead = createStartupProbe(async () => { valid = false; return idle; }, () => now, () => valid);
  expect(await replacedDuringRead("first", 1, target, "/data/app.db")).toBe("unknown");
});

test("screen probe uses a private current-viewport file and always removes it", async () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "xcs-startup-test-")));
  try {
    for (const fail of [false, true]) {
      const value = await readStartupViewport({ ...target, backend: "screen" }, {
        runtimeDirectory: base,
        run: async argv => {
          expect(argv.slice(0, 5)).toEqual(["screen", "-S", "cs-demo", "-X", "hardcopy"]);
          expect(argv).not.toContain("-h");
          const path = argv[5]!;
          expect(statSync(path).mode & 0o777).toBe(0o600);
          expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
          writeFileSync(path, prompt);
          return fail ? null : "";
        },
      });
      expect(value).toBe(fail ? null : prompt);
      expect(readdirSync(base)).toEqual([]);
    }
    expect(await readStartupViewport({ ...target, backend: "screen" }, {
      runtimeDirectory: base,
      run: async argv => { writeFileSync(argv[5]!, "x".repeat(65537)); return ""; },
    })).toBeNull();
    expect(readdirSync(base)).toEqual([]);
  } finally { rmSync(base, { recursive: true, force: true }); }
});

test("terminal reads cap output, reject failures and terminate hung probes", async () => {
  expect(await boundedTerminalCommand([process.execPath, "-e", "process.stdout.write('small')"])).toBe("small");
  expect(await boundedTerminalCommand([process.execPath, "-e", "process.stdout.write('x'.repeat(65537))"])).toBeNull();
  expect(await boundedTerminalCommand([process.execPath, "-e", "process.exit(1)"])).toBeNull();
  const started = Date.now();
  expect(await boundedTerminalCommand([process.execPath, "-e", "setInterval(()=>{},1000)"])).toBeNull();
  expect(Date.now() - started).toBeLessThan(2500);
});
