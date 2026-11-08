/**
 * Kimi Code turn state, read from the session record the agent writes for itself.
 *
 * Kimi Code (`@moonshot-ai/kimi-code`) keeps everything under `$KIMI_CODE_HOME`
 * (default `~/.kimi-code`). While a process holds a session it owns
 * `locks/sessions/<sessionId>.lock`, a JSON file carrying its pid and hostname.
 * `session_index.jsonl` maps each session id to its directory, and the main agent's
 * append-only `agents/main/wire.jsonl` records every turn boundary and every
 * approval or question it puts to the user. So the lock finds the launch's session
 * without guessing by time, and the wire says working, waiting on you, or finished.
 * Nothing here changes the agent's configuration.
 */
import { readFileSync, readdirSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { join } from "node:path";
import type { TurnState } from "./turn-state";

export const KIMI_CODE_HOME = process.env.KIMI_CODE_HOME || join(homedir(), ".kimi-code");

/* Records that open or close a turn. Everything else in the wire (loop events, LLM
   requests, usage, appended messages) only happens inside one. */
const TURN_START = new Set(["turn.prompt", "agent.turn.started"]);
const TURN_END = new Set(["turn.ended", "agent.turn.ended"]);
const IN_TURN = new Set([
  "context.append_loop_event", "context.append_message", "agent.message.appended",
  "llm.request", "usage.record", "turn.steer", "turn.cancel",
]);

/**
 * What the main agent's last turn is doing, from the tail of its `wire.jsonl`:
 *   - an `interaction.request` (approval, question) with no later
 *     `interaction.resolved` → "asking";
 *   - a turn end (`turn.ended`, whatever its reason) → "done";
 *   - a turn start, or work that only happens inside a turn → "busy";
 *   - nothing that says either (metadata and setup only) → "unknown".
 * Pure, so it is tested against record shapes from Kimi Code's own test snapshots.
 */
export function kimiTurnState(tailText: string): TurnState {
  const resolved = new Set<string>();
  const lines = tailText.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim();
    if (!line) continue;
    let record: any;
    try { record = JSON.parse(line); } catch { continue; } // a truncated first line
    const type = typeof record?.type === "string" ? record.type : "";
    if (type === "interaction.resolved" && typeof record.id === "string") { resolved.add(record.id); continue; }
    if (type === "interaction.request") {
      if (typeof record.id === "string" && !resolved.has(record.id)) return "asking";
      continue;
    }
    if (TURN_END.has(type)) return "done";
    if (TURN_START.has(type) || IN_TURN.has(type)) return "busy";
  }
  return "unknown";
}

export interface KimiFsDependencies {
  home: string;
  host: string;
  listFiles: (dir: string) => string[];
  readText: (path: string) => string | null;
}

export const defaultKimiFs: KimiFsDependencies = {
  home: KIMI_CODE_HOME,
  host: hostname(),
  listFiles: (dir) => {
    try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name); } catch { return []; }
  },
  readText: (path) => {
    try { return readFileSync(path, "utf8"); } catch { return null; }
  },
};

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * The `wire.jsonl` of the session held by one of `pids` (the agent process and its
 * descendants), or null when none holds a session yet — Kimi Code creates a session
 * only when the first message is sent. Among several locks, the newest wins.
 */
export function findKimiWire(pids: ReadonlySet<number>, fs: KimiFsDependencies = defaultKimiFs): string | null {
  const lockDir = join(fs.home, "locks", "sessions");
  let best: { id: string; at: number } | null = null;
  for (const file of fs.listFiles(lockDir)) {
    if (!file.endsWith(".lock")) continue;
    const id = file.slice(0, -".lock".length);
    if (!SESSION_ID.test(id)) continue;
    const raw = fs.readText(join(lockDir, file));
    if (!raw) continue;
    let lock: any;
    try { lock = JSON.parse(raw); } catch { continue; }
    if (!Number.isInteger(lock?.pid) || !pids.has(lock.pid)) continue;
    if (typeof lock.hostname === "string" && lock.hostname !== "" && lock.hostname !== fs.host) continue;
    const at = Number.isFinite(lock.startedAt) ? lock.startedAt : 0;
    if (best === null || at > best.at) best = { id, at };
  }
  if (!best) return null;
  const sessionDir = kimiSessionDir(best.id, fs);
  return sessionDir ? join(sessionDir, "agents", "main", "wire.jsonl") : null;
}

/** The session's directory from `session_index.jsonl`; a later `deleted` entry wins. */
function kimiSessionDir(sessionId: string, fs: KimiFsDependencies): string | null {
  const raw = fs.readText(join(fs.home, "session_index.jsonl"));
  if (!raw) return null;
  let dir: string | null = null;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry?.sessionId !== sessionId) continue;
    if (entry.deleted === true) dir = null;
    else if (typeof entry.sessionDir === "string" && entry.sessionDir.startsWith("/")) dir = entry.sessionDir;
  }
  return dir;
}
