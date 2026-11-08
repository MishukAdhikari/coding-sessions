/**
 * Where an ACP session's bridge keeps its files, and the checks that keep them private.
 *
 *   <dataDir>/acp/            0700
 *   <dataDir>/acp/<screen>/   0700, one per session holder name
 *     bridge.sock             0600, the bridge's command socket (never TCP)
 *     events.jsonl            0600, append-only event log
 *     state.json              0600, the bridge's current state
 *
 * Every path is derived from a validated holder name; nothing from a request is
 * ever joined onto a path.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Holder names the app creates: `cs-` plus a lower-cased session name. */
export const ACP_SCREEN_RE = /^cs-[a-z0-9][a-z0-9_-]{0,42}$/;
/** sockaddr_un holds 104 bytes on macOS and 108 on Linux; stay clear of both, as the control socket does. */
export const MAX_SOCKET_PATH_BYTES = 100;

export const EVENTS_FILE = "events.jsonl";
export const STATE_FILE = "state.json";
export const SOCKET_FILE = "bridge.sock";

export interface AcpPaths { root: string; dir: string; socket: string; events: string; state: string }

export type PathResult = { ok: true; paths: AcpPaths } | { ok: false; error: string };

/** The paths for one session holder, or why there are none. Pure. */
export function acpPaths(dataDir: string, screen: string): PathResult {
  if (!ACP_SCREEN_RE.test(screen)) return { ok: false, error: "Bad session name." };
  const root = join(dataDir, "acp");
  const dir = join(root, screen);
  const socket = join(dir, SOCKET_FILE);
  if (Buffer.byteLength(socket) >= MAX_SOCKET_PATH_BYTES) {
    return { ok: false, error: `The chat socket path ${socket} is ${Buffer.byteLength(socket)} bytes; it must be under ${MAX_SOCKET_PATH_BYTES}. Use a shorter session name or a shorter CS_DATA_DIR.` };
  }
  return { ok: true, paths: { root, dir, socket, events: join(dir, EVENTS_FILE), state: join(dir, STATE_FILE) } };
}

/** A directory that is ours, a real directory (not a symlink), and closed to group and others. */
export function checkPrivateDir(dir: string): { ok: true } | { ok: false; error: string } {
  let st;
  try { st = lstatSync(dir); } catch { return { ok: false, error: `${dir} does not exist.` }; }
  if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, error: `${dir} is not a directory.` };
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return { ok: false, error: `${dir} must belong to the account running Coding Sessions.` };
  if (st.mode & 0o077) return { ok: false, error: `${dir} must be private (chmod 0700).` };
  return { ok: true };
}

/** Create (or check) the acp root and one session's directory, both 0700. */
export function ensurePrivateDirs(paths: AcpPaths): { ok: true } | { ok: false; error: string } {
  for (const dir of [paths.root, paths.dir]) {
    let created = false;
    try { lstatSync(dir); } catch {
      try { mkdirSync(dir, { mode: 0o700 }); created = true; } catch (e) { return { ok: false, error: `Could not create ${dir}: ${(e as Error).message}` }; }
    }
    if (created) chmodSync(dir, 0o700); // mkdir's mode is masked by the umask; make it exact
    const checked = checkPrivateDir(dir);
    if (!checked.ok) return checked;
  }
  return { ok: true };
}

/** A fresh launch starts with an empty log and no state. */
export function clearSessionFiles(paths: AcpPaths): void {
  for (const file of [paths.events, paths.state, `${paths.state}.tmp`, paths.socket]) rmSync(file, { force: true });
}

/** Remove a session's directory entirely (its conversation log included). */
export function removeSessionDir(dataDir: string, screen: string): void {
  const resolved = acpPaths(dataDir, screen);
  if (!resolved.ok) return;
  if (!checkPrivateDir(resolved.paths.dir).ok) return; // never follow a symlink or touch something not ours
  rmSync(resolved.paths.dir, { recursive: true, force: true });
}
