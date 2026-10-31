import { Database } from "bun:sqlite";
import { isAbsolute } from "node:path";
import { applyCodexHook, parseCodexHookInput } from "./codex-state";

const MAX_HOOK_INPUT_BYTES = 64 * 1024;

export async function readBoundedJson(
  stream: ReadableStream<Uint8Array>,
  limit = MAX_HOOK_INPUT_BYTES,
): Promise<unknown | null> {
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > limit) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks, length);
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
}

type HookEnvironment = Record<string, string | undefined>;
type DatabaseOpener = (path: string) => Database;

function openExistingDatabase(path: string): Database {
  return new Database(path, { readwrite: true, create: false });
}

/** Run one hook payload without writing its contents or errors to stdout. */
export function handleCodexHookPayload(
  payload: unknown,
  environment: HookEnvironment = process.env,
  openDatabase: DatabaseOpener = openExistingDatabase,
  now = Date.now(),
): boolean {
  // This hook is installed standalone; retain one complete legacy marker family for running sessions.
  const prefix = ["CS_DB_PATH", "CS_SCREEN", "CS_LAUNCH_ID"].some(key => environment[key] !== undefined) ? "CS_" : "X" + "CS_";
  const dbPath = environment[`${prefix}DB_PATH`];
  const screen = environment[`${prefix}SCREEN`];
  const launchId = environment[`${prefix}LAUNCH_ID`];
  if (
    !dbPath
    || !isAbsolute(dbPath)
    || dbPath.length > 4096
    || !screen
    || !launchId
  ) return false;
  const input = parseCodexHookInput(payload);
  if (!input) return false;

  try {
    const database = openDatabase(dbPath);
    database.exec("PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    return applyCodexHook(database, screen, launchId, input, now);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const payload = await readBoundedJson(Bun.stdin.stream());
  if (payload != null) handleCodexHookPayload(payload);
}

if (import.meta.main) await main();
