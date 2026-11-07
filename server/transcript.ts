/**
 * A Managed Session's conversation, read from the agent's own transcript file, for
 * the chat view. Read-only, and bounded at every step.
 *
 * Only formats verified against real files are parsed:
 *  - Codex rollouts, ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<uuid>.jsonl
 *    (CLI 0.146-0.167): `response_item` records carry user/assistant `message`s and
 *    `function_call` / `custom_tool_call` tool calls.
 *  - Claude Code transcripts, ~/.claude/projects/<munged cwd>/<session id>.jsonl:
 *    `user` / `assistant` lines with string or block-array `message.content`.
 * Command Code and registered Commands have no chat view.
 *
 * Which file is read comes only from the session's own launch row and the ids its
 * agent reported (the Codex SessionStart hook, Claude's transcript name). Nothing in
 * a request names a file, and the resolved path must stay inside the provider's root.
 */
import type { Database } from "bun:sqlite";
import { closeSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, sep } from "node:path";
import { childEnvironment } from "./child-env";
import { isCodexSessionId } from "./codex-state";
import { screenFromId } from "./session-io";

export type ChatRole = "user" | "assistant" | "tool";
export type TranscriptFormat = "codex" | "claude";

/** `id` is "<line byte offset>:<entry index>", stable across polls. */
export interface ChatMessage { id: string; role: ChatRole; text: string; at: string | null }

export interface TranscriptWindow { messages: ChatMessage[]; cursor: number; reset: boolean }

const CHUNK = 512 * 1024;              // one read
const MAX_LINE = 1024 * 1024;          // longer lines (tool output, compaction) are skipped unparsed
const MAX_MESSAGES = 200;              // per response
const MAX_BACKWARD_SCAN = 8 * 1024 * 1024; // first open: how far back to look for messages
const MAX_FORWARD_SCAN = 64 * 1024 * 1024; // per poll; skipping a huge line is cheap
const MAX_TEXT = 8000;
const MAX_TOOL_TEXT = 300;

/* ---------- parsing ---------- */

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + "…";
}

/** Context the agent injects into the user turn: AGENTS.md, <environment_context>, <system-reminder>, … */
function isInjected(text: string): boolean {
  const t = text.trimStart();
  return t.startsWith("# AGENTS.md instructions") || /^<\/?[A-Za-z][\w-]*(\s[^>]*)?>/.test(t);
}

function joinParts(parts: string[]): string {
  return parts.map(p => p.trim()).filter(Boolean).join("\n\n");
}

/** A one-line hint of what a tool call does: its command, path or pattern when it has one. */
function toolPreview(name: string, input: unknown): string {
  let value: unknown = input;
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch {}
  }
  let hint = "";
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    const key = ["cmd", "command", "file_path", "path", "pattern", "url", "query", "description"].find(k => typeof o[k] === "string" || Array.isArray(o[k]));
    const picked = key ? o[key] : null;
    hint = Array.isArray(picked) ? picked.join(" ") : typeof picked === "string" ? picked : JSON.stringify(o);
  } else if (typeof value === "string") {
    hint = value;
  }
  return clip(`${name} ${hint.replace(/\s+/g, " ").trim()}`.trim(), MAX_TOOL_TEXT);
}

type Entry = { role: ChatRole; text: string };

function codexEntries(o: any): Entry[] {
  if (o?.type !== "response_item" || !o.payload || typeof o.payload !== "object") return [];
  const p = o.payload;
  if (p.type === "message" && Array.isArray(p.content)) {
    if (p.role === "user") {
      const parts = p.content.map((c: any) =>
        c?.type === "input_image" ? "[image]"
        : c?.type === "input_text" && typeof c.text === "string" && !isInjected(c.text) ? c.text : "");
      const text = joinParts(parts);
      return text ? [{ role: "user", text: clip(text, MAX_TEXT) }] : [];
    }
    if (p.role === "assistant") {
      const text = joinParts(p.content.map((c: any) => c?.type === "output_text" && typeof c.text === "string" ? c.text : ""));
      return text ? [{ role: "assistant", text: clip(text, MAX_TEXT) }] : [];
    }
    return []; // developer / system instructions
  }
  if ((p.type === "function_call" || p.type === "custom_tool_call") && typeof p.name === "string") {
    return [{ role: "tool", text: toolPreview(p.name, p.type === "function_call" ? p.arguments : p.input) }];
  }
  return [];
}

function claudeEntries(o: any): Entry[] {
  if ((o?.type !== "user" && o?.type !== "assistant") || o.isMeta || o.isSidechain) return [];
  const content = o.message?.content;
  if (o.type === "user") {
    if (typeof content === "string") return !isInjected(content) && content.trim() ? [{ role: "user", text: clip(content.trim(), MAX_TEXT) }] : [];
    if (!Array.isArray(content)) return [];
    const parts = content.map((c: any) =>
      c?.type === "image" ? "[image]"
      : c?.type === "text" && typeof c.text === "string" && !isInjected(c.text) ? c.text : ""); // tool_result is not a prompt
    const text = joinParts(parts);
    return text ? [{ role: "user", text: clip(text, MAX_TEXT) }] : [];
  }
  if (!Array.isArray(content)) return [];
  const out: Entry[] = [];
  for (const c of content) {
    if (c?.type === "text" && typeof c.text === "string" && c.text.trim()) out.push({ role: "assistant", text: clip(c.text.trim(), MAX_TEXT) });
    else if (c?.type === "tool_use" && typeof c.name === "string") out.push({ role: "tool", text: toolPreview(c.name, c.input) });
  }
  return out;
}

/** One transcript line → zero or more chat messages. Malformed and unknown lines yield none. */
export function parseTranscriptLine(format: TranscriptFormat, line: string, offset: number): ChatMessage[] {
  let o: any;
  try { o = JSON.parse(line); } catch { return []; }
  const entries = format === "codex" ? codexEntries(o) : claudeEntries(o);
  const at = typeof o?.timestamp === "string" ? o.timestamp : null;
  return entries.map((e, i) => ({ id: `${offset}:${i}`, role: e.role, text: e.text, at }));
}

/* ---------- bounded reading ---------- */

type Line = { offset: number; text: string | null }; // null: longer than MAX_LINE, skipped

function readAt(fd: number, start: number, end: number): Buffer {
  const buf = Buffer.alloc(end - start);
  const n = readSync(fd, buf, 0, buf.length, start);
  return n === buf.length ? buf : buf.subarray(0, n);
}

/** Complete lines starting at `from`, in order, each with the offset just past its newline. */
function* linesForward(fd: number, from: number, size: number): Generator<Line & { next: number }> {
  let pos = from, lineStart = from, parts: Buffer[] = [], len = 0, over = false;
  while (pos < size && pos - from < MAX_FORWARD_SCAN) {
    const buf = readAt(fd, pos, Math.min(size, pos + CHUNK));
    if (!buf.length) return;
    let k = 0;
    for (;;) {
      const nl = buf.indexOf(10, k);
      const piece = buf.subarray(k, nl === -1 ? buf.length : nl);
      if (!over && len + piece.length <= MAX_LINE) { parts.push(piece); len += piece.length; }
      else { over = true; parts = []; }
      if (nl === -1) break;
      yield { offset: lineStart, text: over ? null : Buffer.concat(parts).toString("utf8"), next: pos + nl + 1 };
      lineStart = pos + nl + 1; parts = []; len = 0; over = false; k = nl + 1;
    }
    pos += buf.length;
  }
}

/** Complete lines ending at `end` (just past a newline), newest first. */
function* linesBackward(fd: number, end: number): Generator<Line> {
  // Bytes [cut, lineEnd) are the known tail of the current line; it starts after the
  // previous newline, which is still somewhere before `cut`.
  let cut = end - 1, parts: Buffer[] = [], len = 0, over = false;
  while (cut > 0 && end - cut < MAX_BACKWARD_SCAN) {
    const start = Math.max(0, cut - CHUNK);
    const buf = readAt(fd, start, cut);
    let k = buf.length;
    for (;;) {
      const nl = k > 0 ? buf.lastIndexOf(10, k - 1) : -1;
      const piece = buf.subarray(nl + 1, k);
      if (!over && len + piece.length <= MAX_LINE) { parts.unshift(piece); len += piece.length; }
      else { over = true; parts = []; }
      if (nl === -1) break;
      yield { offset: start + nl + 1, text: over ? null : Buffer.concat(parts).toString("utf8") };
      parts = []; len = 0; over = false; k = nl;
    }
    cut = start;
  }
  if (cut === 0 && end > 0) yield { offset: 0, text: over ? null : Buffer.concat(parts).toString("utf8") };
}

/** End of the last complete line: a line still being written is never consumed. */
function completeEnd(fd: number, size: number): number {
  let pos = size;
  while (pos > 0 && size - pos < MAX_LINE + CHUNK) {
    const start = Math.max(0, pos - CHUNK);
    const nl = readAt(fd, start, pos).lastIndexOf(10);
    if (nl !== -1) return start + nl + 1;
    pos = start;
  }
  return 0;
}

/**
 * The messages after `after` (a cursor from a previous response), or the latest ones
 * when there is no cursor. A cursor past the end of the file (replaced or truncated)
 * starts over with `reset: true`. A missing file is an empty chat.
 */
export function readTranscriptWindow(path: string, format: TranscriptFormat, after: number | null): TranscriptWindow {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const size = statSync(path).size;
    const reset = after !== null && after > size;
    if (after !== null && !reset) {
      const messages: ChatMessage[] = [];
      let cursor = after;
      for (const line of linesForward(fd, after, size)) {
        cursor = line.next;
        if (line.text !== null) messages.push(...parseTranscriptLine(format, line.text, line.offset));
        if (messages.length >= MAX_MESSAGES) break;
      }
      return { messages, cursor, reset: false };
    }
    const end = completeEnd(fd, size);
    const newestFirst: ChatMessage[][] = [];
    let count = 0;
    for (const line of linesBackward(fd, end)) {
      if (line.text === null) continue;
      const parsed = parseTranscriptLine(format, line.text, line.offset);
      if (!parsed.length) continue;
      newestFirst.push(parsed);
      count += parsed.length;
      if (count >= MAX_MESSAGES) break;
    }
    return { messages: newestFirst.reverse().flat().slice(-MAX_MESSAGES), cursor: end, reset };
  } catch {
    return { messages: [], cursor: 0, reset: false };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/** The last 64 KiB, for turn state: the cursor window is usually empty while an agent waits. */
export function readTail(path: string, maxBytes = 65536): string {
  let fd: number | undefined;
  try {
    const size = statSync(path).size;
    fd = openSync(path, "r");
    return readAt(fd, Math.max(0, size - maxBytes), size).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

/* ---------- resolving a session's own transcript ---------- */

export interface TranscriptRoots { codexHome: string; claudeProjects: string }

/** Where the agents this server starts write. Codex children see CODEX_HOME only if it is forwarded to them. */
export function defaultTranscriptRoots(): TranscriptRoots {
  const home = homedir();
  return {
    codexHome: childEnvironment().CODEX_HOME || join(home, ".codex"),
    claudeProjects: join(home, ".claude", "projects"),
  };
}

export interface ResolvedTranscript {
  provider: TranscriptFormat;
  path: string | null; // null: the session exists but has no transcript (yet)
  launchId: string | null;
  screen: string;
}

export type ResolveResult = { ok: true; value: ResolvedTranscript } | { ok: false; status: 404 | 422; error: string };

const RESUME_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;
const DAY_MS = 86_400_000;

/** `candidate` when it is a regular file whose real path is inside `root`, else null. */
function insideRoot(root: string, candidate: string): string | null {
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(candidate);
    return real.startsWith(realRoot + sep) && statSync(real).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function firstLineIsMetaFor(path: string, sessionId: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(path, "r");
    const head = readAt(fd, 0, Math.min(statSync(path).size, 256 * 1024)).toString("utf8");
    const nl = head.indexOf("\n");
    const o = JSON.parse(nl === -1 ? head : head.slice(0, nl));
    return o?.type === "session_meta" && String(o.payload?.id ?? "").toLowerCase() === sessionId;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

const dayFolder = (ms: number) => {
  const d = new Date(ms);
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")];
};

/** Date folders that can hold this conversation's rollout, most likely first. */
function candidateFolders(sessionsRoot: string, sessionId: string): string[][] {
  // A UUIDv7's first 48 bits are its creation time; Codex files the rollout under
  // that local date and keeps appending there after a resume.
  if (sessionId[14] === "7") {
    const ms = parseInt(sessionId.replace(/-/g, "").slice(0, 12), 16);
    return [ms, ms - DAY_MS, ms + DAY_MS].map(dayFolder);
  }
  const folders: string[][] = [];
  const names = (path: string) => { try { return readdirSync(path).filter(n => /^\d+$/.test(n)).sort().reverse(); } catch { return []; } };
  for (const y of names(sessionsRoot)) for (const m of names(join(sessionsRoot, y))) for (const d of names(join(sessionsRoot, y, m))) {
    folders.push([y, m, d]);
    if (folders.length >= 60) return folders;
  }
  return folders;
}

const rolloutCache = new Map<string, string>(); // session id → path; a rollout never moves

function findCodexRollout(codexHome: string, sessionId: string): string | null {
  const sessionsRoot = join(codexHome, "sessions");
  const cached = rolloutCache.get(sessionId);
  if (cached && insideRoot(sessionsRoot, cached)) return cached;
  const suffix = `-${sessionId}.jsonl`;
  for (const parts of candidateFolders(sessionsRoot, sessionId)) {
    const folder = join(sessionsRoot, ...parts);
    let names: string[];
    try { names = readdirSync(folder); } catch { continue; }
    for (const name of names) {
      if (!name.startsWith("rollout-") || !name.endsWith(suffix)) continue;
      const path = insideRoot(sessionsRoot, join(folder, name));
      if (path && firstLineIsMetaFor(path, sessionId)) {
        rolloutCache.set(sessionId, path);
        return path;
      }
    }
  }
  return null;
}

/** The transcript of the managed session `id` ("m:cs-…"), from its own records only. */
export function resolveTranscript(database: Database, id: string, roots: TranscriptRoots): ResolveResult {
  const screen = screenFromId(id);
  if (!screen) return { ok: false, status: 404, error: "No such session." };
  const launch = database.query("SELECT screen, provider, project_path, launch_id, resume_id FROM launches WHERE screen = ?").get(screen) as
    { screen: string; provider: string; project_path: string; launch_id: string | null; resume_id: string | null } | null;
  if (!launch) return { ok: false, status: 404, error: "No such session." };

  if (launch.provider === "codex") {
    const state = launch.launch_id
      ? database.query("SELECT session_id FROM codex_launch_state WHERE launch_id = ? AND screen = ?").get(launch.launch_id, screen) as { session_id: string | null } | null
      : null;
    const raw = state?.session_id ?? launch.resume_id;
    const sessionId = raw && isCodexSessionId(raw) ? raw.toLowerCase() : null;
    const path = sessionId ? findCodexRollout(roots.codexHome, sessionId) : null;
    return { ok: true, value: { provider: "codex", path, launchId: launch.launch_id, screen } };
  }

  if (launch.provider === "claude") {
    const rid = launch.resume_id && RESUME_ID_RE.test(launch.resume_id) ? launch.resume_id : null;
    const folder = join(roots.claudeProjects, launch.project_path.replace(/[^a-zA-Z0-9]/g, "-"));
    const path = rid ? insideRoot(roots.claudeProjects, join(folder, `${rid}.jsonl`)) : null;
    return { ok: true, value: { provider: "claude", path, launchId: launch.launch_id, screen } };
  }

  return { ok: false, status: 422, error: "The chat view isn't available for this agent." };
}
