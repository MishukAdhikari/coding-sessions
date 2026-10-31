import { createTerminalSocket, secureTerminalSocket } from "./terminal-socket";
import { childEnvironment } from "./child-env";
/**
 * Web terminals — an on-demand, writable browser terminal for a server session.
 *
 * Mechanism: for each open terminal we spawn a `ttyd` bound to a private Unix-domain socket, serving its own xterm.js UI under `--base-path /term/<id>`.
 * The Bun server (index.ts) reverse-proxies `/term/<id>/…` (HTTP + the `/ws`
 * upgrade) to that ttyd, so the terminal rides the one CF-Zero-Trust-gated
 * origin behind the existing auth wall — no extra port is ever exposed.
 *
 * Everything runs inside a session holder (zmx, or GNU screen for sessions
 * started before it — see mux.ts), so closing the browser tab *detaches* (ttyd
 * gets SIGHUP → its client exits) and the session keeps running in the
 * background — exactly the "load skills, drop a prompt, close, it keeps going"
 * workflow. The idle reaper cleans up ttyd; the session persists.
 *
 *  - kind "shell"  → fresh login shell in a new `webterm-<id>` session
 *                    (run claude, skills, git, anything).
 *  - kind "attach" → writable second seat on an existing `cs-<name>` session
 *                    (only useful for TUI-mode sessions, not --remote-control).
 */

import * as mux from "./mux";

const TTYD = Bun.which("ttyd") ?? `${process.env.HOME}/.local/bin/ttyd`;
const SCREEN_PREFIX = "cs-";
const WEBTERM_PREFIX = "webterm-";   // deliberately NOT "cs-", so the session lister ignores these
const PORT_LO = 7700;
const PORT_HI = 7799;

export type TermTarget =
  | { kind: "shell"; cwd?: string }
  | { kind: "attach"; screen: string };

interface Term {
  id: string;
  socketPath: string;
  cleanupSocket: () => void;
  base: string;               // "/term/<id>"
  proc: Bun.Subprocess;
  screen: string;             // the session ttyd is attached to
  mux: mux.MuxBackend;        // which holder owns it (zmx passes the mouse through; screen can't)
  ephemeral: boolean;         // true for shell terms we created (webterm-*)
  target: TermTarget;
  createdAt: number;
  clients: number;            // live browser connections to this bridge
  lastActivity: number;       // ms; bumped on connect/disconnect for idle reaping
}

const terms = new Map<string, Term>();
const IDLE_MS = 30 * 60_000;  // reap a bridge with no clients after 30 min

// Bump/track live connections so a bridge survives brief mobile drops (the tab
// backgrounding, a network blip) and "Press Enter to reconnect" actually works.
export function markOpen(id: string): void {
  const t = terms.get(id); if (t) { t.clients++; t.lastActivity = Date.now(); }
}
export function markClose(id: string): void {
  const t = terms.get(id); if (t) { t.clients = Math.max(0, t.clients - 1); t.lastActivity = Date.now(); }
}

function shortId(): string {
  return crypto.randomUUID().replace(/-/g, "").slice(0, 8);
}

/* ---------- bridges left behind by a previous run ---------- */

// BSD ps (macOS) needs -ax where Linux takes -e.
const PS_ARGS = [process.platform === "darwin" ? "-U" : "-u", String(process.getuid?.() ?? -1), "-o", "pid=,args="];

/**
 * Recognise one of *our* ttyd bridges in a ps line. The first token has to be
 * ttyd itself — the screen daemon and the shell that spawned it repeat the whole
 * command string — and the port has to be one we hand out.
 */
export function parseBridge(line: string): { pid: number; port: number; screen: string } | null {
  const m = line.trim().match(/^(\d+)\s+(.*)$/);
  if (!m) return null;
  const args = m[2] ?? "";
  if (!/(^|\/)ttyd(\s|$)/.test(args.split(/\s+/)[0] ?? "")) return null;
  if (!args.includes("--base-path /term/")) return null;
  const port = Number(args.match(/(?:^|\s)-p\s+(\d+)/)?.[1] ?? 0);
  const socket = args.match(/(?:^|\s)-i\s+(\S+)/)?.[1];
  const privateSocket = socket?.includes("/terminals/t-") && socket.endsWith("/s.sock");
  if (!privateSocket && (port < PORT_LO || port > PORT_HI)) return null;
  // Screen attach bridges wrap the command in `bash -c "…; exec screen -x 'name'"`
  // to replay scrollback first, so the name can arrive quoted.
  // zmx bridges end in `sh -c <join script> /path/zmx <name>`.
  const name = args.match(/(?:screen\s+-x|zmx)\s+'?([^'\s]+)'?\s*$/)?.[1] ?? "";
  return { pid: Number(m[1]), port, screen: name };
}

/**
 * Kill ttyd bridges owned by a previous run of this process.
 *
 * The reaper below works from `terms`, which lives in memory — so a restart
 * (i.e. every deploy) forgets every bridge while the ttyd keeps running. Those
 * survivors are unreachable anyway: /term/<id> resolves through that same map,
 * so the browser gets "No such terminal" no matter what. They just sit on a port
 * out of the 100 we have. Killing one merely detaches its client; the
 * session it was attached to keeps running.
 */
export async function reapStrayBridges(): Promise<number> {
  const known = new Set([...terms.values()].map((t) => t.proc.pid));
  const p = Bun.spawn(["ps", ...PS_ARGS], { stdout: "pipe", stderr: "ignore", env: childEnvironment() });
  const out = await new Response(p.stdout).text();
  await p.exited;
  let killed = 0;
  for (const line of out.split("\n")) {
    const b = parseBridge(line);
    if (!b || known.has(b.pid)) continue;
    try { process.kill(b.pid, "SIGTERM"); killed++; } catch {}
  }
  if (killed) console.log(`terminal: reaped ${killed} stray bridge(s) left by a previous run`);
  return killed;
}

// At boot `terms` is empty, so every bridge found belongs to a previous run.
reapStrayBridges().catch(() => {});

/** Names of every live session under either holder (any prefix). */
async function liveScreens(): Promise<Set<string>> {
  return new Set((await mux.listAll()).map((s) => s.name));
}

export function get(id: string): Term | undefined {
  return terms.get(id);
}

export function list(): Array<{ id: string; base: string; screen: string; mux: mux.MuxBackend; kind: string; createdAt: number; alive: boolean }> {
  return [...terms.values()].map((t) => ({
    id: t.id, base: t.base, screen: t.screen, mux: t.mux, kind: t.target.kind, createdAt: t.createdAt,
    alive: t.proc.exitCode === null,
  }));
}

/**
 * Open a terminal. Returns the base path the client should navigate to
 * (`/term/<id>/`), which the Bun server proxies to the freshly-spawned ttyd.
 */
export async function open(target: TermTarget): Promise<{ ok: true; id: string; url: string; mux: mux.MuxBackend } | { ok: false; error: string }> {
  let screenName: string;
  let backend: mux.MuxBackend;
  let ephemeral = false;

  if (target.kind === "attach") {
    screenName = target.screen;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(screenName)) return { ok: false, error: "Bad session name." };
    if (!screenName.startsWith(SCREEN_PREFIX)) return { ok: false, error: "Can only attach to cs-* sessions." };
    const session = await mux.find(screenName);
    if (!session) return { ok: false, error: "That session is not running." };
    backend = session.backend;
  } else {
    // fresh login shell inside its own session, so it persists after the tab closes
    const id0 = shortId();
    screenName = WEBTERM_PREFIX + id0;
    ephemeral = true;
    backend = mux.newSessionBackend();
    const cwd = target.cwd && target.cwd.startsWith("/") ? target.cwd : (process.env.HOME ?? "/");
    const { code } = await mux.spawn(screenName, "exec bash -l", { cwd, backend });
    if (code !== 0) return { ok: false, error: "Could not start a shell session." };
  }

  const id = shortId();
  let socket: ReturnType<typeof createTerminalSocket>;
  try { socket = createTerminalSocket(); } catch {
    if (ephemeral) await mux.quit(screenName, backend).catch(() => {});
    return { ok: false, error: "Could not create a private terminal socket. Check XCS_RUNTIME_DIR permissions and path length." };
  }
  const { socketPath } = socket;
  const base = `/term/${id}`;

  // Attaching to a screen session repaints its *current window* to the new
  // display — screen never replays what already scrolled off. So the browser
  // terminal's scrollback starts empty every time you open a terminal, and the
  // wheel has nothing to scroll to no matter how the terminal is configured.
  // The history is right there in screen's own buffer, so dump it into the pty
  // before attaching: those lines land in xterm.js's scrollback and ordinary
  // wheel/touch scrolling reaches the whole session.
  //
  // `hardcopy -h` writes plain text, but a wedged app can leave stray control
  // bytes in the buffer — strip everything except tab and newline so replaying
  // can't reprogram the terminal. `screenName` is validated above, so it is
  // safe to interpolate here.
  // A freshly-created shell has no history worth replaying, so only attach does it.
  // zmx needs none of this: it rehydrates a new client itself (scrollback and
  // screen, in colour, from libghostty-vt).
  const attachCmd: string[] = target.kind === "attach" && backend === "screen"
    ? ["bash", "-c", [
        `h=$(mktemp /tmp/xs-replay.XXXXXX)`,
        `w=$(mktemp /tmp/xs-replay.XXXXXX)`,
        `screen -S '${screenName}' -X hardcopy -h "$h" 2>/dev/null`,
        `screen -S '${screenName}' -X hardcopy "$w" 2>/dev/null`,
        // `hardcopy -h` is scrollback PLUS the current window, and screen repaints
        // that window itself on attach — replaying it too would show the last
        // screenful twice, which reads as corrupted history.
        `n=$(( $(wc -l < "$h") - $(wc -l < "$w") ))`,
        // tr: a wedged TUI can leave control bytes that would reprogram the terminal.
        // iconv -c: screen only tracks characters correctly with `defutf8 on`, so
        //   sessions started without it yield split multibyte sequences — drop the
        //   broken bytes rather than render a field of replacement glyphs.
        // cat -s: TUI repaints leave long runs of blank rows; collapse them.
        // sed/tac: trim leading and trailing blank padding.
        `if [ "$n" -gt 0 ]; then head -n "$n" "$h" | tr -d '\\000-\\010\\013\\014\\016-\\037' | iconv -c -f UTF-8 -t UTF-8 | cat -s | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac | tail -n 5000; printf '\\033[2m──── replayed history above · live session below ────\\033[0m\\n'; fi`,
        `rm -f "$h" "$w"`,
        `exec screen -x '${screenName}'`,
      ].join("; ")]
    : mux.attachArgv({ name: screenName, backend });

  // ttyd: writable, own UI under base-path. NOT --once: the bridge must survive
  // brief disconnects (phone backgrounding, network blips) so reconnect works —
  // otherwise the first drop kills ttyd and every reconnect 404s in a loop.
  // The idle reaper below cleans up abandoned bridges. `--exit-no-conn` is off,
  // so ttyd re-runs the attach command on reconnect; SIGHUP on real close detaches
  // (not quits) → the session lives on.
  let proc: Bun.Subprocess;
  try { proc = Bun.spawn(
    [TTYD, "--writable", "-i", socketPath, "--base-path", base,
      "-t", "titleFixed=" + screenName, "-t", "disableLeaveAlert=true",
      // Wheel/touch scrolling only reaches as far as xterm.js kept. Its default
      // is 1000 lines; match the service user's `defscrollback` so scrolling
      // back feels native rather than hitting an invisible floor mid-history.
      // (Screen sessions also need `termcapinfo … ti@:te@` in ~/.screenrc —
      // without it screen uses the alternate buffer and nothing reaches the
      // browser at all. zmx passes the app's own output through untouched.)
      "-t", "scrollback=10000",
      // App-matched xterm theme. Normal "white" is deliberately muted and
      // brightWhite pure white (bold renders bright), so TUI menus that mark
      // the selected row bold/bright stand out instead of blending in.
      "-t", 'theme={"background":"#12151F","foreground":"#c9d1e3","cursor":"#7aa2ff","cursorAccent":"#12151F","selectionBackground":"#2b3f66","black":"#1b2130","red":"#ff6b7a","green":"#4fd6a5","yellow":"#f5c56b","blue":"#6ea8fe","magenta":"#c792ea","cyan":"#56c8d8","white":"#9aa3b5","brightBlack":"#5a6478","brightRed":"#ff8797","brightGreen":"#6fe6bd","brightYellow":"#ffd98a","brightBlue":"#8fbcff","brightMagenta":"#d9aaf5","brightCyan":"#7adfee","brightWhite":"#ffffff"}',
      ...attachCmd],
    // Explicit env: `zmx attach` must see the ZMX_DIR that mux.ts pinned.
    { stdout: "ignore", stderr: "ignore", env: childEnvironment() },
  );

  } catch {
    socket.cleanup();
    if (ephemeral) await mux.quit(screenName, backend).catch(() => {});
    return { ok: false, error: "Could not start the terminal bridge." };
  }
  let ready = false;
  for (let attempt = 0; attempt < 100 && proc.exitCode === null; attempt++) {
    if (secureTerminalSocket(socketPath)) { ready = true; break; }
    await Bun.sleep(50);
  }
  if (!ready) {
    try { proc.kill(); } catch {}
    await proc.exited;
    socket.cleanup();
    if (ephemeral) await mux.quit(screenName, backend).catch(() => {});
    return { ok: false, error: "Terminal bridge could not open its private socket." };
  }

  const term: Term = { id, socketPath, cleanupSocket: socket.cleanup, base, proc, screen: screenName, mux: backend, ephemeral, target, createdAt: Date.now(), clients: 0, lastActivity: Date.now() };
  terms.set(id, term);

  // If ttyd itself dies, drop the map entry. The session persists.
  proc.exited.finally(() => { terms.delete(id); socket.cleanup(); }).catch(() => {});

  return { ok: true, id, url: `${base}/`, mux: backend };
}

// Idle/dead-bridge reaper. Kills a ttyd when its ttyd process is gone, its
// underlying screen has ended, or it has had no clients for IDLE_MS. Attach
// bridges never touch the real session; abandoned ephemeral shells are cleaned.
setInterval(async () => {
  if (terms.size === 0) return;
  let live: Set<string> | null = null;
  try { live = await liveScreens(); } catch {}
  for (const t of [...terms.values()]) {
    const dead = t.proc.exitCode !== null;
    const screenGone = live ? !live.has(t.screen) : false;
    const idle = t.clients === 0 && Date.now() - t.lastActivity > IDLE_MS;
    if (!(dead || screenGone || idle)) continue;
    try { t.proc.kill(); } catch {}
    if (idle && t.ephemeral && !screenGone) { try { await mux.quit(t.screen, t.mux); } catch {} }
    terms.delete(t.id);
  }
}, 60_000);

/** Force-close a terminal's ttyd (does NOT kill the underlying session unless it was ephemeral and asked). */
export async function close(id: string, quitEphemeralScreen = false): Promise<void> {
  const t = terms.get(id);
  if (!t) return;
  try { t.proc.kill(); } catch {}
  if (quitEphemeralScreen && t.ephemeral) {
    try { await mux.quit(t.screen, t.mux); } catch {}
  }
  terms.delete(id);
}

/** Kill all live ttyd bridges (used on shutdown). Screens are left running. */
export function killAll(): void {
  for (const t of terms.values()) { try { t.proc.kill(); } catch {} }
  terms.clear();
}
