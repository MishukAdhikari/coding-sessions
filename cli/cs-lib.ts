/* Pure helpers for the `cs` CLI, kept apart so they can be tested without a server. */
import { lstatSync, readdirSync } from "node:fs";

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
export function mcpAddCommand(client: McpClient, api: string, opts: { withToken?: string; name?: string; tokenEnv?: string } = {}): string[] {
  const url = `${api.replace(/\/$/, "")}/mcp`;
  const name = opts.name ?? MCP_NAME;
  if (client === "claude") {
    return ["claude", "mcp", "add", "--transport", "http", "-s", "user", name, url,
      ...(opts.withToken ? ["--header", `Authorization: Bearer ${opts.withToken}`] : [])];
  }
  return ["codex", "mcp", "add", name, "--url", url, ...(opts.withToken ? ["--bearer-token-env-var", opts.tokenEnv ?? "CS_TOKEN"] : [])];
}

export function mcpRemoveCommand(client: McpClient, name = MCP_NAME): string[] {
  return client === "claude" ? ["claude", "mcp", "remove", "-s", "user", name] : ["codex", "mcp", "remove", name];
}

/** The line for `name` in `claude mcp list` / `codex mcp list` output, matched by name, not URL. */
export function mcpListedLine(output: string, name = MCP_NAME): string | null {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return output.split("\n").find((line) => new RegExp(`^\\s*${escaped}(?::|\\s)`).test(line))?.trim() ?? null;
}

/* ---------- named servers ---------- */

export interface ServerEntry {
  api: string;       // https://sessions.example.com
  token: string;     // CLI token (browser sign-in or Settings → CLI access)
  ssh: string;       // user@host — used for the Synced Launch upload and terminal commands
  sshApi?: boolean;  // route API calls over SSH to the server's localhost (bypasses Cloudflare)
  origin?: string;   // server-local API URL used in SSH mode (default http://127.0.0.1:9121)
  cfId?: string;     // Cloudflare Access service-token Client-Id
  cfSecret?: string; // Cloudflare Access service-token Client-Secret
}

export interface ConfigFile {
  servers: Record<string, ServerEntry>;
  default?: string;
}

const SERVER_NAME = /^[a-z0-9][a-z0-9_-]{0,30}$/;
export const isServerName = (name: unknown): name is string => typeof name === "string" && SERVER_NAME.test(name);

/** A short name for a server URL: its first DNS label ("lab" for https://lab.example.com), deduped. */
export function serverNameFromUrl(url: string, taken: Iterable<string> = []): string {
  let host = "";
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  const isIp = /^[\d.]+$/.test(host) || host.includes(":");
  let base = host === "localhost" || host.endsWith(".localhost") ? "local"
    : isIp || !host ? "server"
    : host.split(".")[0]!.replace(/[^a-z0-9_-]/g, "-").replace(/^[-_]+/, "").slice(0, 24).replace(/[-_]+$/, "");
  if (!isServerName(base)) base = "server";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; ; i++) if (!used.has(`${base}-${i}`)) return `${base}-${i}`;
}

/**
 * Read the config file's JSON. The old flat shape ({api, token, ssh, …}) becomes one
 * server named after its host and made the default; `migrated` says the caller should
 * back up the old file and save the new one.
 */
export function migrateConfig(raw: unknown): { config: ConfigFile; migrated: boolean } {
  const obj = raw && typeof raw === "object" ? raw as Record<string, any> : {};
  if (obj.servers && typeof obj.servers === "object") {
    const servers: Record<string, ServerEntry> = {};
    for (const [name, entry] of Object.entries(obj.servers)) if (isServerName(name) && entry && typeof entry === "object") servers[name] = entry as ServerEntry;
    return { config: { servers, default: isServerName(obj.default) && servers[obj.default] ? obj.default : undefined }, migrated: false };
  }
  if (!obj.api && !obj.token) return { config: { servers: {} }, migrated: false };
  const entry: ServerEntry = { api: String(obj.api || "").replace(/\/$/, ""), token: String(obj.token || ""), ssh: String(obj.ssh || "") };
  if (obj.sshApi) entry.sshApi = true;
  for (const key of ["origin", "cfId", "cfSecret"] as const) if (obj[key]) entry[key] = String(obj[key]);
  const name = serverNameFromUrl(entry.api);
  return { config: { servers: { [name]: entry }, default: name }, migrated: true };
}

/** The MCP connection name for a server: plain for the default, suffixed for the others. */
export const mcpNameFor = (server: string | undefined, isDefault: boolean) =>
  isDefault || !server ? MCP_NAME : `${MCP_NAME}-${server}`;

/** The env var Codex reads a server's token from: CS_TOKEN, or CS_TOKEN_LAB for "lab". */
export const tokenEnvFor = (server: string | undefined, isDefault: boolean) =>
  isDefault || !server ? "CS_TOKEN" : `CS_TOKEN_${server.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;

/** Subcommands that run on a server and take --server=<name> / -S <name> to choose it. */
export const SERVER_COMMANDS = new Set(["list", "end", "open", "ssh", "term", "attach", "mirror", "doctor", "mcp", "install", "login", "handoff", "live"]);

/**
 * Pull the server choice out of argv without disturbing anything else.
 *
 * `--server` alone keeps meaning "run this on the server" (default server) and stays in
 * place for the run parser. `--server=<name>` and `-S <name>` choose a server; in front of
 * a prompt they also mean "run on it". After a subcommand, bare `--server` just means the
 * default. `cs term` keeps `-S` as its short `--sync`. Nothing after `--` is touched.
 */
/** Subcommands that never talk to a chosen server (or choose it themselves). */
const LOCAL_COMMANDS = new Set(["server", "socket", "pull", "upgrade", "version", "--version", "-V", "help", "--help", "-h"]);
/** What parseServerArgs returns as `sub` for a prompt: local claude, or a run on the server. */
export const RUN = "<run>";

export function parseServerArgs(argv: string[]): { sub: string | undefined; args: string[]; server?: string } {
  // `cs --live [name]` (also after a leading -S <name> / --server=<name>) is `cs live [name]`.
  const liveAt = argv[0] === "--live" ? 0 : argv[1] === "--live" && argv[0]?.startsWith("--server=") ? 1 : argv[2] === "--live" && argv[0] === "-S" ? 2 : -1;
  if (liveAt >= 0) argv = [...argv.slice(0, liveAt), "live", ...argv.slice(liveAt + 1)];
  let server: string | undefined;
  const pick = (list: string[], keepBare: boolean, shortS: boolean) => {
    const out: string[] = [];
    let chose = false;
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      if (a === "--") { out.push(...list.slice(i)); break; }
      if (a.startsWith("--server=")) { const v = a.slice(9); if (v) { server = v; chose = true; } else if (keepBare) out.push("--server"); continue; }
      if (shortS && a === "-S" && i + 1 < list.length) { server = list[++i]; chose = true; continue; }
      if (a === "--server" && !keepBare) continue;
      out.push(a);
    }
    return { out, chose };
  };

  // A leading choice followed by a subcommand: `cs -S lab list`, `cs --server=lab list`.
  const lead = argv[0]?.startsWith("--server=") && argv[0].length > 9 ? 1 : argv[0] === "-S" && argv.length > 1 ? 2 : 0;
  if (lead && SERVER_COMMANDS.has(argv[lead] ?? "")) {
    server = lead === 1 ? argv[0]!.slice(9) : argv[1];
    const sub = argv[lead]!;
    return { sub, args: pick(argv.slice(lead + 1), false, sub !== "term" && sub !== "attach").out, server };
  }

  const sub = argv[0];
  if (sub && SERVER_COMMANDS.has(sub)) {
    return { sub, args: pick(argv.slice(1), false, sub !== "term" && sub !== "attach").out, server };
  }
  if (sub === undefined || LOCAL_COMMANDS.has(sub)) return { sub, args: argv.slice(1) };

  // The run path: `cs [--server[=name] | -S name] [flags] "<prompt>"`, flags in any order.
  const { out, chose } = pick(argv, true, true);
  if (chose && !out.includes("--server") && !out.includes("-s")) out.unshift("--server");
  return { sub: RUN, args: out, server };
}

/* ---------- cs handoff ---------- */

export interface HandoffArgs {
  name: string | null;
  instruction: string | null;
  compactHint: boolean;
  /** --live: follow the session in this terminal after it launches. */
  live: boolean;
  agent: "claude" | "codex";
  /** auto: by the transcript's estimated size; see chooseHandoffMode. */
  mode: "auto" | "full" | "compact" | "lean";
  error?: string;
}

const HANDOFF_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,30}$/;

/**
 * `cs handoff [name] ["<next instruction>"] [--full|--compact|--lean] [--compact-hint] [--agent claude|codex]`.
 * A first word that is a valid session name is the name when an instruction follows
 * it, or when it is the only word; anything else is the instruction.
 */
export function parseHandoffArgs(args: string[]): HandoffArgs {
  const out: HandoffArgs = { name: null, instruction: null, compactHint: false, live: false, agent: "claude", mode: "auto" };
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--compact-hint") out.compactHint = true;
    else if (a === "--full" || a === "--compact" || a === "--lean") {
      const m = a.slice(2) as HandoffArgs["mode"];
      if (out.mode !== "auto" && out.mode !== m) return { ...out, error: "pick one of --full, --compact and --lean." };
      out.mode = m;
    } else if (a === "--mode" || a.startsWith("--mode=")) {
      const v = a === "--mode" ? args[++i] : a.slice(7);
      if (v !== "auto" && v !== "full" && v !== "compact" && v !== "lean") return { ...out, error: "--mode takes auto, full, compact or lean." };
      out.mode = v;
    }
    else if (a === "--live") out.live = true;
    else if (a === "--agent" || a.startsWith("--agent=")) {
      const v = a === "--agent" ? args[++i] : a.slice(8);
      if (v !== "claude" && v !== "codex") return { ...out, error: "--agent takes claude or codex." };
      out.agent = v;
    } else if (a === "--name" || a === "-n") out.name = args[++i] ?? null;
    else if (/^-{1,2}[a-zA-Z]/.test(a) && !/\s/.test(a)) return { ...out, error: `unknown option ${a}` };
    else words.push(a);
  }
  if (!out.name && words.length && HANDOFF_NAME.test(words[0]!)) out.name = words.shift()!;
  out.instruction = words.join(" ").trim() || null;
  if (out.name && !HANDOFF_NAME.test(out.name)) return { ...out, error: "name must be 1-31 letters, numbers, dashes or underscores." };
  return out;
}

export interface LocalTranscript { path: string; id: string; bytes: number; mtimeMs: number }

/** Claude Code's transcript folder for a cwd: every non-alphanumeric becomes "-". */
export const claudeProjectDir = (home: string, cwd: string) => `${home}/.claude/projects/${cwd.replace(/[^a-zA-Z0-9]/g, "-")}`;

/**
 * The newest Claude Code conversation for `cwd`: the most recently written
 * `<id>.jsonl` in ~/.claude/projects/<munged cwd>/. Symlinks and odd names are skipped.
 */
export function findClaudeTranscript(home: string, cwd: string): LocalTranscript | null {
  const dir = claudeProjectDir(home, cwd);
  let best: LocalTranscript | null = null;
  let names: string[];
  try { names = readdirSync(dir); } catch { return null; }
  for (const f of names) {
    const m = /^([a-zA-Z0-9_-]{1,128})\.jsonl$/.exec(f);
    if (!m) continue;
    let st;
    try { st = lstatSync(`${dir}/${f}`); } catch { continue; }
    if (!st.isFile() || st.isSymbolicLink() || st.size === 0) continue;
    if (!best || st.mtimeMs > best.mtimeMs) best = { path: `${dir}/${f}`, id: m[1]!, bytes: st.size, mtimeMs: st.mtimeMs };
  }
  return best;
}

/**
 * Symlinked transcripts in the folder, newest first, by the link's own mtime.
 * findClaudeTranscript never follows them, so `cs handoff` names them instead of
 * silently handing off an older conversation or claiming there is none.
 */
export function symlinkedTranscripts(home: string, cwd: string): Array<{ name: string; mtimeMs: number }> {
  const dir = claudeProjectDir(home, cwd);
  let names: string[];
  try { names = readdirSync(dir); } catch { return []; }
  const out: Array<{ name: string; mtimeMs: number }> = [];
  for (const f of names) {
    if (!f.endsWith(".jsonl")) continue;
    try {
      const st = lstatSync(`${dir}/${f}`);
      if (st.isSymbolicLink()) out.push({ name: f, mtimeMs: st.mtimeMs });
    } catch {}
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** The remote command that receives a transcript on stdin into the Workspace's staging folder, 0600. */
export function handoffReceiveCommand(workspacePath: string, id: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error("bad transcript id");
  const dir = `${workspacePath}/.cs-handoff`;
  const part = `${dir}/${id}.jsonl.part`;
  return `umask 077 && rm -rf ${shq(dir)} && mkdir -m 700 ${shq(dir)} && cat > ${shq(part)} && mv ${shq(part)} ${shq(`${dir}/${id}.jsonl`)}`;
}

/* ---------- work tree upload (rsync) ---------- */

/**
 * One path from `git ls-files` as an anchored rsync pattern that matches only itself.
 * Wildcard characters go in a bracket class ([*]), which rsync and macOS's openrsync
 * both read literally; a backslash escape is not honoured by both.
 */
const rsyncLiteral = (path: string) => "/" + path.replace(/[*?[]/g, "[$&]").replace(/[\r\n]/g, "?");

/**
 * rsync excludes for the paths git ignores, from
 * `git ls-files -z --others --ignored --exclude-standard --directory`. git decides,
 * not rsync's `:- .gitignore` merge, which does not understand `!` re-includes: with
 * it a tracked `.env.example` under `.env.*` + `!.env.example` was excluded, and
 * `--delete` then removed it from the server's checkout. One pattern a line, for
 * `--exclude-from` (openrsync ignores --from0 there); a line break in a name is `?`.
 */
export function rsyncIgnoredExcludes(lsFilesZ: string): string {
  return lsFilesZ.split("\0").filter(Boolean).map((p) => rsyncLiteral(p) + "\n").join("");
}

/** The rsync command that mirrors the local work tree into a server Workspace. */
export function rsyncWorkTreeArgs(excludeFile: string, dest: string): string[] {
  return [
    "rsync", "-az", "--delete",
    `--exclude-from=${excludeFile}`,
    "--filter=P /vendor",
    "--filter=P /node_modules",
    "--filter=P /.env",
    "--exclude=/.git/worktrees",
    "-e", "ssh",
    "./", dest,
  ];
}

/* ---------- cs live ---------- */

/** A frame of the server's live feed (server/live.ts). */
export type LiveFrame = { type: string; [key: string]: any };

/** What the renderer remembers, so a reconnect or a poll never repeats itself. */
export interface LiveRenderState { greeted: boolean; activity: string | null; prs: Set<string>; asking: string | null }
export const newLiveRenderState = (): LiveRenderState => ({ greeted: false, activity: null, prs: new Set(), asking: null });

const LIVE_MAX_LINES = 12;

function indentLines(text: string, first: string, rest: string): string {
  const lines = text.split("\n");
  const shown = lines.slice(0, LIVE_MAX_LINES);
  if (lines.length > LIVE_MAX_LINES) shown.push(`… ${lines.length - LIVE_MAX_LINES} more lines`);
  return shown.map((l, i) => (i ? rest : first) + l).join("\n");
}

/**
 * One frame as terminal lines, or null when it repeats what is on screen already
 * (hello and state after a reconnect, a PR link seen before, the same question again).
 */
export function renderLiveFrame(f: LiveFrame, st: LiveRenderState, color = false): string | null {
  const c = (s: string, code: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  switch (f.type) {
    case "hello":
      if (st.greeted) return null;
      st.greeted = true;
      return `${c("●", "36")} live: ${f.name} ${c(`(${f.provider}${f.mode === "acp" ? ", chat" : ""})`, "2")}  ${c("Ctrl-C detaches; the session keeps running", "2")}`;
    case "state": {
      if (f.activity === st.activity) return null;
      st.activity = f.activity;
      if (f.activity !== "waiting") st.asking = null;
      const tone = f.activity === "running" ? "32" : f.activity === "waiting" ? "33" : f.activity === "failed" ? "31" : "2";
      return c(`◇ ${f.activity}`, tone);
    }
    case "message":
      return f.role === "user"
        ? indentLines(String(f.text), c("› ", "36"), "  ")
        : indentLines(String(f.text), c("◆ ", "35"), "  ");
    case "tool":
      return c(`  ⚙ ${f.text}`, "2");
    case "ask": {
      const key = `${f.text}|${(f.options ?? []).join("|")}`;
      if (st.asking === key) return null;
      st.asking = key;
      const opts = f.options?.length ? `\n  options: ${f.options.join(" | ")}` : "";
      return `${c(`? ${f.text}`, "1;33")}${opts}\n  ${c(`→ ${f.answer}`, "33")}`;
    }
    case "pr":
      if (st.prs.has(f.url)) return null;
      st.prs.add(f.url);
      return `${c("⇢", "36")} PR ${f.repo}#${f.number}  ${f.url}`;
    case "notice":
      return c(`  · ${f.text}`, "2");
    case "end":
      return c(`■ ${f.reason ?? `session ${f.activity}`}`, f.activity === "failed" ? "31" : "1");
    default:
      return null;
  }
}

/** Wait before reconnect attempt `n` (0-based): 1, 2, 4, 8, then 15 s. */
export const liveBackoffMs = (n: number) => Math.min(15_000, 1000 * 2 ** Math.min(n, 4));

/** The WebSocket URL of a session's live feed on `api` (http→ws, https→wss). */
export function liveSocketUrl(api: string, id: string, after: number | null): string {
  const base = api.replace(/\/+$/, "").replace(/^http/i, "ws");
  return `${base}/api/sessions/${encodeURIComponent(id)}/live${after !== null ? `?after=${after}` : ""}`;
}
