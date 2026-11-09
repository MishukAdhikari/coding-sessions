/**
 * The ACP bridge's append-only event log and its state file.
 *
 * The bridge appends one JSON line per event; the server reads from a byte cursor,
 * the same way the transcript chat reads an agent's own transcript, so a read needs
 * no connection to the bridge and survives either side restarting.
 *
 * The log carries what the conversation shows: prompts, the agent's session updates,
 * permission requests and answers, turn ends and notices. It never carries the
 * bridge's own setup requests (initialize, session/new, session/load), which hold
 * MCP credentials, nor any environment.
 */
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, writeFileSync, writeSync, readFileSync } from "node:fs";
import { sanitizeCommands, type AcpCommand } from "./commands";

/** Bumped when an event or state shape changes incompatibly. */
export const ACP_LOG_VERSION = 1;

export type AcpEventKind = "status" | "user" | "update" | "permission" | "permission_resolved" | "turn_end" | "notice";

export interface AcpEvent { seq: number; at: string; kind: AcpEventKind; [key: string]: unknown }

export type BridgeState = "starting" | "working" | "waiting" | "idle" | "exited" | "failed";

export interface AcpState {
  v: number;
  state: BridgeState;
  acpSessionId: string | null;
  loadSession: boolean;
  agent: { name: string | null; title: string | null; version: string | null } | null;
  pendingPermissions: number;
  error: string | null;
  /** The agent's latest advertised slash commands (commands.ts); empty when none. */
  commands: AcpCommand[];
  updatedAt: string;
}

/** Longest single string kept in an event (tool output can be huge); the rest is cut with a marker. */
export const MAX_FIELD_CHARS = 64 * 1024;
/** Longest event line kept at all. */
export const MAX_EVENT_BYTES = 1024 * 1024;
/** Most bytes one read returns; the caller reads again from the new cursor. */
export const MAX_READ_BYTES = 2 * 1024 * 1024;

/** Cut long strings anywhere in a JSON value. Pure. */
export function clipStrings(value: unknown, max = MAX_FIELD_CHARS): unknown {
  if (typeof value === "string") return value.length > max ? `${value.slice(0, max)}\n… [${value.length - max} more characters not kept]` : value;
  if (Array.isArray(value)) return value.map((v) => clipStrings(v, max));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = clipStrings(v, max);
    return out;
  }
  return value;
}

/** Serialize one event line, clipped to the limits. Pure. */
export function eventLine(event: AcpEvent): string {
  let line = JSON.stringify(clipStrings(event));
  if (Buffer.byteLength(line) > MAX_EVENT_BYTES) {
    line = JSON.stringify({ seq: event.seq, at: event.at, kind: "notice", text: "An update from the agent was too large to keep." });
  }
  return `${line}\n`;
}

/** Appends events with increasing seq numbers. Used by the bridge only. */
export function createEventWriter(path: string, now: () => Date = () => new Date()) {
  let seq = 0;
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o600);
  return {
    append(kind: AcpEventKind, fields: Record<string, unknown> = {}): AcpEvent {
      const event: AcpEvent = { ...fields, seq: ++seq, at: now().toISOString(), kind };
      writeSync(fd, eventLine(event));
      return event;
    },
    close() { try { closeSync(fd); } catch {} },
  };
}

export interface EventWindow { events: AcpEvent[]; cursor: number; reset: boolean }

/**
 * Events after a byte cursor. A cursor past the end of the file means the log was
 * replaced by a new launch: start over from the beginning with `reset: true`.
 * Only complete lines are returned; the cursor stops before a half-written one.
 */
export function readEventWindow(path: string, after: number | null, maxBytes = MAX_READ_BYTES): EventWindow {
  let fd: number;
  try { fd = openSync(path, "r"); } catch { return { events: [], cursor: 0, reset: after !== null && after > 0 }; }
  try {
    const size = fstatSync(fd).size;
    let start = after ?? 0;
    let reset = false;
    if (start > size || start < 0) { start = 0; reset = true; }
    const length = Math.min(maxBytes, size - start);
    if (length <= 0) return { events: [], cursor: start, reset };
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    const lastNl = buf.subarray(0, n).lastIndexOf(10);
    if (lastNl < 0) return { events: [], cursor: start, reset };
    const events: AcpEvent[] = [];
    for (const line of buf.subarray(0, lastNl).toString("utf8").split("\n")) {
      if (!line.trim()) continue;
      try {
        const e = JSON.parse(line);
        if (e && typeof e === "object" && typeof e.seq === "number" && typeof e.kind === "string") events.push(e);
      } catch { /* a corrupt line is skipped, not fatal */ }
    }
    return { events, cursor: start + lastNl + 1, reset };
  } finally {
    closeSync(fd);
  }
}

/** Replace the state file atomically, 0600. */
export function writeState(path: string, state: Omit<AcpState, "v" | "updatedAt" | "commands"> & { commands?: AcpCommand[] }, now: () => Date = () => new Date()): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ v: ACP_LOG_VERSION, ...state, updatedAt: now().toISOString() }), { mode: 0o600 });
  renameSync(tmp, path);
}

const STATES: readonly BridgeState[] = ["starting", "working", "waiting", "idle", "exited", "failed"];

/** The state file, or null when it is missing or not one of ours. */
export function readState(path: string): AcpState | null {
  try {
    const s = JSON.parse(readFileSync(path, "utf8"));
    if (!s || typeof s !== "object" || !STATES.includes(s.state)) return null;
    return {
      v: Number(s.v) || 0,
      state: s.state,
      acpSessionId: typeof s.acpSessionId === "string" ? s.acpSessionId : null,
      loadSession: s.loadSession === true,
      agent: s.agent && typeof s.agent === "object" ? {
        name: typeof s.agent.name === "string" ? s.agent.name : null,
        title: typeof s.agent.title === "string" ? s.agent.title : null,
        version: typeof s.agent.version === "string" ? s.agent.version : null,
      } : null,
      pendingPermissions: Number.isInteger(s.pendingPermissions) ? s.pendingPermissions : 0,
      error: typeof s.error === "string" ? s.error : null,
      commands: sanitizeCommands(s.commands),
      updatedAt: typeof s.updatedAt === "string" ? s.updatedAt : "",
    };
  } catch {
    return null;
  }
}
