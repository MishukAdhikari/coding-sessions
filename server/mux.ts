import { readCsSetting } from "./environment";
import { childEnvironment } from "./child-env";
/**
 * The terminal holder a Session lives in — the thing that keeps an agent running
 * after every browser has disconnected and across restarts of this service.
 *
 * Two backends:
 *  - zmx (default when installed): one daemon per session that passes the pty's
 *    bytes straight through. The browser terminal talks to the agent directly —
 *    mouse, synchronized output, truecolor and OSC 52 all reach it — and a
 *    reattach is rehydrated from libghostty-vt (scrollback + screen, in colour).
 *  - GNU screen (legacy): a full terminal emulator in the middle. Still used to
 *    list, attach and end sessions that were started under it, and for new
 *    sessions when zmx is missing or `CS_MUX=screen` forces it.
 *
 * Both are addressed by the same name (`cs-<name>`, `webterm-<id>`), so the
 * launches table and every id the frontend sees stay backend-neutral.
 */
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type MuxBackend = "zmx" | "screen";

export interface MuxSession {
  name: string;
  /** Root of the session's process tree: screen's daemon, or zmx's direct child
   *  (the command it exec'd). Every process of the session descends from it.
   *  null when zmx couldn't reach a live daemon in time — alive, pid unknown. */
  pid: number | null;
  backend: MuxBackend;
}

// The service unit has no XDG_RUNTIME_DIR, so zmx would fall back to /tmp while
// an SSH login uses /run/user/<uid> — two views of the same sessions. Pin one
// short, stable directory (unix socket paths cap at 108 bytes) and export it, so
// every child — ttyd bridges, `zmx` typed in a web shell — agrees on it.
process.env.ZMX_DIR ||= join(homedir(), ".zmx");
// ctrl+\ would detach the browser's client and leave ttyd showing "reconnect".
process.env.ZMX_NO_DETACH_KEY ||= "1";
// Inside a zmx session (a service restarted from a web shell, local dev), zmx
// reads ZMX_SESSION and `attach` retargets that terminal instead of creating —
// every launch would silently start nothing. The service is never "inside" one.
delete process.env.ZMX_SESSION;

function findZmx(): string | null {
  const found = Bun.which("zmx");
  if (found) return found;
  const local = join(homedir(), ".local", "bin", "zmx");
  try { return statSync(local).isFile() ? local : null; } catch { return null; }
}

export const ZMX_BIN = findZmx();

/** Backend for sessions started from now on. */
export function newSessionBackend(): MuxBackend {
  if (readCsSetting(process.env, "CS_MUX") === "screen") return "screen";
  return ZMX_BIN ? "zmx" : "screen";
}

async function capture(cmd: string[], env?: Record<string, string>, cwd?: string): Promise<{ code: number; out: string; err: string }> {
  try {
    const p = Bun.spawn(cmd, {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Explicit, so the ZMX_DIR pinned above reaches the child either way.
      env: childEnvironment(env),
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out, err };
  } catch (e) {
    return { code: 127, out: "", err: String((e as Error)?.message ?? e) };
  }
}

/** `screen -ls` → sessions. Pure, for tests. */
export function parseScreenLs(out: string): MuxSession[] {
  const rows: MuxSession[] = [];
  for (const m of out.matchAll(/^\s+(\d+)\.(\S+)\s/gm)) rows.push({ name: m[2]!, pid: +m[1]!, backend: "screen" });
  return rows;
}

/**
 * `zmx list` (tab-separated `key=value` columns) → sessions. Pure, for tests.
 *
 * zmx probes each daemon with a 1s timeout. A busy daemon that misses it prints
 * `name=X\terr=Timeout\tstatus=unreachable` with no pid — it is still running, and
 * dropping it would archive a live session and kill its web terminal. Only a
 * refused probe (`status=cleaning up`: the daemon is gone, socket deleted) is dead.
 */
export function parseZmxList(out: string): MuxSession[] {
  const rows: MuxSession[] = [];
  for (const line of out.split("\n")) {
    const name = line.match(/(?:^|\s)name=([^\t]+)/)?.[1]?.trim();
    if (!name || /\tstatus=cleaning up/.test(line)) continue;
    const pid = Number(line.match(/\tpid=(\d+)/)?.[1] ?? 0);
    rows.push({ name, pid: pid > 0 ? pid : null, backend: "zmx" });
  }
  return rows;
}

/** Every live session under either backend. A backend that isn't installed lists nothing. */
export async function listAll(): Promise<MuxSession[]> {
  const [screen, zmx] = await Promise.all([
    capture(["screen", "-ls"]),
    ZMX_BIN ? capture([ZMX_BIN, "list"]) : Promise.resolve({ code: 0, out: "", err: "" }),
  ]);
  return [...parseZmxList(zmx.out), ...parseScreenLs(screen.out)];
}

/**
 * Live sessions whose name starts with `prefix`, as Map<pid, name>. A session
 * whose pid is unknown gets a negative placeholder key: present by name, but no
 * process ever descends from it, so it reads as "starting", never as gone.
 */
export async function listByPrefix(prefix: string): Promise<Map<number, string>> {
  const map = new Map<number, string>();
  let unknown = 0;
  for (const s of await listAll()) if (s.name.startsWith(prefix)) map.set(s.pid ?? --unknown, s.name);
  return map;
}

export async function find(name: string): Promise<MuxSession | null> {
  return (await listAll()).find((s) => s.name === name) ?? null;
}

/** argv that starts `bash -lc <inner>` detached under `name`. Pure, for tests. */
export function spawnArgv(backend: MuxBackend, name: string, inner: string, zmxBin: string | null = ZMX_BIN): string[] {
  // zmx has no detached flag: `attach` without a tty creates the session, and
  // the client returns at once while the daemon keeps it.
  if (backend === "zmx") return [zmxBin ?? "zmx", "attach", name, "bash", "-lc", inner];
  return ["screen", "-dmS", name, "bash", "-lc", inner];
}

/**
 * Start `bash -lc <inner>` detached as session `name`. `env` reaches the agent
 * through the holder's environment — never argv, which /proc makes world-readable.
 */
export async function spawn(
  name: string,
  inner: string,
  opts: { env?: Record<string, string>; cwd?: string; backend?: MuxBackend } = {},
): Promise<{ code: number; out: string; err: string }> {
  const backend = opts.backend ?? newSessionBackend();
  return capture(spawnArgv(backend, name, inner), opts.env, opts.cwd);
}

/** End a session under whichever backend holds it. */
export async function quit(name: string, backend?: MuxBackend): Promise<void> {
  const which = backend ?? (await find(name))?.backend;
  if (which === "zmx" && ZMX_BIN) {
    await capture([ZMX_BIN, "kill", name]);
    return;
  }
  if (which === "screen") await capture(["screen", "-S", name, "-X", "quit"]);
  // Always, even when nothing was found: a dead screen socket still lists as a
  // `(Dead ???)` row and keeps an "ended" card around until it is wiped.
  await capture(["screen", "-wipe"]);
}

// ttyd re-runs its command on every reconnect, and `zmx attach` creates a session
// when the name is missing. After the agent exits, a reconnect would start a bare
// shell under its name — a card that can't be archived, resumed or ended. So join
// only a session that is listed, and give `attach` a command (`false`) that ends
// at once should the check race with the session exiting.
const ZMX_JOIN_SCRIPT =
  '"$0" list --short 2>/dev/null | grep -qxF -- "$1" || { echo "This session has ended."; exit 1; }; ' +
  'exec env -u ZMX_SESSION "$0" attach "$1" false';

/** The command a ttyd bridge runs to join `name` as another writable client. */
export function attachArgv(session: Pick<MuxSession, "name" | "backend">, zmxBin: string | null = ZMX_BIN): string[] {
  if (session.backend === "zmx") return ["sh", "-c", ZMX_JOIN_SCRIPT, zmxBin ?? "zmx", session.name];
  return ["screen", "-x", session.name];
}
