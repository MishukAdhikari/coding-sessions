/**
 * Agent presets: third-party CLI coding agents that register as Commands in one step.
 *
 * Each preset carries facts checked against the agent's own docs and a local install:
 * its binary, the option that turns its approval prompts off, how it loads an MCP
 * server, and whether its turn state can be read (kimi-state.ts). Tokens never appear in argv or in a config file — they reach the MCP bridge
 * through the launch environment, by inheritance or by a reference the agent expands.
 */
import { homedir } from "node:os";
import { entry, gatewayEntry, installUserMcpConfig, type Paths } from "./communicator-config";

export type AgentPresetId = "gemini" | "kimi" | "qwen" | "opencode";

export interface AgentPreset {
  id: AgentPresetId;
  label: string;
  bin: string;
  /** Token env var the agent reads from the environment, when it reads one. */
  envVar: string | null;
  /** npm package installed by deploy/install-provider-clis. */
  npmPackage: string;
  /** Added only when the server's permission mode is unrestricted at launch. */
  unrestrictedArgs: string[];
  /** How the communicator MCP server reaches this agent, for the docs and the UI. */
  mcp: string;
  homepage: string;
  notes: string;
  /**
   * Whether this app reads the agent's turn state (working, waiting for you,
   * finished) from a record the agent writes itself. Only true where that record
   * was checked against the agent's own source; the rest report liveness only.
   */
  turnState: boolean;
  /** The agent's own sign-in, run in a server terminal from Agent authentication. */
  loginArgs: string[];
  /** One line shown beside "Sign in in a terminal". */
  loginHint: string;
}

export const AGENT_PRESETS: readonly AgentPreset[] = [
  {
    id: "gemini", label: "Gemini CLI", bin: "gemini", envVar: "GEMINI_API_KEY", npmPackage: "@google/gemini-cli",
    // --skip-trust: Gemini starts MCP servers only in trusted folders.
    unrestrictedArgs: ["--approval-mode=yolo", "--skip-trust"],
    mcp: "~/.gemini/settings.json", homepage: "https://github.com/google-gemini/gemini-cli",
    notes: "Needs a Gemini API key or Gemini Code Assist. In standard mode, trust the folder when Gemini asks so its MCP servers start.",
    turnState: false,
    loginArgs: [], loginHint: "Starts Gemini; choose Login with Google, or enter a Gemini API key, when it asks.",
  },
  {
    id: "kimi", label: "Kimi Code", bin: "kimi", envVar: null, npmPackage: "@moonshot-ai/kimi-code",
    unrestrictedArgs: ["--auto"],
    mcp: "~/.kimi-code/mcp.json", homepage: "https://github.com/MoonshotAI/kimi-code",
    notes: "Sign in with `kimi login` in the server terminal; it does not read API keys from the environment.",
    turnState: true,
    loginArgs: ["login"], loginHint: "Runs kimi login; follow its prompts.",
  },
  {
    id: "qwen", label: "Qwen Code", bin: "qwen", envVar: "OPENAI_API_KEY", npmPackage: "@qwen-code/qwen-code",
    unrestrictedArgs: ["--approval-mode", "yolo"],
    mcp: "--mcp-config at launch", homepage: "https://github.com/QwenLM/qwen-code",
    notes: "Uses an OpenAI-compatible API key, or /auth inside the agent.",
    turnState: false,
    loginArgs: [], loginHint: "Starts Qwen Code; type /auth and choose a sign-in method.",
  },
  {
    id: "opencode", label: "opencode", bin: "opencode", envVar: null, npmPackage: "opencode-ai",
    unrestrictedArgs: ["--auto"],
    mcp: "OPENCODE_CONFIG_CONTENT at launch", homepage: "https://github.com/anomalyco/opencode",
    notes: "Sign in with `opencode auth login` in the server terminal.",
    turnState: false,
    loginArgs: ["auth", "login"], loginHint: "Runs opencode auth login; pick a provider and follow its prompts.",
  },
];

export function findPreset(id: unknown): AgentPreset | null {
  return AGENT_PRESETS.find(preset => preset.id === id) ?? null;
}

/** Whether a Command registered from this preset reports turn state. */
export const presetReadsTurnState = (id: unknown): boolean => findPreset(id)?.turnState === true;

export interface PresetLaunchOptions extends Paths {
  unrestricted: boolean;
  connectors: boolean;
  home?: string;
}

type StdioServer = { type: string; command: string; args: string[]; env: Record<string, string> };

/** Drop the transport field the built-in agents use; these agents infer stdio from `command`. */
function stdio(server: StdioServer, withEnv: boolean) {
  const { type: _type, env, ...rest } = server;
  return withEnv ? { ...rest, env } : rest;
}

/** Arguments after the binary, and environment to add, for one launch of a preset. */
export function presetLaunch(preset: AgentPreset, options: PresetLaunchOptions): { args: string[]; env: Record<string, string> } {
  const communicator = entry(options);
  const gateway = options.connectors ? gatewayEntry(options) : null;
  const args = options.unrestricted ? [...preset.unrestrictedArgs] : [];
  const home = options.home ?? homedir();
  switch (preset.id) {
    case "gemini":
      // Gemini strips token-like variables from what an MCP server inherits, so the
      // entry names them as ${VAR} references, which Gemini expands from its own env.
      installUserMcpConfig(home, [".gemini"], "settings.json", {
        communicator: stdio(communicator, true),
        gateway: gateway ? { ...stdio(gateway, true), timeout: 130_000 } : null,
      }, "Gemini CLI", true);
      return { args, env: {} };
    case "kimi":
      // Kimi passes its environment to MCP servers but does not expand ${VAR}.
      installUserMcpConfig(home, [".kimi-code"], "mcp.json", {
        communicator: stdio(communicator, false),
        gateway: gateway ? stdio(gateway, false) : null,
      }, "Kimi Code");
      return { args, env: {} };
    case "qwen": {
      const servers: Record<string, unknown> = { coding_sessions_communicator: stdio(communicator, false) };
      if (gateway) servers.coding_sessions_connectors = { ...stdio(gateway, false), timeout: 130_000 };
      return { args: [...args, "--mcp-config", JSON.stringify({ mcpServers: servers })], env: {} };
    }
    case "opencode": {
      const local = (server: StdioServer) => ({
        type: "local", command: [server.command, ...server.args], enabled: true,
        environment: Object.fromEntries(Object.keys(server.env).map(name => [name, `{env:${name}}`])),
      });
      const mcp: Record<string, unknown> = { coding_sessions_communicator: local(communicator) };
      if (gateway) mcp.coding_sessions_connectors = local(gateway);
      return { args, env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ mcp }) } };
    }
  }
}
