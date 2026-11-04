import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENT_PRESETS, findPreset, presetLaunch, type AgentPresetId } from "./agent-presets";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const home = () => { const dir = mkdtempSync(join(tmpdir(), "cs-presets-")); dirs.push(dir); return dir; };
const paths = { bunPath: "/opt/bun", bridgePath: "/app/communicator-stdio.ts", connectorBridgePath: "/app/connector-stdio.ts" };
const launch = (id: AgentPresetId, over: { unrestricted?: boolean; connectors?: boolean; home?: string } = {}) =>
  presetLaunch(findPreset(id)!, { unrestricted: false, connectors: false, home: over.home ?? home(), ...paths, ...over });

test("every preset is listed once and unknown ids are refused", () => {
  expect(AGENT_PRESETS.map(p => p.id)).toEqual(["gemini", "kimi", "qwen", "opencode"]);
  expect(findPreset("claude")).toBeNull();
  expect(findPreset(undefined)).toBeNull();
});

test("the no-prompt option is added only in unrestricted mode", () => {
  const expected: Record<AgentPresetId, string[]> = {
    gemini: ["--approval-mode=yolo", "--skip-trust"], kimi: ["--auto"], qwen: ["--approval-mode", "yolo"], opencode: ["--auto"],
  };
  for (const preset of AGENT_PRESETS) {
    const standard = launch(preset.id).args;
    for (const flag of expected[preset.id]) expect(standard).not.toContain(flag);
    expect(launch(preset.id, { unrestricted: true }).args.slice(0, expected[preset.id].length)).toEqual(expected[preset.id]);
  }
});

test("Gemini gets a user settings entry that references the token by name, and keeps other settings", () => {
  const dir = home();
  mkdirSync(join(dir, ".gemini"));
  writeFileSync(join(dir, ".gemini", "settings.json"), JSON.stringify({ theme: "dark", mcpServers: { mine: { command: "x" } } }));
  expect(launch("gemini", { home: dir })).toEqual({ args: [], env: {} });
  const file = join(dir, ".gemini", "settings.json");
  const settings = JSON.parse(readFileSync(file, "utf8"));
  expect(settings.theme).toBe("dark");
  expect(settings.mcpServers.mine).toEqual({ command: "x" });
  expect(settings.mcpServers.coding_sessions_communicator).toEqual({
    command: "/opt/bun", args: ["/app/communicator-stdio.ts"],
    env: { CS_COMMUNICATOR_TOKEN: "${CS_COMMUNICATOR_TOKEN}", CS_COMMUNICATOR_URL: "${CS_COMMUNICATOR_URL}" },
  });
  expect(settings.mcpServers.coding_sessions_connectors).toBeUndefined();
  expect(statSync(file).mode & 0o777).toBe(0o600);
  launch("gemini", { home: dir, connectors: true });
  expect(JSON.parse(readFileSync(file, "utf8")).mcpServers.coding_sessions_connectors).toMatchObject({ args: ["/app/connector-stdio.ts"], timeout: 130_000 });
});

test("Kimi gets a user MCP entry with no env, so the launch environment is inherited", () => {
  const dir = home();
  launch("kimi", { home: dir });
  const config = JSON.parse(readFileSync(join(dir, ".kimi-code", "mcp.json"), "utf8"));
  expect(config.mcpServers.coding_sessions_communicator).toEqual({ command: "/opt/bun", args: ["/app/communicator-stdio.ts"] });
});

test("an operator's own entry under the same name is never overwritten", () => {
  const dir = home();
  mkdirSync(join(dir, ".kimi-code"));
  writeFileSync(join(dir, ".kimi-code", "mcp.json"), JSON.stringify({ mcpServers: { coding_sessions_communicator: { command: "mine" } } }));
  expect(() => launch("kimi", { home: dir })).toThrow("already used");
  expect(JSON.parse(readFileSync(join(dir, ".kimi-code", "mcp.json"), "utf8")).mcpServers.coding_sessions_communicator).toEqual({ command: "mine" });
});

test("Qwen gets the server inline for this launch only, with no token in argv", () => {
  const dir = home();
  const { args, env } = launch("qwen", { home: dir, connectors: true, unrestricted: true });
  expect(env).toEqual({});
  const config = JSON.parse(args[args.indexOf("--mcp-config") + 1]!);
  expect(config.mcpServers.coding_sessions_communicator).toEqual({ command: "/opt/bun", args: ["/app/communicator-stdio.ts"] });
  expect(config.mcpServers.coding_sessions_connectors.timeout).toBe(130_000);
  expect(args.join(" ")).not.toContain("cscomm_");
});

test("opencode gets the server through its config variable with {env:} references", () => {
  const { args, env } = launch("opencode");
  expect(args).toEqual([]);
  const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT!);
  expect(config.mcp.coding_sessions_communicator).toEqual({
    type: "local", command: ["/opt/bun", "/app/communicator-stdio.ts"], enabled: true,
    environment: { CS_COMMUNICATOR_TOKEN: "{env:CS_COMMUNICATOR_TOKEN}", CS_COMMUNICATOR_URL: "{env:CS_COMMUNICATOR_URL}" },
  });
  expect(config.mcp.coding_sessions_connectors).toBeUndefined();
});
