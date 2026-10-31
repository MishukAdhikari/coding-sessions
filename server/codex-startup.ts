import { readCsSetting } from "./environment";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { childEnvironment } from "./child-env";
import type { MuxBackend } from "./mux";

const LIMIT = 64 * 1024;
export const CODEX_READINESS_TIMEOUT_ERROR = "Codex started, but its managed SessionStart hook did not report readiness.";

export function isCodexFolderTrustPrompt(text: string): boolean {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "")
    .split("\n").map(line => line.trim()).filter(Boolean).slice(-18);
  const question = lines.findLastIndex(line => /^Trust this folder\? Codex can read, edit, and run files here/.test(line));
  if (question < 0) return false;
  const choices = lines.slice(question + 1);
  const accept = choices.findIndex(line => /^(?:[›❯>] ?)?1\. Trust and continue$/.test(line));
  const reject = choices.findIndex(line => /^(?:[›❯>] ?)?2\. Back to Agent Command Center$/.test(line));
  if (accept < 0 || reject !== accept + 1) return false;
  return choices.slice(reject + 1).every(line => /^(?:Press )?(?:enter|esc|escape)\b.*(?:confirm|continue|cancel|back)/i.test(line));
}

export function isCodexInputReady(text: string): boolean {
  const lines = text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\r/g, "")
    .split("\n").slice(-40).map(line => line.trim()).filter(Boolean);
  const prompt = lines.findLastIndex(line => line === "› Ask Codex to do anything");
  if (prompt < 0 || !lines.slice(0, prompt).some(line => /^>_ OpenAI Codex \(v\d+\.\d+\.\d+\)$/.test(line))) return false;
  const footer = lines.slice(prompt + 1);
  return footer.length === 2
    && /^[A-Za-z0-9][^·]* · (?:\/|~)/.test(footer[0]!)
    && /^\? for shortcuts(?:\s+.*)?$/.test(footer[1]!);
}

export type CodexStartupObservation = "unknown" | "trust" | "input";

export function matchesCodexLaunchMarkers(raw: string, launchId: string, screen: string, dbPath: string): boolean {
  const entries = raw.split("\0");
  const prefix = entries.some(entry => /^(CS_LAUNCH_ID|CS_SCREEN|CS_DB_PATH)=/.test(entry)) ? "CS_" : "X" + "CS_";
  return [["LAUNCH_ID", launchId], ["SCREEN", screen], ["DB_PATH", dbPath]]
    .every(([suffix, value]) => {
      const key = `${prefix}${suffix}`;
      return entries.filter(entry => entry.startsWith(`${key}=`)).length === 1 && entries.includes(`${key}=${value}`);
    });
}

function readBounded(path: string, privateFile = false): string | null {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || (privateFile && (stat.mode & 0o077) !== 0) || stat.size > LIMIT) return null;
    const data = Buffer.alloc(LIMIT + 1);
    let length = 0;
    while (length < data.length) {
      const count = readSync(fd, data, length, data.length - length, null);
      if (!count) break;
      length += count;
    }
    return length <= LIMIT ? data.subarray(0, length).toString("utf8") : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function codexProcessMatchesLaunch(pid: number, launchId: string, screen: string, dbPath: string): boolean {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid < 1) return false;
  const raw = readBounded(`/proc/${pid}/environ`);
  return raw !== null && matchesCodexLaunchMarkers(raw, launchId, screen, dbPath);
}

export async function boundedTerminalCommand(argv: string[]): Promise<string | null> {
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    child = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: childEnvironment() });
    const process = child;
    const read = async () => {
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of process.stdout as ReadableStream<Uint8Array>) {
        size += chunk.length;
        if (size > LIMIT) { process.kill(9); return null; }
        chunks.push(chunk);
      }
      return await process.exited === 0 ? Buffer.concat(chunks).toString("utf8") : null;
    };
    return await Promise.race([read(), new Promise<null>(resolve => {
      timer = setTimeout(() => { try { process.kill(9); } catch {} resolve(null); }, 750);
    })]);
  } catch { return null; }
  finally { if (timer) clearTimeout(timer); }
}

export interface StartupTerminal {
  backend: MuxBackend;
  screen: string;
  zmxBin: string | null;
}

export async function readStartupViewport(target: StartupTerminal, dependencies: {
  run?: typeof boundedTerminalCommand;
  runtimeDirectory?: string;
} = {}): Promise<string | null> {
  const run = dependencies.run ?? boundedTerminalCommand;
  if (!/^cs-[a-z0-9][a-z0-9_-]{0,42}$/.test(target.screen)) return null;
  if (target.backend === "zmx") return target.zmxBin ? run([target.zmxBin, "history", target.screen]) : null;
  let directory: string | undefined;
  try {
    const base = resolve(dependencies.runtimeDirectory ?? readCsSetting(process.env, "CS_RUNTIME_DIR") ?? join(homedir(), ".local", "state", "xcloud-sessions"));
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const stat = lstatSync(base);
    if (!stat.isDirectory() || realpathSync(base) !== base || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()) return null;
    directory = mkdtempSync(join(base, "codex-startup-"));
    const file = join(directory, "viewport");
    const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    closeSync(fd);
    if (await run(["screen", "-S", target.screen, "-X", "hardcopy", file]) === null) return null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const text = readBounded(file, true);
      if (text) return text;
      await Bun.sleep(25);
    }
    return null;
  } catch { return null; }
  finally { if (directory) rmSync(directory, { recursive: true, force: true }); }
}

export function createStartupProbe(
  read: (target: StartupTerminal) => Promise<string | null> = readStartupViewport,
  now = Date.now,
  matches = codexProcessMatchesLaunch,
) {
  const cache = new Map<string, { at: number; value: Promise<CodexStartupObservation> }>();
  return async (launchId: string, pid: number, target: StartupTerminal, dbPath: string): Promise<CodexStartupObservation> => {
    if (!matches(pid, launchId, target.screen, dbPath)) return "unknown";
    const key = `${launchId}:${pid}:${target.backend}:${target.screen}:${dbPath}`;
    let cached = cache.get(key);
    if (!cached || now() - cached.at >= 10_000) {
      if (cache.size >= 128) cache.delete(cache.keys().next().value!);
      const value = read(target).then((text): CodexStartupObservation => {
        if (text === null) return "unknown";
        if (isCodexFolderTrustPrompt(text)) return "trust";
        return isCodexInputReady(text) ? "input" : "unknown";
      }).catch((): CodexStartupObservation => "unknown");
      cached = { at: now(), value };
      cache.set(key, cached);
    }
    const observation = await cached.value;
    return matches(pid, launchId, target.screen, dbPath) ? observation : "unknown";
  };
}
