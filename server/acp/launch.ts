/**
 * The holder command and environment for one Chat (ACP) launch. The holder runs the
 * bridge (bridge.ts); everything the bridge needs travels in its environment —
 * never argv, which /proc makes world-readable.
 */
import { fileURLToPath } from "node:url";
import { acpPaths, ensurePrivateDirs } from "./paths";

export const BRIDGE_PATH = fileURLToPath(new URL("./bridge.ts", import.meta.url));

export interface AcpLaunchInput {
  dataDir: string;
  screen: string;
  cwd: string;
  /** The agent's ACP command (agents.ts). */
  argv: string[];
  /** MCP stdio entries whose env values are ${VAR} references (communicator-config.ts entry()). */
  mcp: unknown[];
  resumeId?: string | null;
  autoAllow: boolean;
  bunPath?: string;
  bridgePath?: string;
}

const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** The command the holder runs: the bridge, in the session folder. */
export function acpHolderCommand(cwd: string, bunPath = process.execPath, bridgePath = BRIDGE_PATH): string {
  return `cd ${quote(cwd)} && exec ${quote(bunPath)} ${quote(bridgePath)}`;
}

/** Prepare the session's private directory and build the launch. */
export function buildAcpLaunch(input: AcpLaunchInput): { ok: true; inner: string; env: Record<string, string> } | { ok: false; error: string } {
  const resolved = acpPaths(input.dataDir, input.screen);
  if (!resolved.ok) return resolved;
  const dirs = ensurePrivateDirs(resolved.paths);
  if (!dirs.ok) return dirs;
  // Files are not cleared here: this runs before the launch has reserved the name, and a
  // refused launch must not touch a live session's log or socket. The bridge starts fresh.
  const env: Record<string, string> = {
    CS_ACP_DIR: resolved.paths.dir,
    CS_ACP_ARGV: JSON.stringify(input.argv),
    CS_ACP_CWD: input.cwd,
    CS_ACP_MCP: JSON.stringify(input.mcp),
  };
  if (input.resumeId) env.CS_ACP_RESUME = input.resumeId;
  if (input.autoAllow) env.CS_ACP_AUTO_ALLOW = "1";
  return { ok: true, inner: acpHolderCommand(input.cwd, input.bunPath, input.bridgePath), env };
}
