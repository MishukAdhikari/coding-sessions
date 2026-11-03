/* Pure helpers for the `cs` CLI, kept apart so they can be tested without a server. */

export const shq = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";

/** Match the server's session-name rule: /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/ */
export function sanitizeName(s: string): string {
  return s
    .replace(/[^a-zA-Z0-9_-]/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 31)
    .replace(/[-_]+$/, "");
}

/**
 * Resolve a session from a typed fragment: exact name, then suffix match
 * (fragments often omit the server's session prefix), then a sanitized substring.
 */
export function findSession<T extends { name: string }>(list: T[], nameArg: string): T | undefined {
  const fragment = sanitizeName(nameArg).toLowerCase();
  return list.find((x) => x.name === nameArg)
    ?? list.find((x) => x.name.endsWith(nameArg))
    ?? (fragment ? list.find((x) => x.name.toLowerCase().includes(fragment)) : undefined);
}

export function fmtDur(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** A short project label for `list`: drop a path that just repeats the session name; ~-abbreviate the rest. */
export function prettyProject(s: { name: string; project?: string | null; projectLabel?: string | null }): string | null {
  if (s.projectLabel) return s.projectLabel;
  const p = s.project;
  if (!p) return null;
  const base = p.split("/").pop() || p;
  if (base.toLowerCase() === s.name.toLowerCase()) return null;
  return p.replace(/^\/(?:home|Users)\/[^/]+\//, "~/");
}

/**
 * Streaming filter that removes mouse-tracking ENABLE sequences (DECSET 1000/1002/
 * 1003/1005/1006/1015/1016). GNU screen mishandles the SGR variant, so when a
 * terminal mirrors a screen session the mouse reports leak in as keystrokes; with
 * the enables stripped the terminal never reports. A carry buffer holds a trailing
 * partial escape so a sequence split across reads is never mis-emitted.
 */
export function makeMouseStripper(): { push(c: Uint8Array): Uint8Array; flush(): Uint8Array } {
  const MOUSE = /\x1b\[\?(?:1000|1001|1002|1003|1005|1006|1015|1016)[hl]/g;
  let carry = "";
  return {
    push(chunk: Uint8Array): Uint8Array {
      const s = carry + Buffer.from(chunk).toString("latin1");
      let cut = s.length;
      const esc = s.lastIndexOf("\x1b");
      if (esc !== -1 && /^\x1b\[?[\d;?]*$/.test(s.slice(esc))) cut = esc;
      carry = s.slice(cut);
      return Buffer.from(s.slice(0, cut).replace(MOUSE, ""), "latin1");
    },
    flush(): Uint8Array { const e = carry; carry = ""; return Buffer.from(e, "latin1"); },
  };
}

export type McpClient = "claude" | "codex";
export const MCP_NAME = "coding-sessions";

/**
 * The commands that register this server's MCP endpoint with an agent. OAuth is the
 * default (the agent opens a browser once); `withToken` uses the CLI token instead,
 * for machines without a browser. The token itself never goes in argv for Codex.
 */
export function mcpAddCommand(client: McpClient, api: string, opts: { withToken?: string } = {}): string[] {
  const url = `${api.replace(/\/$/, "")}/mcp`;
  if (client === "claude") {
    return ["claude", "mcp", "add", "--transport", "http", "-s", "user", MCP_NAME, url,
      ...(opts.withToken ? ["--header", `Authorization: Bearer ${opts.withToken}`] : [])];
  }
  return ["codex", "mcp", "add", MCP_NAME, "--url", url, ...(opts.withToken ? ["--bearer-token-env-var", "CS_TOKEN"] : [])];
}

export function mcpRemoveCommand(client: McpClient, name = MCP_NAME): string[] {
  return client === "claude" ? ["claude", "mcp", "remove", "-s", "user", name] : ["codex", "mcp", "remove", name];
}

/** The line for `name` in `claude mcp list` / `codex mcp list` output, matched by name, not URL. */
export function mcpListedLine(output: string, name = MCP_NAME): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return output.split("\n").find((line) => new RegExp(`^\\s*${escaped}(?::|\\s)`).test(line))?.trim() ?? null;
}
