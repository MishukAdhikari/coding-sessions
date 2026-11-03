import { expect, test } from "bun:test";
import { findSession, fmtDur, makeMouseStripper, mcpAddCommand, mcpListedLine, mcpRemoveCommand, prettyProject, sanitizeName, shq } from "./cs-lib";

test("session names follow the server's rule", () => {
  expect(sanitizeName("feature/Fix login!!")).toBe("feature-Fix-login");
  expect(sanitizeName("--x")).toBe("x");
  expect(sanitizeName("a".repeat(40))).toHaveLength(31);
});

test("a typed fragment finds the session by exact name, suffix, then substring", () => {
  const list = [{ name: "k-fix-login" }, { name: "k-billing" }];
  expect(findSession(list, "k-billing")?.name).toBe("k-billing");
  expect(findSession(list, "fix-login")?.name).toBe("k-fix-login");
  expect(findSession(list, "BILL")?.name).toBe("k-billing");
  expect(findSession(list, "nope")).toBeUndefined();
  expect(findSession(list, "!!")).toBeUndefined();
});

test("small formatting helpers", () => {
  expect(fmtDur(3720)).toBe("1h 2m");
  expect(fmtDur(90)).toBe("1m");
  expect(prettyProject({ name: "demo", project: "/home/cs/workspaces/demo" })).toBeNull();
  expect(prettyProject({ name: "demo", project: "/home/cs/code/app" })).toBe("~/code/app");
  expect(shq("it's")).toBe("'it'\\''s'");
});

test("mouse-tracking enables are stripped, even when split across reads", () => {
  const strip = makeMouseStripper();
  const text = (b: Uint8Array) => Buffer.from(b).toString("latin1");
  const out = text(strip.push(Buffer.from("a\x1b[?100"))) + text(strip.push(Buffer.from("6hb\x1b[1mc"))) + text(strip.flush());
  expect(out).toBe("ab\x1b[1mc");
});

test("MCP setup commands use OAuth by default and keep tokens out of Codex argv", () => {
  expect(mcpAddCommand("claude", "https://s.example.com/")).toEqual(
    ["claude", "mcp", "add", "--transport", "http", "-s", "user", "coding-sessions", "https://s.example.com/mcp"]);
  expect(mcpAddCommand("claude", "https://s.example.com", { withToken: "cs_x" }).slice(-2)).toEqual(["--header", "Authorization: Bearer cs_x"]);
  expect(mcpAddCommand("codex", "https://s.example.com", { withToken: "cs_x" })).toEqual(
    ["codex", "mcp", "add", "coding-sessions", "--url", "https://s.example.com/mcp", "--bearer-token-env-var", "CS_TOKEN"]);
  expect(mcpRemoveCommand("codex")).toEqual(["codex", "mcp", "remove", "coding-sessions"]);
});

test("MCP status matches the server by name, not by a URL that happens to contain it", () => {
  const claude = "other: https://coding-sessions.example.com/mcp (HTTP) - ✔ Connected\ncoding-sessions: https://s.example.com/mcp (HTTP) - ✔ Connected";
  expect(mcpListedLine(claude)).toBe("coding-sessions: https://s.example.com/mcp (HTTP) - ✔ Connected");
  expect(mcpListedLine("other: https://coding-sessions.example.com/mcp (HTTP)")).toBeNull();
  expect(mcpListedLine("Name   Url\ncoding-sessions  https://s.example.com/mcp  enabled")).toBe("coding-sessions  https://s.example.com/mcp  enabled");
});
