/**
 * The live feed of one session, for `cs live` (docs/cli.md#live).
 *
 *   GET /api/sessions/:id/live            WebSocket: pushes {frames, cursor} batches as they happen
 *   GET /api/sessions/:id/live?after=<n>  plain JSON: one batch since a cursor (polling, cs --ssh-api)
 *
 * Behind the app's normal sign-in (browser cookie or CLI token). Frames come from the
 * same records as the chat views: the agent's transcript (Claude Code, Codex) or the
 * Chat (ACP) event log, plus the session list's activity and PR links. Every string is
 * scrubbed of stored secret values and common token shapes before it leaves the server.
 */
import type { ServerWebSocket } from "bun";
import type { AcpEvent } from "./acp/event-log";
import type { ChatMessage } from "./transcript";

export type LiveFrame =
  | { type: "hello"; session: string; name: string; provider: string; mode: string }
  | { type: "state"; activity: string }
  | { type: "message"; role: "user" | "assistant"; text: string; at: string | null }
  | { type: "tool"; text: string; at: string | null }
  | { type: "ask"; text: string; options: string[]; answer: string }
  | { type: "pr"; url: string; repo: string; number: number }
  | { type: "notice"; text: string }
  | { type: "end"; activity: string; reason?: string };

export interface LiveBatch { frames: LiveFrame[]; cursor: number | null; ended: boolean }

/** What the feed needs from the session list. */
export interface LiveSessionView {
  id: string;
  name: string;
  provider: string;
  mode: string;
  activity: string;
  asking: boolean;
  prs: Array<{ url: string; repo: string; number: number }>;
}

/** A source read: content frames after a cursor. `cursor: null` means nothing to read yet. */
export interface SourceWindow { frames: LiveFrame[]; cursor: number | null; reset: boolean }
export type ReadSource = (id: string, after: number | null) => SourceWindow;

/** Frames shown on attach, before following. */
export const LIVE_BACKLOG = 20;
const MAX_TEXT = 4000;

/* ---------- redaction ---------- */

const TOKEN_SHAPES: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bcscomm_[A-Za-z0-9_-]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/g,
];

/** `text` with every stored secret value (8+ chars) and every known token shape replaced. */
export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const value of secrets) if (value.length >= 8) out = out.split(value).join("[redacted]");
  for (const re of TOKEN_SHAPES) out = out.replace(re, "[redacted]");
  return out;
}

function redactFrame(frame: LiveFrame, secrets: readonly string[]): LiveFrame {
  const copy: Record<string, unknown> = { ...frame };
  for (const [k, v] of Object.entries(copy)) {
    if (typeof v === "string" && k !== "type") copy[k] = redact(v, secrets);
    else if (Array.isArray(v) && v.every((x) => typeof x === "string")) copy[k] = v.map((x) => redact(x, secrets));
  }
  return copy as LiveFrame;
}

const clip = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT)}…` : s);

/* ---------- sources → frames (pure) ---------- */

/** Transcript messages (Claude Code, Codex) as frames. */
export function transcriptFrames(messages: ChatMessage[]): LiveFrame[] {
  return messages.map((m): LiveFrame => m.role === "tool"
    ? { type: "tool", text: clip(m.text), at: m.at }
    : { type: "message", role: m.role, text: clip(m.text), at: m.at });
}

/** One line for an ACP diff: "Edit path +3 -1". */
function diffSummary(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const c of content) {
    if (c?.type !== "diff" || typeof c.path !== "string") continue;
    const lines = (s: unknown) => (typeof s === "string" && s ? s.split("\n").length : 0);
    parts.push(`${c.path} +${lines(c.newText)} -${lines(c.oldText)}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/** Chat (ACP) events as frames. Consecutive message chunks join into one message. */
export function acpFrames(events: AcpEvent[]): LiveFrame[] {
  const out: LiveFrame[] = [];
  let chunk: { type: "message"; role: "assistant"; text: string; at: string | null } | null = null;
  const flush = () => { if (chunk && chunk.text.trim()) out.push({ ...chunk, text: clip(chunk.text.trim()) }); chunk = null; };
  for (const e of events) {
    const at = typeof e.at === "string" ? e.at : null;
    if (e.kind === "update") {
      const u = (e.update ?? {}) as Record<string, any>;
      if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") {
        chunk ??= { type: "message", role: "assistant", text: "", at };
        chunk.text += String(u.content.text ?? "");
        continue;
      }
      flush();
      // claude-agent-acp opens a call with a generic title ("Terminal") and empty input,
      // then names it ("echo hello") in an update carrying the input: show that one.
      const inputPending = u.rawInput && typeof u.rawInput === "object" && !Object.keys(u.rawInput).length;
      const named = u.sessionUpdate === "tool_call_update" && typeof u.title === "string" && u.rawInput && typeof u.rawInput === "object" && Object.keys(u.rawInput).length;
      if ((u.sessionUpdate === "tool_call" && !inputPending) || named) {
        const diff = diffSummary(u.content);
        out.push({ type: "tool", text: clip(`${u.title ?? u.kind ?? "Tool call"}${diff ? ` (${diff})` : ""}`), at });
      } else if (u.sessionUpdate === "tool_call_update" && u.status === "failed") {
        out.push({ type: "notice", text: clip(`tool failed: ${u.title ?? u.toolCallId ?? ""}`.trim()) });
      } else if (u.sessionUpdate === "plan" && Array.isArray(u.entries)) {
        out.push({ type: "notice", text: clip(`plan: ${u.entries.map((p: any) => `[${p.status === "completed" ? "x" : " "}] ${p.content}`).join("  ")}`) });
      }
      continue;
    }
    flush();
    if (e.kind === "user" && typeof e.text === "string") out.push({ type: "message", role: "user", text: clip(e.text), at });
    else if (e.kind === "permission") {
      const options = Array.isArray(e.options) ? (e.options as Array<{ name?: unknown }>).map((o) => String(o?.name ?? "")).filter(Boolean) : [];
      const title = (e.toolCall as { title?: unknown } | null)?.title;
      out.push({ type: "ask", text: clip(`permission: ${typeof title === "string" ? title : "a tool call"}`), options, answer: "answer in the app's Chat, or ask your agent to send_message with an option's name" });
    } else if (e.kind === "permission_resolved") {
      out.push({ type: "notice", text: e.auto ? "permission granted automatically" : e.outcome === "cancelled" ? "permission cancelled" : "permission answered" });
    } else if (e.kind === "notice" && typeof e.text === "string") out.push({ type: "notice", text: clip(e.text) });
  }
  flush();
  return out;
}

/* ---------- one subscriber's feed ---------- */

const FINAL = new Set(["ended", "failed"]);

/** Follows one session: call step() on every tick; it returns only what changed. */
export class LiveFeed {
  cursor: number | null;
  private activity: string | null = null;
  private asking = false;
  private prs = new Set<string>();
  private greeted = false;
  ended = false;

  constructor(readonly id: string, after: number | null = null, private backlog = LIVE_BACKLOG) {
    this.cursor = after;
  }

  step(session: LiveSessionView | null, read: ReadSource, secrets: readonly string[]): LiveBatch {
    const frames: LiveFrame[] = [];
    if (this.ended) return { frames, cursor: this.cursor, ended: true };
    if (!session) {
      frames.push({ type: "end", activity: "ended", reason: this.greeted ? "the session has ended" : "no such live session" });
      this.ended = true;
      return { frames, cursor: this.cursor, ended: true };
    }
    if (!this.greeted) {
      frames.push({ type: "hello", session: session.id, name: session.name, provider: session.provider, mode: session.mode });
      this.greeted = true;
      // PR links already there on attach are shown once, not as news.
    }
    if (session.activity !== this.activity) {
      frames.push({ type: "state", activity: session.activity });
      this.activity = session.activity;
    }

    const first = this.cursor === null;
    const w = read(this.id, this.cursor);
    if (w.reset && !first) frames.push({ type: "notice", text: "the transcript started over (a new launch)" });
    frames.push(...(first ? w.frames.slice(-this.backlog) : w.frames));
    this.cursor = w.cursor;

    // Terminal agents ask in their terminal; Chat (ACP) asks come from its event log.
    if (session.asking && !this.asking && session.mode !== "acp") {
      frames.push({ type: "ask", text: "the agent is waiting for your answer", options: [], answer: `answer in the app, or in this terminal: cs mirror ${session.name}` });
    }
    this.asking = session.asking;

    for (const pr of session.prs) {
      if (this.prs.has(pr.url)) continue;
      this.prs.add(pr.url);
      frames.push({ type: "pr", url: pr.url, repo: pr.repo, number: pr.number });
    }

    if (FINAL.has(session.activity)) {
      frames.push({ type: "end", activity: session.activity });
      this.ended = true;
    }
    return { frames: frames.map((f) => redactFrame(f, secrets)), cursor: this.cursor, ended: this.ended };
  }
}

/* ---------- the hub: one shared tick for every open live socket ---------- */

export interface LiveSocketData { live: { id: string; after: number | null; feed?: LiveFeed } }

export interface LiveHubDependencies {
  sessions: () => Promise<LiveSessionView[]>;
  read: ReadSource;
  secrets: () => Promise<string[]>;
  intervalMs?: number;
}

/** Most live sockets open at once, across all clients. */
export const MAX_LIVE_SOCKETS = 16;

export function createLiveHub(deps: LiveHubDependencies) {
  const sockets = new Set<ServerWebSocket<LiveSocketData>>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let ticking = false;

  async function tick(only?: ServerWebSocket<LiveSocketData>) {
    if (ticking && !only) return;
    if (!only) ticking = true;
    try {
      const [list, secrets] = await Promise.all([deps.sessions(), deps.secrets()]);
      const byId = new Map(list.map((s) => [s.id, s]));
      for (const ws of only ? [only] : [...sockets]) {
        const feed = ws.data.live.feed;
        if (!feed || !sockets.has(ws)) continue;
        let batch: LiveBatch;
        try { batch = feed.step(byId.get(feed.id) ?? null, deps.read, secrets); } catch { continue; }
        if (batch.frames.length) try { ws.send(JSON.stringify(batch)); } catch {}
        if (batch.ended) { sockets.delete(ws); try { ws.close(1000, "session ended"); } catch {} }
      }
    } catch { /* the next tick tries again */ } finally {
      if (!only) ticking = false;
      if (!sockets.size && timer) { clearInterval(timer); timer = null; }
    }
  }

  return {
    get size() { return sockets.size; },
    full: () => sockets.size >= MAX_LIVE_SOCKETS,
    open(ws: ServerWebSocket<LiveSocketData>) {
      ws.data.live.feed = new LiveFeed(ws.data.live.id, ws.data.live.after);
      sockets.add(ws);
      timer ??= setInterval(() => { void tick(); }, deps.intervalMs ?? 1000);
      void tick(ws);
    },
    close(ws: ServerWebSocket<LiveSocketData>) {
      sockets.delete(ws);
      if (!sockets.size && timer) { clearInterval(timer); timer = null; }
    },
    /** One batch for a plain GET (polling). */
    async once(id: string, after: number | null): Promise<LiveBatch> {
      const [list, secrets] = await Promise.all([deps.sessions(), deps.secrets()]);
      const feed = new LiveFeed(id, after);
      return feed.step(list.find((s) => s.id === id) ?? null, deps.read, secrets);
    },
  };
}

export const LIVE_ROUTE_RE = /^\/api\/sessions\/([^/]+)\/live$/;
