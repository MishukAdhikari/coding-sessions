import { expect, test } from "bun:test";
import { findSession, fmtDur, makeMouseStripper, mcpAddCommand, mcpListedLine, mcpNameFor, mcpRemoveCommand, migrateConfig, parseServerArgs, prettyProject, RUN, sanitizeName, serverNameFromUrl, shq, tokenEnvFor } from "./cs-lib";

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

test("server names come from the first DNS label and never clash", () => {
  expect(serverNameFromUrl("https://lab.example.com")).toBe("lab");
  expect(serverNameFromUrl("https://coding-sessions.example.net/")).toBe("coding-sessions");
  expect(serverNameFromUrl("https://lab.example.org", ["lab", "lab-2"])).toBe("lab-3");
  expect(serverNameFromUrl("http://localhost:9121")).toBe("local");
  expect(serverNameFromUrl("http://10.0.0.5:9121")).toBe("server");
  expect(serverNameFromUrl("not a url")).toBe("server");
});

test("an old flat config becomes one default server; a new one is kept as is", () => {
  const old = { api: "https://sessions.example.com/", token: "cs_x", ssh: "me@box", sshApi: true, cfId: "", origin: "http://127.0.0.1:9121" };
  expect(migrateConfig(old)).toEqual({
    migrated: true,
    config: { default: "sessions", servers: { sessions: { api: "https://sessions.example.com", token: "cs_x", ssh: "me@box", sshApi: true, origin: "http://127.0.0.1:9121" } } },
  });
  const current = { servers: { lab: { api: "https://lab.example.com", token: "cs_y", ssh: "" } }, default: "lab" };
  expect(migrateConfig(current)).toEqual({ migrated: false, config: current });
  expect(migrateConfig({ servers: { lab: current.servers.lab }, default: "gone" }).config.default).toBeUndefined();
  expect(migrateConfig(null)).toEqual({ migrated: false, config: { servers: {} } });
});

test("bare --server keeps meaning run on the default server", () => {
  expect(parseServerArgs(["--server", "fix test"])).toEqual({ sub: RUN, args: ["--server", "fix test"], server: undefined });
  expect(parseServerArgs(["--server", "--name", "x", "--attach", "--auto", "go"]).args)
    .toEqual(["--server", "--name", "x", "--attach", "--auto", "go"]);
  expect(parseServerArgs(["fix it", "--server"]).args).toEqual(["fix it", "--server"]);
  expect(parseServerArgs(["-c"])).toEqual({ sub: RUN, args: ["-c"], server: undefined });
  expect(parseServerArgs([])).toEqual({ sub: undefined, args: [] });
});

test("--server=<name> and -S <name> choose a server and mean run on it", () => {
  expect(parseServerArgs(["--server=lab", "fix test"])).toEqual({ sub: RUN, args: ["--server", "fix test"], server: "lab" });
  expect(parseServerArgs(["--server=lab", "--attach", "--name", "x", "go"]).args).toEqual(["--server", "--attach", "--name", "x", "go"]);
  expect(parseServerArgs(["-S", "lab", "--auto", "go"])).toEqual({ sub: RUN, args: ["--server", "--auto", "go"], server: "lab" });
  expect(parseServerArgs(["--server", "-S", "lab", "go"]).args).toEqual(["--server", "go"]);
  expect(parseServerArgs(["--server=", "go"])).toEqual({ sub: RUN, args: ["--server", "go"], server: undefined });
});

test("server commands take the choice before or after the command", () => {
  expect(parseServerArgs(["list", "--server=lab", "--json"])).toEqual({ sub: "list", args: ["--json"], server: "lab" });
  expect(parseServerArgs(["end", "-S", "lab", "fix", "-y"])).toEqual({ sub: "end", args: ["fix", "-y"], server: "lab" });
  expect(parseServerArgs(["-S", "lab", "list"])).toEqual({ sub: "list", args: [], server: "lab" });
  expect(parseServerArgs(["--server=lab", "mcp", "add"])).toEqual({ sub: "mcp", args: ["add"], server: "lab" });
  expect(parseServerArgs(["list", "--server"])).toEqual({ sub: "list", args: [], server: undefined });
});

test("cs term keeps -S as --sync and nothing after -- is touched", () => {
  expect(parseServerArgs(["term", "-S", "x"])).toEqual({ sub: "term", args: ["-S", "x"], server: undefined });
  expect(parseServerArgs(["term", "--server=lab", "--sync"])).toEqual({ sub: "term", args: ["--sync"], server: "lab" });
  expect(parseServerArgs(["term", "x", "--", "--server=lab"]).args).toEqual(["x", "--", "--server=lab"]);
  expect(parseServerArgs(["server", "add", "lab", "https://lab.example.com"]).args).toEqual(["add", "lab", "https://lab.example.com"]);
});

test("MCP names and token variables are plain for the default server, suffixed for others", () => {
  expect(mcpNameFor("lab", true)).toBe("coding-sessions");
  expect(mcpNameFor("lab", false)).toBe("coding-sessions-lab");
  expect(tokenEnvFor("my-vps", false)).toBe("CS_TOKEN_MY_VPS");
  expect(tokenEnvFor("lab", true)).toBe("CS_TOKEN");
  expect(mcpAddCommand("codex", "https://lab.example.com", { withToken: "cs_x", name: "coding-sessions-lab", tokenEnv: "CS_TOKEN_LAB" }))
    .toEqual(["codex", "mcp", "add", "coding-sessions-lab", "--url", "https://lab.example.com/mcp", "--bearer-token-env-var", "CS_TOKEN_LAB"]);
  expect(mcpAddCommand("claude", "https://lab.example.com", { name: "coding-sessions-lab" })[7]).toBe("coding-sessions-lab");
});
