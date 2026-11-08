/**
 * Which agents can run in Chat (ACP) mode, and the command that speaks ACP for each.
 *
 * Checked on 2026-11-08 against each agent's own source and the ACP registry
 * (github.com/agentclientprotocol/registry): every command below runs ACP over stdio
 * and advertises session/load.
 *
 *   Claude Code   claude-agent-acp   npm @agentclientprotocol/claude-agent-acp (uses the claude login)
 *   Codex         codex-acp          npm @agentclientprotocol/codex-acp (CODEX_API_KEY / OPENAI_API_KEY or codex login)
 *   Command Code  <cmd> acp          the installed Command Code CLI
 *   Gemini CLI    <gemini> --acp     preset
 *   Qwen Code     <qwen> --acp       preset
 *   opencode      <opencode> acp     preset
 *   Kimi Code     <kimi> acp         preset
 *
 * The adapters are resolved on PATH or in ~/.local/bin and are never fetched at
 * launch: a missing one is refused with the command that installs it.
 */
import type { AgentPresetId } from "../agent-presets";
import { findCommand, presetBin, resolveBin } from "../commands";
import { commandSlug, isCommandProvider, type SessionProvider } from "../session-provider";

export interface AcpAgentInfo { provider: SessionProvider; label: string; available: boolean; reason: string | null }

const ADAPTERS = {
  claude: { label: "Claude Code", bin: "claude-agent-acp", npm: "@agentclientprotocol/claude-agent-acp" },
  codex: { label: "Codex", bin: "codex-acp", npm: "@agentclientprotocol/codex-acp" },
} as const;

/** The ACP arguments after a preset's own binary. */
export const PRESET_ACP_ARGS: Readonly<Record<AgentPresetId, readonly string[]>> = {
  gemini: ["--acp"],
  qwen: ["--acp"],
  opencode: ["acp"],
  kimi: ["acp"],
};

export interface AcpResolveDeps {
  /** A binary's absolute path when installed and executable, else null. */
  bin(name: string): string | null;
  /** The Command Code CLI's path, or why it can't run. */
  commandCode(): Promise<{ ok: true; bin: string } | { ok: false; message: string }>;
}

const defaultBin = (name: string): string | null => {
  const resolved = resolveBin(presetBin(name));
  return resolved.ok ? resolved.path : null;
};

/** The agent's ACP command, or why this provider can't run in Chat mode. */
export async function acpCommand(provider: SessionProvider, deps: AcpResolveDeps): Promise<{ ok: true; argv: string[] } | { ok: false; error: string }> {
  if (provider === "claude" || provider === "codex") {
    const adapter = ADAPTERS[provider];
    const bin = deps.bin(adapter.bin);
    return bin ? { ok: true, argv: [bin] } : { ok: false, error: missingAdapter(adapter) };
  }
  if (provider === "command-code") {
    const cc = await deps.commandCode();
    return cc.ok ? { ok: true, argv: [cc.bin, "acp"] } : { ok: false, error: cc.message };
  }
  if (isCommandProvider(provider)) {
    const slug = commandSlug(provider);
    const command = slug ? findCommand(slug) : null;
    if (!command) return { ok: false, error: "That command is no longer registered." };
    if (!command.preset) return { ok: false, error: `${command.label} has no known Agent Client Protocol command. Chat mode needs an agent registered from a preset.` };
    const resolved = resolveBin(command.bin);
    if (!resolved.ok) return { ok: false, error: resolved.error };
    return { ok: true, argv: [resolved.path, ...PRESET_ACP_ARGS[command.preset]] };
  }
  return { ok: false, error: "This agent can't run in Chat mode." };
}

function missingAdapter(adapter: { label: string; bin: string; npm: string }): string {
  return `${adapter.label} chat needs the ACP adapter ${adapter.bin}, which is not installed for the service user. Install it with: npm install -g ${adapter.npm}`;
}

/** Each launchable agent and whether Chat mode is available for it here, for the launch sheet. */
export function listAcpAgents(providers: Array<{ id: SessionProvider; name: string }>, bin: (name: string) => string | null = defaultBin, commandCodeBin: string | null = null): AcpAgentInfo[] {
  return providers.map(({ id, name }) => {
    if (id === "claude" || id === "codex") {
      const adapter = ADAPTERS[id];
      const ok = !!bin(adapter.bin);
      return { provider: id, label: name, available: ok, reason: ok ? null : missingAdapter(adapter) };
    }
    if (id === "command-code") {
      return { provider: id, label: name, available: !!commandCodeBin, reason: commandCodeBin ? null : "The Command Code CLI is not installed for the service user (npm i -g command-code)." };
    }
    if (isCommandProvider(id)) {
      const slug = commandSlug(id);
      const command = slug ? findCommand(slug) : null;
      if (!command?.preset) return { provider: id, label: name, available: false, reason: "Chat mode needs an agent registered from a preset (Gemini, Qwen, opencode or Kimi)." };
      return { provider: id, label: name, available: true, reason: null };
    }
    return { provider: id, label: name, available: false, reason: "This agent can't run in Chat mode." };
  });
}

export const defaultAcpResolveDeps = (commandCode: AcpResolveDeps["commandCode"]): AcpResolveDeps => ({ bin: defaultBin, commandCode });
