#!/usr/bin/env bun
/*
 * cs — command-line client for Coding Sessions.
 *
 * Runs agent work on your server from your machine. Control operations
 * (list / end / launch) go over the server's HTTPS API with a CLI token; a Synced
 * Launch additionally rsyncs your working tree up over SSH. Agents talk to the
 * server through MCP instead — `cs mcp add` sets that up. See docs/cli.md.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { findSession, fmtDur, makeMouseStripper, MCP_NAME, mcpAddCommand, mcpListedLine, mcpRemoveCommand, prettyProject, sanitizeName, shq, type McpClient } from "./cs-lib";

const CONFIG_DIR = join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "cs");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");

// The checkout this script runs from (Bun resolves symlinks), used by
// `--version` and `cs upgrade`.
const REPO_DIR = join(import.meta.dir, "..");

function csVersion(): string {
  try {
    return JSON.parse(readFileSync(join(REPO_DIR, "package.json"), "utf8")).version || "?";
  } catch {
    return "?";
  }
}

interface Config {
  api: string;       // https://sessions.example.com
  token: string;     // CLI token minted in the app: Settings → CLI access
  ssh: string;       // user@host — used for the Synced Launch upload and terminal commands
  cfId?: string;     // Cloudflare Access service-token Client-Id (if the domain is behind CF Access)
  cfSecret?: string; // Cloudflare Access service-token Client-Secret
  sshApi?: boolean;  // route API calls over SSH to the server's localhost (bypasses Cloudflare)
  origin?: string;   // server-local API URL used in SSH mode (default http://127.0.0.1:9121)
}

/* ---------- config ---------- */

function loadConfig(): Config {
  let file: Partial<Config> = {};
  if (existsSync(CONFIG_PATH)) {
    try { file = JSON.parse(readFileSync(CONFIG_PATH, "utf8")); } catch {}
  }
  return {
    api: (process.env.CS_API || file.api || "").replace(/\/$/, ""),
    token: process.env.CS_TOKEN || file.token || "",
    ssh: process.env.CS_SSH || file.ssh || "",
    cfId: process.env.CS_CF_ID || file.cfId || "",
    cfSecret: process.env.CS_CF_SECRET || file.cfSecret || "",
    sshApi: process.env.CS_SSH_API ? process.env.CS_SSH_API === "1" : (file.sshApi ?? false),
    origin: process.env.CS_ORIGIN || file.origin || "http://127.0.0.1:9121",
  };
}

function saveConfig(c: Config): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(CONFIG_PATH, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
}

/* ---------- tiny process helpers ---------- */

function capture(cmd: string[], cwd?: string): { code: number; out: string } {
  const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString().trim() };
}

function run(cmd: string[]): number {
  const p = Bun.spawnSync(cmd, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return p.exitCode;
}

// Best-effort copy to the macOS clipboard; silent no-op if pbcopy is absent.
function copyClipboard(text: string): boolean {
  try {
    return Bun.spawnSync(["pbcopy"], { stdin: new TextEncoder().encode(text) }).exitCode === 0;
  } catch {
    return false;
  }
}

function die(msg: string): never {
  console.error(`cs: ${msg}`);
  process.exit(1);
}

/* ---------- API ---------- */

function handleStatus(status: number, data: any): any {
  if (status === 401) throw new Error("token rejected — mint a fresh one in the app and run `cs login`.");
  if (status < 200 || status >= 300) throw new Error(data?.error || `HTTP ${status}`);
  return data;
}

// SSH transport: run curl against the app's localhost port on the server, tunnelled
// over the SSH you already have. Bypasses Cloudflare Access entirely — the API is
// never exposed to the internet. The request body is piped via stdin, not the argv.
async function sshApiRequest(cfg: Config, method: string, path: string, body: string | null): Promise<any> {
  const url = (cfg.origin || "http://127.0.0.1:9121") + path;
  const remote = [
    "curl", "-sS", "-X", method,
    "-H", `authorization: Bearer ${cfg.token}`,
    "-H", "content-type: application/json",
    ...(body != null ? ["--data-binary", "@-"] : []),
    "-w", "\\n%{http_code}",
    url,
  ].map(shq).join(" ");

  const proc = Bun.spawn(["ssh", "-o", "BatchMode=yes", cfg.ssh, remote], {
    stdin: body != null ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  if (body != null && proc.stdin) { proc.stdin.write(body); await proc.stdin.end(); }
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`ssh to ${cfg.ssh} failed: ${err.trim() || "exit " + code}. Check \`ssh ${cfg.ssh}\` works.`);
  const nl = out.lastIndexOf("\n");
  const status = Number(out.slice(nl + 1).trim()) || 0;
  let data: any = {};
  try { data = JSON.parse(out.slice(0, nl)); } catch {}
  return handleStatus(status, data);
}

async function api(cfg: Config, path: string, init?: RequestInit): Promise<any> {
  // Precondition failures throw (not die) so callers like `doctor` can catch
  // and report them; the dispatch loop renders thrown errors the same way.
  if (!cfg.token) throw new Error("no token configured — run `cs login` (mint one in the app's CLI access settings).");
  const method = (init?.method || "GET").toUpperCase();
  const body = init?.body != null ? String(init.body) : null;

  // Transport A: over SSH (Cloudflare-proof).
  if (cfg.sshApi) {
    if (!cfg.ssh) throw new Error("SSH API mode needs an SSH host — run `cs login`.");
    return sshApiRequest(cfg, method, path, body);
  }

  // Transport B: direct HTTPS (+ Cloudflare Access service token if configured).
  if (!cfg.api) throw new Error("no server configured — run `cs login`.");
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${cfg.token}`,
    ...((init?.headers as Record<string, string>) ?? {}),
  };
  if (cfg.cfId && cfg.cfSecret) {
    headers["CF-Access-Client-Id"] = cfg.cfId;
    headers["CF-Access-Client-Secret"] = cfg.cfSecret;
  }
  let res: Response;
  try {
    res = await fetch(cfg.api + path, { ...init, headers });
  } catch (e) {
    throw new Error(`can't reach ${cfg.api} (${(e as Error).message})`);
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("application/json")) {
    throw new Error(`the server returned a non-JSON page (HTTP ${res.status}) — the domain is likely behind Cloudflare Access.\n` +
        `  Fix: \`cs login\` and enable "route API over SSH", or add a CF Access service token. See README.`);
  }
  const data = await res.json().catch(() => ({}));
  return handleStatus(res.status, data);
}

/* ---------- helpers ---------- */

function repoSlug(): string | null {
  const url = capture(["git", "remote", "get-url", "origin"]).out;
  const m = url.match(/[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? `${m[1]}/${m[2]}` : null;
}

function insideGitRepo(): boolean {
  return capture(["git", "rev-parse", "--is-inside-work-tree"]).out === "true";
}

// How the local tree diverges from origin/<branch> — the exact state the server's
// prepare checks the fresh workspace out to (`git reset --hard origin/<branch>`).
// Returns null when they match (clean tree, HEAD pushed) so the rsync overlay can
// be skipped; any divergence (or doubt) returns a short reason and triggers rsync.
// Uses the local remote-tracking ref (no network fetch) — fine for the single-user
// flow; an unfetched upstream move is the one edge that would wrongly skip.
function localDivergence(branch: string): string | null {
  if (capture(["git", "status", "--porcelain"]).out !== "") { return "uncommitted changes"; }
  if (!branch) { return "detached HEAD"; }
  const local = capture(["git", "rev-parse", "HEAD"]).out;
  const remote = capture(["git", "rev-parse", `origin/${branch}`]).out;
  if (!remote) { return "branch not on origin yet"; }
  if (local !== remote) { return "unpushed commits"; }
  return null;
}

// ANSI colour, honoured only on a TTY and when NO_COLOR is unset.
const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
function paint(s: string, code: string): string {
  return useColor ? `\x1b[${code}m${s}\x1b[0m` : s;
}

async function pollClaudeUrl(cfg: Config, prefixedName: string): Promise<string | null> {
  for (let i = 0; i < 8; i++) {
    const { sessions } = await api(cfg, "/api/sessions");
    const s = (sessions as any[]).find((x) => x.name === prefixedName);
    if (s?.claudeUrl) return s.claudeUrl;
    await Bun.sleep(1500);
  }
  return null;
}

/* ---------- joining a server session (zmx, or legacy GNU screen) ---------- */

// The app holds sessions in zmx with its sockets in ~/.zmx unless ZMX_DIR says
// otherwise (the service has no XDG_RUNTIME_DIR), so remote zmx calls use it too.
const ZMX_ENV = 'export ZMX_DIR="${ZMX_DIR:-$HOME/.zmx}"; z="$HOME/.local/bin/zmx"; [ -x "$z" ] || z=zmx;';

// Is `session` held by zmx on the server? (No → it predates zmx and lives in screen.)
function zmxHas(cfg: Config, session: string): boolean {
  return capture(["ssh", cfg.ssh, `${ZMX_ENV} "$z" ls --short 2>/dev/null | grep -qxF -- ${shq(session)}`]).code === 0;
}

// Join a LIVE session as one more client, never creating one: `zmx attach` makes a
// session when the name is missing, which would leave a stray shell under a name
// the app thinks it owns. `false` ends at once if the session exits mid-check.
// env -u ZMX_SESSION: from inside a zmx shell, attach would retarget that terminal.
function zmxJoinCommand(session: string): string {
  return `${ZMX_ENV} "$z" ls --short 2>/dev/null | grep -qxF -- ${shq(session)} || ` +
    `{ echo "cs: ${session} is not running."; exit 1; }; exec env -u ZMX_SESSION "$z" attach ${shq(session)} false`;
}

// Attach this terminal to a running session. zmx passes the terminal through
// untouched, so this is native: your terminal's own scrollback, selection, mouse
// and colours, alongside the app and your phone. Screen sessions (started before
// the server moved to zmx) keep the old mouse-filtered `screen -x` path.
async function joinSession(cfg: Config, session: string): Promise<number> {
  if (zmxHas(cfg, session)) {
    console.log(paint("  detach: close the tab or Ctrl-\\ — it keeps running; the app/phone stay connected.", "2"));
    return run(["ssh", "-t", cfg.ssh, zmxJoinCommand(session)]);
  }
  console.log(paint("  (screen session) detach with Ctrl-a then d — it keeps running.", "2"));
  // -x = multi-display attach, never detaching other viewers. -tt forces the
  // remote PTY even though stdout is piped through the mouse filter.
  return attachFiltered(["ssh", "-tt", cfg.ssh, "screen", "-x", session]);
}

// Wait for a just-launched session to be listed by zmx, then join it.
async function waitAndJoin(cfg: Config, session: string): Promise<void> {
  for (let i = 0; i < 40 && !zmxHas(cfg, session); i++) await Bun.sleep(750);
  process.exit(await joinSession(cfg, session));
}

/* ---------- commands ---------- */

async function cmdList(cfg: Config, args: string[] = []): Promise<void> {
  const { sessions } = await api(cfg, "/api/sessions");
  const running = (sessions as any[]).filter((s) => s.status === "running");
  if (args.includes("--json")) { console.log(JSON.stringify(running, null, 2)); return; }
  if (!running.length) { console.log("No sessions running on the server."); return; }
  console.log(`${running.length} running:\n`);
  for (const s of running) {
    // Filled green dot = actively working; hollow dim dot = idle. No emoji —
    // they render at inconsistent widths in terminals.
    const dot = s.active ? paint("●", "32") : paint("○", "90");
    const bits = [s.model, s.uptimeSec ? fmtDur(s.uptimeSec) : null, prettyProject(s)].filter(Boolean);
    console.log(`${dot} ${s.name}\n  ${paint(bits.join("  ·  "), "2")}`);
  }
}

async function cmdEnd(cfg: Config, args: string[]): Promise<void> {
  const yes = args.includes("-y") || args.includes("--yes");
  const nameArg = args.find((a) => !a.startsWith("-"));
  if (!nameArg) die("usage: cs end <name> [-y]");
  const { sessions } = await api(cfg, "/api/sessions");
  const list = sessions as any[];
  const s =
    list.find((x) => x.name === nameArg) ??
    list.find((x) => x.name.endsWith(nameArg)) ??
    list.find((x) => x.name.includes(sanitizeName(nameArg)));
  if (!s) die(`no running session matching "${nameArg}". Try \`cs list\`.`);
  if (!yes) {
    const uptime = s.uptimeSec ? ` (running ${fmtDur(s.uptimeSec)})` : "";
    const ans = prompt(`End ${s.name}${uptime}? [y/N]:`);
    if (!/^y/i.test(ans || "")) { console.log("Aborted."); return; }
  }
  await api(cfg, `/api/sessions/${encodeURIComponent(s.id)}`, { method: "DELETE" });
  console.log(`Ended ${s.name}.`);
}

async function cmdOpen(cfg: Config, nameArg: string | undefined): Promise<void> {
  const { sessions } = await api(cfg, "/api/sessions");
  const list = sessions as any[];
  const s = nameArg
    ? list.find((x) => x.name === nameArg || x.name.endsWith(nameArg))
    : list.find((x) => x.claudeUrl);
  if (!s?.claudeUrl) die(nameArg ? `no claude.ai link for "${nameArg}".` : "no session with a claude.ai link yet.");
  console.log(s.claudeUrl);
  run(["open", s.claudeUrl]); // macOS; no-op elsewhere
  if (copyClipboard(s.claudeUrl)) { console.log(paint("copied to clipboard", "2")); }
}

// Interactive shell on the server. With a name, drops you into that session's
// workspace directory; without one, a plain login shell on the box.
async function cmdSsh(cfg: Config, nameArg: string | undefined): Promise<void> {
  if (!cfg.ssh) die("no SSH host configured. Run `cs login`.");
  let dir: string | null = null;
  if (nameArg) {
    const { sessions } = await api(cfg, "/api/sessions");
    const list = sessions as any[];
    const s =
      list.find((x) => x.name === nameArg) ??
      list.find((x) => x.name.endsWith(nameArg)) ??
      list.find((x) => x.name.toLowerCase().includes(sanitizeName(nameArg).toLowerCase()));
    if (!s) die(`no session matching "${nameArg}". Try \`cs list\`.`);
    dir = s.project || null;
    if (dir) { console.log(`${cfg.ssh}:${dir}`); }
  }
  const cmd = dir
    ? ["ssh", "-t", cfg.ssh, `cd ${shq(dir)} 2>/dev/null; exec "$SHELL" -l`]
    : ["ssh", cfg.ssh];
  process.exit(run(cmd));
}

// rsync the local working tree up onto a freshly prepared server workspace.
//
// Excludes gitignored paths from the upload (`:- .gitignore`) so we don't ship
// vendor/node_modules/build junk — but rsync's dir-merge excludes do NOT protect
// those paths from `--delete`. Without the explicit `P` (protect) rules below,
// `--delete` wipes the vendor / node_modules / .env that `prepare` inherited from
// the base checkout, leaving a workspace the app can't run in. (Verified: the bare
// `--filter=:- .gitignore` deletes vendor/** on the receiver.) The `P` rules keep
// those inherited artifacts while `--delete` still prunes genuinely-removed files.
function rsyncWorkTreeUp(cfg: Config, workspacePath: string): number {
  return run([
    "rsync", "-az", "--delete",
    "--filter=:- .gitignore",
    "--filter=P /vendor",
    "--filter=P /node_modules",
    "--filter=P /.env",
    "--exclude=.git/worktrees",
    "-e", "ssh",
    "./", `${cfg.ssh}:${workspacePath}/`,
  ]);
}

// Ensure <name>'s workspace exists on the server and, on first creation only,
// carries your local WIP up — then return its server path. Mirrors the Synced
// Launch contract exactly: `prepare` is destructive (rsync --delete from the base
// checkout + `git reset --hard origin/<branch>`), so it runs only when the state
// is "none"; afterwards the server workspace is the source of truth and this is a
// no-op (changes come back via git, never a re-sync down). Used by `cs term --sync`.
async function syncWorkspace(cfg: Config, name: string, repo: string, branch: string): Promise<string> {
  const st = await api(cfg, `/api/synced/status?name=${encodeURIComponent(name)}`);

  if (st.state === "live") {
    die(`"${st.name}" is already live on the server — an app session is running claude in its ` +
        `workspace.\n  A second claude in the same directory would clash. End it first:  cs end ${name}`);
  }

  if (st.state === "none") {
    if (!cfg.ssh) die("no SSH host configured for the upload. Run `cs login`.");
    process.stdout.write("Preparing workspace on the server… ");
    const prep = await api(cfg, "/api/synced/prepare", { method: "POST", body: JSON.stringify({ name, repo, branch }) });
    console.log("done.");
    const diff = localDivergence(branch);
    if (diff) {
      console.log(`Syncing local changes up (${diff}; gitignored paths skipped)…`);
      if (rsyncWorkTreeUp(cfg, prep.workspacePath) !== 0) {
        die("rsync failed — check your SSH access to the server.");
      }
    } else {
      console.log(`Workspace matches origin/${branch} — no upload needed.`);
    }
    return prep.workspacePath;
  }

  // "resumable": the workspace persists on the server and is the source of truth.
  console.log("Workspace already on the server — reattaching without a re-sync.");
  return st.workspacePath;
}

// Interactive Claude Code TUI on the server, inside a detachable zmx session.
// Unlike a Synced Launch (app/phone-driven, headless), this drops you straight
// into the terminal claude on the box, natively — zmx passes your terminal
// through, so scrollback, selection and mouse are your terminal's own. Close the
// terminal, lose the SSH link or press Ctrl-\\ and claude keeps running on the
// server; re-run the same command to reattach the live session.
//
//   cs term [name] [--sync] [--dir <path>] [-- <claude args…>]
//
// The session id is stable (`term-<name>`, derived from the name or current
// branch), which is what makes reattach work. --sync first uploads your working
// tree (Synced Launch: only on first creation) and runs claude in that workspace.
// Otherwise a matching app session's workspace is used, or pass --dir, or claude
// starts in your server login home.
async function cmdTerm(cfg: Config, args: string[]): Promise<void> {
  if (!cfg.ssh) die("no SSH host configured. Run `cs login`.");

  // Everything after `--` is forwarded verbatim to the remote `claude`.
  const dd = args.indexOf("--");
  const head = dd === -1 ? args : args.slice(0, dd);
  const claudeArgs = dd === -1 ? [] : args.slice(dd + 1);

  let dirArg: string | null = null, nameArg: string | null = null, sync = false;
  for (let i = 0; i < head.length; i++) {
    const a = head[i]!;
    if (a === "--sync" || a === "-S") { sync = true; }
    else if (a === "--dir") { dirArg = head[++i] ?? null; }
    else if (a === "--name" || a === "-n") { nameArg = head[++i] ?? null; }
    else if (!a.startsWith("-") && !nameArg) { nameArg = a; }
  }

  const branch = insideGitRepo() ? capture(["git", "branch", "--show-current"]).out : "";
  const base = sanitizeName(nameArg || branch) || "main";

  let dir = dirArg;
  if (sync) {
    // Upload the local working tree, then run claude on it (owns the directory).
    if (!insideGitRepo()) die("--sync must run inside a git checkout — cd into your project first.");
    const repo = repoSlug();
    if (!repo) die("couldn't read the origin remote. Run --sync from a checkout with an origin.");
    console.log(`→ ${base}   (${repo}${branch ? " @ " + branch : ""})`);
    dir = await syncWorkspace(cfg, base, repo, branch);
  } else if (!dir) {
    // Prefer a matching app session's workspace; else claude opens in the login home.
    try {
      const { sessions } = await api(cfg, "/api/sessions");
      const s = findSession(sessions as any[], nameArg || base);
      if (s?.project) { dir = s.project; }
    } catch { /* offline or no match — fall back to the login home dir */ }
  }

  // Not `cs-…`: that prefix belongs to sessions the app manages.
  const sessionName = `term-${base}`;
  // Run claude through a login shell so PATH (nvm/.local/bin/…) is populated;
  // `exec` replaces the shell so the session ends cleanly when claude quits.
  // `zmx attach` is create-or-attach (like tmux new -A): a new session starts in
  // the caller's cwd running the command; an existing one just gets this client.
  const claudeCmd = "exec " + ["claude", ...claudeArgs].map(shq).join(" ");
  const remote = `${ZMX_ENV} ${dir ? `cd ${shq(dir)} && ` : ""}` +
    `exec env -u ZMX_SESSION "$z" attach ${shq(sessionName)} bash -lc ${shq(claudeCmd)}`;

  console.log(`${paint("⇢", "36")} ${cfg.ssh}  ·  zmx ${sessionName}${dir ? "  ·  " + dir : ""}`);
  console.log(paint("  detach: close the tab or Ctrl-\\ — it keeps running on the server. Reattach: rerun this.", "2"));
  process.exit(run(["ssh", "-t", cfg.ssh, remote]));
}

// Attach interactively while filtering the session's output through `strip`.
// stdin is inherited so ssh puts the local tty in raw mode and keystrokes reach
// the session unchanged (fully interactive); only the output stream is rewritten.
async function attachFiltered(remote: string[]): Promise<number> {
  const strip = makeMouseStripper();
  const proc = Bun.spawn(remote, { stdin: "inherit", stdout: "pipe", stderr: "inherit" });
  for await (const chunk of proc.stdout as any) { process.stdout.write(strip.push(chunk)); }
  process.stdout.write(strip.flush());
  return await proc.exited;
}

// Mirror a LIVE server session in your terminal: attach as one more client
// alongside the app/phone, so you see and drive the SAME session. zmx sessions
// attach natively; older screen sessions go through the mouse-filtered
// `screen -x`. This attaches to an existing session; it does NOT start a new
// claude (that is what `cs term` / `--server --attach` are for).
async function cmdMirror(cfg: Config, nameArg: string | undefined): Promise<void> {
  if (!cfg.ssh) die("no SSH host configured. Run `cs login`.");
  const { sessions } = await api(cfg, "/api/sessions");
  const running = (sessions as any[]).filter((s) => s.status === "running");
  if (!running.length) die("no sessions running on the server. Start one with `cs --server` or `cs term`.");

  const name = nameArg || (insideGitRepo() ? sanitizeName(capture(["git", "branch", "--show-current"]).out) : "");
  let s = name ? findSession(running, name) : undefined;
  // Fall back to the sole running session only when there's no ambiguity.
  if (!s && !name && running.length === 1) { s = running[0]; }
  if (!s) {
    die(name
      ? `no live session matching "${name}". Try \`cs list\`.`
      : "several sessions are live — name one: `cs mirror <name>` (see `cs list`).");
  }

  // The holder's session name is the prefixed session name with cs-.
  const session = `cs-${s.name.toLowerCase()}`;
  console.log(`${paint("⇢", "36")} mirroring ${s.name}  ·  ${session}`);
  process.exit(await joinSession(cfg, session));
}

// One-shot health check of the whole setup: a ✓/✗ line per dependency with a
// fix hint on failure. Exits non-zero if anything is broken so it's scriptable.
async function cmdDoctor(cfg: Config): Promise<void> {
  type Check = { label: string; ok: boolean; hint?: string };
  const checks: Check[] = [];
  const onPath = (bin: string) => capture(["bash", "-lc", `command -v ${bin}`]).code === 0;
  const bin = (name: string, hint: string) =>
    checks.push(onPath(name) ? { label: name, ok: true } : { label: name, ok: false, hint });

  bin("bun", "install Bun — https://bun.sh");
  bin("claude", "install Claude Code (the `claude` CLI)");
  bin("rsync", "install rsync (ships with macOS + Xcode command-line tools)");

  checks.push(cfg.token && cfg.ssh && cfg.api
    ? { label: "config", ok: true }
    : { label: "config", ok: false, hint: `run \`cs login\` — token/ssh/api missing from ${CONFIG_PATH}` });

  if (cfg.ssh) {
    const r = capture(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", cfg.ssh, "true"]);
    checks.push(r.code === 0
      ? { label: `ssh ${cfg.ssh}`, ok: true }
      : { label: `ssh ${cfg.ssh}`, ok: false, hint: `passwordless \`ssh ${cfg.ssh}\` must work — install your key on the box` });
  } else {
    checks.push({ label: "ssh", ok: false, hint: "no SSH host — run `cs login`" });
  }

  if (cfg.token) {
    try {
      await api(cfg, "/api/sessions");
      checks.push({ label: "token", ok: true });
    } catch (e) {
      checks.push({ label: "token", ok: false, hint: (e as Error).message });
    }
  } else {
    checks.push({ label: "token", ok: false, hint: "no token — run `cs login`" });
  }

  for (const c of checks) {
    console.log(`${c.ok ? paint("✓", "32") : paint("✗", "31")} ${c.label}`);
    if (!c.ok && c.hint) { console.log(`  ${paint(c.hint, "2")}`); }
  }
  const failed = checks.filter((c) => !c.ok).length;
  console.log(failed
    ? paint(`\n${failed} check${failed === 1 ? "" : "s"} failed.`, "31")
    : paint("\nAll good.", "32"));
  process.exit(failed ? 1 : 0);
}

async function cmdLogin(): Promise<void> {
  const cur = loadConfig();
  console.log("Configure cs — press Enter to keep the shown value.\n");
  const apiUrl = (prompt(`Server URL, e.g. https://sessions.example.com [${cur.api || "required"}]:`) || cur.api || "").replace(/\/$/, "");
  if (!/^https?:\/\/[^/\s]+$/.test(apiUrl)) die("the server URL must look like https://sessions.example.com");
  const token = prompt(`CLI token [${cur.token ? "keep existing" : "required"}]:`) || cur.token;
  const ssh = prompt(`SSH host for uploads and terminals (user@host) [${cur.ssh || "optional"}]:`) || cur.ssh || "";
  const sshApiAns = prompt(`Route API over SSH to bypass Cloudflare Access? [${cur.sshApi ? "Y/n" : "y/N"}]:`);
  const sshApi = sshApiAns ? /^y/i.test(sshApiAns) : (cur.sshApi ?? false);
  let cfId = cur.cfId || "", cfSecret = cur.cfSecret || "";
  if (!sshApi) {
    console.log("\nCloudflare Access (only if the domain is behind Zero Trust — leave blank otherwise):");
    cfId = prompt(`  CF Access service-token Client-Id [${cur.cfId ? "keep existing" : "none"}]:`) || cfId;
    cfSecret = prompt(`  CF Access service-token Client-Secret [${cur.cfSecret ? "keep existing" : "none"}]:`) || cfSecret;
  }
  if (!token) die("a token is required — mint one in the app: Settings → CLI access.");
  saveConfig({ api: apiUrl, token, ssh, cfId, cfSecret, sshApi, origin: cur.origin });
  console.log(`\nSaved to ${CONFIG_PATH} (chmod 600).${sshApi ? "  API will tunnel over SSH." : ""}`);

  // Preflight: verify the token actually works before you rely on it.
  process.stdout.write("Verifying token… ");
  try {
    const { sessions } = await api(loadConfig(), "/api/sessions");
    const n = (sessions as any[]).filter((s) => s.status === "running").length;
    console.log(`ok — ${n} session${n === 1 ? "" : "s"} running.`);
  } catch (e) {
    console.log(`could not verify: ${(e as Error).message}`);
  }
}

async function cmdRun(cfg: Config, args: string[]): Promise<void> {
  // No --server: forward every arg to a local `claude` verbatim, so all of
  // claude's own flags work through cs — e.g. `cs -c`/`cs --continue`,
  // `cs -r`/`cs --resume`, `cs -p "quick q"`, `cs --model opus`.
  if (!args.includes("--server") && !args.includes("-s")) {
    process.exit(run(["claude", ...args]));
  }

  // --server: parse cs's own flags; the remaining words are the prompt.
  let name: string | null = null, repoArg: string | null = null, branchArg: string | null = null;
  let autoMode = false, attach = false;
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--server" || a === "-s") continue;
    else if (a === "--auto") autoMode = true;
    else if (a === "--attach" || a === "-a") attach = true;
    else if (a === "--name" || a === "-n") name = args[++i] ?? null;
    else if (a === "--repo") repoArg = args[++i] ?? null;
    else if (a === "--branch") branchArg = args[++i] ?? null;
    else words.push(a);
  }
  const prompt = words.join(" ").trim();

  // Synced Launch (or resume) on the server.
  if (!insideGitRepo()) die("not inside a git checkout — cd into your project first.");
  const branch = branchArg || capture(["git", "branch", "--show-current"]).out;
  const repo = repoArg || repoSlug();
  if (!repo) die("couldn't read the origin remote. Pass --repo owner/name.");
  const raw = sanitizeName(name || branch);
  if (!raw) die("couldn't derive a session name from the branch. Pass --name.");

  console.log(`→ ${raw}   (${repo}${branch ? " @ " + branch : ""})`);
  const st = await api(cfg, `/api/synced/status?name=${encodeURIComponent(raw)}`);

  const session = `cs-${String(st.name).toLowerCase()}`;
  if (st.state === "live" && attach) {
    if (prompt) console.log(paint("● already live — attaching; your prompt was not sent (type it in the session).", "33"));
    else console.log("● already live — attaching.");
    process.exit(await joinSession(cfg, session));
  }
  if (st.state === "live") {
    console.log("● already live — a prompt can't be injected into a running session. Either:");
    console.log(`  ${paint("mirror it in your terminal:", "2")}  cs mirror ${raw}`);
    console.log(`  ${paint("or drive it in the app:", "2")}      ${st.claudeUrl || "(link appears in the app)"}`);
    return;
  }

  let resumeId: string | null = null;
  if (st.state === "none") {
    process.stdout.write("Preparing workspace on the server… ");
    const prep = await api(cfg, "/api/synced/prepare", { method: "POST", body: JSON.stringify({ name: raw, repo, branch }) });
    console.log("done.");
    // The server's prepare already checked the workspace out to origin/<branch>.
    // Only overlay via rsync when the local tree diverges from that — uncommitted
    // changes, unpushed commits, or a branch not yet on origin.
    const diff = localDivergence(branch);
    if (diff) {
      if (!cfg.ssh) die("no SSH host configured for the upload. Run `cs login`.");
      console.log(`Syncing local changes up (${diff}; gitignored paths skipped)…`);
      if (rsyncWorkTreeUp(cfg, prep.workspacePath) !== 0) {
        die("rsync failed — check your SSH access to the server.");
      }
    } else {
      console.log(`Workspace matches origin/${branch} — no upload needed.`);
    }
  } else if (st.state === "resumable") {
    resumeId = st.resumeId ?? null;
    console.log("Resuming the existing conversation (workspace already on the server; no re-sync).");
  }

  process.stdout.write(prompt ? "Launching, seeded with your prompt… " : "Launching… ");
  await api(cfg, "/api/synced/launch", { method: "POST", body: JSON.stringify({ name: raw, prompt: prompt || null, resumeId, autoMode }) });
  console.log("started.");

  if (attach) {
    console.log(`${paint("⇢", "36")} attaching to ${st.name}  ·  also on your phone: open the app → ${st.name} → Terminal`);
    await waitAndJoin(cfg, session);
  }

  const link = await pollClaudeUrl(cfg, st.name);
  console.log(link ? `\nOpen in Claude:  ${link}` : "\nStarting up — it'll appear in the app and on your phone shortly.");
}

async function cmdUpgrade(): Promise<void> {
  if (capture(["git", "-C", REPO_DIR, "rev-parse", "--is-inside-work-tree"]).out !== "true") {
    die(`can't self-update — ${REPO_DIR} isn't a git checkout. Update it however you installed it.`);
  }
  const before = capture(["git", "-C", REPO_DIR, "rev-parse", "--short", "HEAD"]).out;
  console.log(`Updating cs in ${REPO_DIR}…`);
  if (run(["git", "-C", REPO_DIR, "pull", "--ff-only"]) !== 0) {
    die("git pull failed — resolve it in the checkout, then retry.");
  }
  const after = capture(["git", "-C", REPO_DIR, "rev-parse", "--short", "HEAD"]).out;
  console.log(before === after ? `Already up to date (${after}).` : `Updated ${before} → ${after}. Now on v${csVersion()}.`);
}

/*
 * Agents (Claude Code, Codex) reach the server over MCP; this CLI uses the HTTPS
 * API. `cs mcp add` registers the server's /mcp endpoint with an agent so it can
 * list, launch, message and read sessions itself.
 */
async function cmdMcp(cfg: Config, args: string[]): Promise<void> {
  const [action, clientArg] = args;
  const withToken = args.includes("--token");
  const client = clientArg as McpClient | undefined;
  const clients: McpClient[] = client ? [client] : ["claude", "codex"];
  if (client && client !== "claude" && client !== "codex") die("choose claude or codex, e.g. `cs mcp add claude`");
  const installed = (bin: string) => capture(["bash", "-lc", `command -v ${bin}`]).code === 0;

  if (action === "add") {
    if (!cfg.api) die("no server configured — run `cs login` first.");
    if (withToken && !cfg.token) die("--token needs a CLI token — run `cs login` first.");
    for (const c of clients) {
      if (!installed(c)) { if (client) die(`\`${c}\` is not installed here.`); continue; }
      const cmd = mcpAddCommand(c, cfg.api, { withToken: withToken && c === "claude" ? cfg.token : undefined });
      console.log(paint(`$ ${cmd.map((a) => a.startsWith("Authorization:") ? "'Authorization: Bearer •••'" : a).join(" ")}`, "2"));
      if (run(cmd) !== 0) die(`could not add the MCP server to ${c}.`);
      console.log(withToken
        ? c === "codex" ? `Added to Codex. Export your token before starting Codex:  export CS_TOKEN=…` : "Added to Claude Code with your CLI token."
        : c === "claude" ? "Added. In Claude Code run /mcp → coding-sessions → Authenticate once." : "Added. Codex opens a browser to sign in the first time it connects.");
    }
    return;
  }
  if (action === "remove") {
    const name = args.find((a, i) => i > 1 && !a.startsWith("-")) ?? MCP_NAME;
    for (const c of clients) if (installed(c)) run(mcpRemoveCommand(c, name));
    return;
  }
  if (action === "status") {
    for (const c of clients) {
      if (!installed(c)) { console.log(`${c}: not installed`); continue; }
      const listed = capture([c, "mcp", "list"]).out;
      const line = mcpListedLine(listed);
      console.log(`${c}: ${line ?? "not set up — run `cs mcp add " + c + "`"}`);
    }
    return;
  }
  console.log(`cs mcp — let Claude Code or Codex drive your sessions through MCP

  cs mcp add [claude|codex]          register ${cfg.api ? cfg.api + "/mcp" : "<server>/mcp"} (OAuth sign-in)
  cs mcp add [claude|codex] --token  use your CLI token instead (no browser needed;
                                       Codex reads it from $CS_TOKEN)
  cs mcp status                      show whether each agent has it
  cs mcp remove [claude|codex] [name]

Agents then get tools to list, launch, message, read and end sessions.
The CLI itself keeps using the HTTPS API; MCP is the agent-facing door.`);
}

/* ---------- dispatch ---------- */

function printHelp(): void {
  console.log(`cs — run Coding Sessions work on your server from this machine

USAGE
  cs                             launch a local claude session (bare)
  cs "<prompt>"                  run locally (passthrough to \`claude\`)
  cs -c | -r | --continue        continue/resume your last local claude session
  cs <any claude flags…>         forwarded verbatim to local \`claude\`
  cs --server "<prompt>"         run on the server (Synced Launch / resume)
  cs --server --name <n> "..."   override the session name (default: branch)
  cs --server                    start/resume with no prompt (babysit in the app)
  cs --server --attach "..."     ↑ then attach this terminal to it natively (zmx);
                                   rerun to reattach — it's also in the app/phone
  cs --server --auto …           start claude in auto mode

  cs list [--json]               list sessions running on the server
  cs end <name> [-y]             end a running session (-y skips the confirm)
  cs open [name]                 print, open, and copy the claude.ai link
  cs ssh [name]                  shell on the server (in the session's workspace)
  cs term [name] [-- claude…]    interactive claude on the server in zmx —
                                   close/detach and it keeps running; rerun to reattach
  cs term --sync [-- claude…]    ↑ but upload your working tree first (Synced Launch)
  cs mirror [name]               mirror a LIVE server session in your terminal
  cs mcp add|status|remove       let Claude Code / Codex drive sessions over MCP
  cs doctor                      check bun/claude/config/ssh/token/rsync setup
  cs pull                        git pull the current branch
  cs login                       configure server URL, token, and SSH host
  cs upgrade                     git-pull this checkout to the latest
  cs --version                   print the installed version

CONFIG   ${CONFIG_PATH}  (or env CS_API / CS_TOKEN / CS_SSH)
  Mint a token in the app:  Settings → CLI access → Generate token.`);
}

const argv = process.argv.slice(2);
const sub = argv[0];
const cfg = loadConfig();

try {
  switch (sub) {
    case "list": await cmdList(cfg, argv.slice(1)); break;
    case "end": await cmdEnd(cfg, argv.slice(1)); break;
    case "open": await cmdOpen(cfg, argv[1]); break;
    case "ssh": await cmdSsh(cfg, argv[1]); break;
    case "term": case "attach": await cmdTerm(cfg, argv.slice(1)); break;
    case "mirror": await cmdMirror(cfg, argv[1]); break;
    case "pull": process.exit(run(["git", "pull"])); break;
    case "login": await cmdLogin(); break;
    case "upgrade": await cmdUpgrade(); break;
    case "doctor": await cmdDoctor(cfg); break;
    case "mcp": await cmdMcp(cfg, argv.slice(1)); break;
    case "version": case "--version": case "-V": console.log(`cs v${csVersion()}`); break;
    case undefined: process.exit(run(["claude"])); break; // bare `cs` → local claude
    case "help": case "--help": case "-h": printHelp(); break;
    default: await cmdRun(cfg, argv);
  }
} catch (e) {
  die((e as Error).message);
}
