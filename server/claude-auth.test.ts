import { test, expect, describe } from "bun:test";
import { extractOauthUrl, screenError } from "./claude-auth";

/**
 * Fixtures captured from a real `claude auth login` run inside `screen` on the
 * deploy host. Both shapes matter: the screen log carries the URL as an OSC 8
 * hyperlink target, while `screen -X hardcopy` only has the visible window,
 * where the terminal has hard-wrapped the URL across lines.
 */
const FULL_URL =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e" +
  "&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback" +
  "&scope=org%3Acreate_api_key+user%3Aprofile+user%3Ainference" +
  "&code_challenge=tBwXeDI076OR1PAkV8gYc_nvZCz1k1jEXm4XsGnwf4Q&code_challenge_method=S256" +
  "&state=tFvgfbVStUnhYjlWA7vZdkVkKRmSvkjCwBniqGdc4FQ";

/** Wrap like an 80-column terminal does: a hard break every 80 chars, no hyphen. */
const wrapped = (s: string) => (s.match(/.{1,80}/g) ?? []).join("\n");

describe("extractOauthUrl", () => {
  test("prefers the OSC 8 hyperlink target in the screen log", () => {
    const log = `\x1b[37mOpening browser\x1b[39m\r\r\n\x1b]8;;${FULL_URL}\x07\x1b[37m${FULL_URL.slice(0, 80)}\x1b[39m\x1b]8;;\x07\r\r\n`;
    expect(extractOauthUrl(log)).toBe(FULL_URL);
  });

  test("stitches a URL the terminal hard-wrapped across lines", () => {
    const hardcopy = `Opening browser to sign in\nIf the browser didn't open, visit: ${wrapped(FULL_URL)}\nPaste code here if prompted >\n`;
    expect(extractOauthUrl(hardcopy)).toBe(FULL_URL);
  });

  test("stops stitching at prose, so trailing UI text never joins the URL", () => {
    // Regression: joining every line glued "Pastecodehereifprompted" onto the URL.
    const hardcopy = `visit: ${wrapped(FULL_URL)}\nPaste code here if prompted >\n`;
    const url = extractOauthUrl(hardcopy);
    expect(url).not.toContain("Paste");
    expect(url?.endsWith("state=tFvgfbVStUnhYjlWA7vZdkVkKRmSvkjCwBniqGdc4FQ")).toBe(true);
  });

  test("does not truncate at the carriage returns screen writes between wrapped chunks", () => {
    // Regression: \r counts as \S-terminating whitespace, which cut the URL at 80 chars.
    const log = wrapped(FULL_URL).split("\n").join("\r\r\n");
    expect(extractOauthUrl(log)).toBe(FULL_URL);
  });

  test("returns null when no login URL is present", () => {
    expect(extractOauthUrl("Welcome to Claude Code\nPaste code here if prompted >")).toBeNull();
  });
});

describe("screenError", () => {
  test("reports a rejected code from the CLI's error line", () => {
    const visible = "Welcome to Claude Code v2.1.226\n OAuth error: Request failed with status code 400\n Press Enter to retry.\n";
    expect(screenError(visible)).toBe("OAuth error: Request failed with status code 400");
  });

  test("treats a bare retry prompt as an error so the run isn't reused", () => {
    expect(screenError("Press Enter to retry.")).toContain("Start over");
  });

  test("a healthy prompt is not an error", () => {
    expect(screenError("Paste code here if prompted >")).toBeNull();
  });
});

test("Claude records only confirmed new login once, never stale status or cancelled attempts", async () => {
  const { createClaudeLoginTracker } = await import("./claude-auth");
  let records = 0;
  const tracker = createClaudeLoginTracker(() => { records++; });
  await tracker.observe(true, "Successfully logged in");
  expect(records).toBe(0);
  tracker.begin();
  await tracker.observe(true, "Waiting for login");
  await tracker.observe(false, "Successfully logged in");
  await tracker.observe(true, "Login failed\nSuccessfully logged in");
  expect(records).toBe(0);
  await tracker.observe(true, "Successfully logged in");
  await tracker.observe(true, "Successfully logged in");
  expect(records).toBe(1);
  tracker.begin();
  tracker.cancel();
  await tracker.observe(true, "Successfully logged in");
  expect(records).toBe(1);
});

import { privateAuthFiles } from "./claude-auth";
import { mkdtempSync, realpathSync, statSync, symlinkSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

test("auth output is unique and private, and rejects symlinked runtime directories", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "xs-auth-test-"));
  try {
    const first = privateAuthFiles(root), second = privateAuthFiles(root);
    expect(first.log).not.toBe(second.log);
    expect(statSync(dirname(first.log)).mode & 0o777).toBe(0o700);
    for (const file of Object.values(first)) expect(statSync(file).mode & 0o777).toBe(0o600);
    const elsewhere = join(root, "elsewhere"); mkdirSync(elsewhere);
    const linked = join(root, "linked"); symlinkSync(elsewhere, linked);
    expect(() => privateAuthFiles(linked)).toThrow();
    expect(existsSync(join(elsewhere, "auth"))).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
