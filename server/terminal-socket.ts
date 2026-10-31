import { mkdirSync, lstatSync, realpathSync, chmodSync, mkdtempSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { resolve, join } from "node:path";

export function createTerminalSocket(base = process.env.XCS_RUNTIME_DIR ?? join(homedir(), ".local", "state", "xcloud-sessions")) {
  const root = resolve(base, "terminals");
  for (let path = root; path !== resolve(path, ".."); path = resolve(path, "..")) {
    try { if (lstatSync(path).isSymbolicLink()) throw new Error("Terminal runtime path cannot contain symlinks."); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const stat = lstatSync(root);
  if (!stat.isDirectory() || (process.getuid && stat.uid !== process.getuid()) || realpathSync(root) !== root) throw new Error("Terminal runtime directory must belong to this account.");
  chmodSync(root, 0o700);
  const directory = mkdtempSync(join(root, "t-"));
  chmodSync(directory, 0o700);
  const socketPath = join(directory, "s.sock");
  const cleanup = () => rmSync(directory, { recursive: true, force: true });
  if (Buffer.byteLength(socketPath) > 100 || /[\s:%?#\\]/.test(socketPath)) {
    cleanup();
    throw new Error("Set XCS_RUNTIME_DIR to a shorter private absolute path without URL delimiters.");
  }
  return { socketPath, cleanup };
}

export function secureTerminalSocket(path: string): boolean {
  try {
    const stat = lstatSync(path);
    if (!stat.isSocket() || (process.getuid && stat.uid !== process.getuid())) return false;
    chmodSync(path, 0o600);
    return true;
  } catch { return false; }
}
