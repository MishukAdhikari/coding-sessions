import type { Database } from "bun:sqlite";
import { PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import { codexActivity } from "./codex-state";
import type { IoResult } from "./session-io";
import { readTail, readTranscriptWindow, resolveTranscript, type TranscriptRoots } from "./transcript";
import { lastTurnState } from "./turn-state";

export interface TranscriptRouteDependencies {
  database: Database;
  roots: TranscriptRoots;
  sendText: (id: string, text: string) => Promise<IoResult<true>>;
  now?: () => number;
}

/** What the agent is doing, in the chat view's words. */
export type ChatState = "asking" | "working" | "waiting" | "unknown";

const MAX_REPLY = 16 * 1024;
const ROUTE_RE = /^\/api\/sessions\/([^/]+)\/(transcript|message)$/;

/**
 * The chat view of a Managed Session, behind the app's normal sign-in. Reads come
 * from the agent's own transcript; replies are typed into the session the same way
 * the MCP `send_message` tool does.
 *
 *   GET  /api/sessions/:id/transcript?after=<cursor>   {provider, messages, cursor, reset, state}
 *   POST /api/sessions/:id/message   {text}
 */
export async function handleTranscriptRoute(request: Request, deps: TranscriptRouteDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  const match = url.pathname.match(ROUTE_RE);
  if (!match) return null;
  const [, rawId, action] = match;
  const isRead = action === "transcript" && request.method === "GET";
  const isReply = action === "message" && request.method === "POST";
  if (!isRead && !isReply) return null;

  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE_NO_STORE_HEADERS });
  let id: string;
  try { id = decodeURIComponent(rawId!); } catch { return json({ error: "No such session." }, 404); }

  const resolved = resolveTranscript(deps.database, id, deps.roots);
  if (!resolved.ok) return json({ error: resolved.error }, resolved.status);
  const { provider, path, launchId, screen } = resolved.value;

  if (isReply) {
    const body = await request.json().catch(() => null) as { text?: unknown } | null;
    const text = typeof body?.text === "string" ? body.text : "";
    if (!text.trim()) return json({ error: "Type a message first." }, 422);
    if (text.length > MAX_REPLY) return json({ error: "That message is too long." }, 422);
    const sent = await deps.sendText(id, text);
    return sent.ok ? json({ ok: true }) : json({ error: sent.error }, 422);
  }

  const rawAfter = url.searchParams.get("after");
  const after = rawAfter !== null && /^\d{1,15}$/.test(rawAfter) ? Number(rawAfter) : null;
  const window = path ? readTranscriptWindow(path, provider, after) : { messages: [], cursor: 0, reset: false };

  let state: ChatState = "unknown";
  if (provider === "codex") {
    const row = launchId
      ? deps.database.query("SELECT turn_state, updated_at FROM codex_launch_state WHERE launch_id = ? AND screen = ?").get(launchId, screen) as
          { turn_state: string; updated_at: number } | null
      : null;
    const activity = codexActivity(row?.turn_state ?? null, row?.updated_at ?? null, deps.now?.() ?? Date.now());
    state = activity.asking ? "asking" : activity.busy ? "working" : activity.waiting ? "waiting" : "unknown";
  } else if (path) {
    // Its own tail read: the cursor window is empty while Claude waits on a question.
    const turn = lastTurnState(readTail(path));
    state = turn === "asking" ? "asking" : turn === "done" ? "waiting" : turn === "busy" ? "working" : "unknown";
  }

  return json({ provider, ...window, state });
}
