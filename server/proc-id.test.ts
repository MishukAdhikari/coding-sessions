import { test, expect } from "bun:test";
import { isClaudeProc, isCodexProc, hasRemoteControl } from "./sessions";

// Which ps rows count as a Session. The SCREEN daemon carries the same args
// string as the process it launched, so only the first token can be trusted —
// and remote control is now optional, so it can't be the discriminator.

test("the claude binary counts, by bare name or full path", () => {
  expect(isClaudeProc("claude --remote-control foo --dangerously-skip-permissions")).toBe(true);
  expect(isClaudeProc("/home/example/.local/bin/claude --remote-control foo")).toBe(true);
  expect(isClaudeProc("claude")).toBe(true);
});

test("a session launched WITHOUT remote control is still claude", () => {
  expect(isClaudeProc("/home/example/.local/bin/claude --dangerously-skip-permissions")).toBe(true);
});

test("THE TRAP: the screen daemon repeats the args but is not claude", () => {
  expect(isClaudeProc("SCREEN -dmS cs-foo bash -lc cd /srv && exec claude --remote-control foo")).toBe(false);
  expect(isClaudeProc("bash -lc cd /srv && exec /usr/bin/claude --remote-control foo")).toBe(false);
  expect(isClaudeProc("login -pflq example /usr/bin/claude --remote-control foo")).toBe(false);
});

test("lookalike binaries don't count", () => {
  expect(isClaudeProc("claudette --remote-control foo")).toBe(false);
  expect(isClaudeProc("/opt/not-claude-really/tool")).toBe(false);
  expect(isClaudeProc("")).toBe(false);
});

test("the interactive Codex binary counts, but wrappers and daemon modes do not", () => {
  expect(isCodexProc("codex --dangerously-bypass-approvals-and-sandbox -C /srv/app")).toBe(true);
  expect(isCodexProc("/home/example/.local/bin/codex resume -C /srv/app 019fb1c0-aaaa-7bbb-8ccc-0123456789ab")).toBe(true);
  expect(isCodexProc("codex app-server")).toBe(false);
  expect(isCodexProc("codex remote-control")).toBe(false);
  expect(isCodexProc("codex -m review -C /srv/app")).toBe(true);
  expect(isCodexProc("SCREEN -dmS cs-app bash -lc exec codex -C /srv/app")).toBe(false);
  expect(isCodexProc("bash -lc exec /usr/bin/codex -C /srv/app")).toBe(false);
  expect(isCodexProc("codex-helper -C /srv/app")).toBe(false);
});

test("remote control is detected as a whole token, not a substring", () => {
  expect(hasRemoteControl("claude --remote-control foo")).toBe(true);
  expect(hasRemoteControl("claude --dangerously-skip-permissions")).toBe(false);
  // a prompt or path merely mentioning the flag must not qualify
  expect(hasRemoteControl("claude --print fix-the---remote-control-docs")).toBe(false);
});
