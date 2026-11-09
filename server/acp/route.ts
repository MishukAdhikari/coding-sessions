/**
 * The Chat (ACP) routes, behind the app's normal sign-in (index.ts calls this after
 * its auth gate):
 *
 *   GET  /api/sessions/:id/acp?after=<cursor>  {mode, state, agent, error, commands, events, cursor, reset}
 *   POST /api/sessions/:id/acp                 {op: "prompt", text} | {op: "cancel"} | {op: "permission", requestId, optionId}
 *   GET  /api/acp/agents                       which agents can launch in Chat mode here
 *
 * Reads come from the session's own event log and state file; commands go to its own
 * bridge socket. Both paths are derived from the session's holder name, after checking
 * that the session is a Chat (ACP) launch — never from anything else in the request.
 */
import type { Database } from "bun:sqlite";
import { PRIVATE_NO_STORE_HEADERS } from "../browser-session";
import type { SessionProvider } from "../session-provider";
import type { AcpAgentInfo } from "./agents";
import { sendBridgeCommand, type BridgeAnswer, type BridgeCommand } from "./client";
import { readEventWindow, readState } from "./event-log";
import { ACP_SCREEN_RE, acpPaths, checkPrivateDir, type AcpPaths } from "./paths";

export interface AcpRouteDependencies {
  database: Database;
  dataDir: string;
  agents: () => AcpAgentInfo[];
  send?: (socket: string, command: BridgeCommand) => Promise<BridgeAnswer>;
}

/** Longest prompt accepted, as for the transcript chat's replies. */
export const MAX_PROMPT = 16 * 1024;
const ROUTE_RE = /^\/api\/sessions\/([^/]+)\/acp$/;
const ID_RE = /^m:(cs-[a-z0-9][a-z0-9_-]{0,42})$/;

type Found = { ok: true; screen: string; provider: SessionProvider; paths: AcpPaths } | { ok: false; status: 404 | 422; error: string };

/** A live Chat (ACP) launch for this id, and its files. */
export function findAcpSession(database: Database, dataDir: string, id: string): Found {
  const screen = id.match(ID_RE)?.[1];
  if (!screen || !ACP_SCREEN_RE.test(screen)) return { ok: false, status: 404, error: "No such session." };
  const row = database.query("SELECT provider, mode FROM launches WHERE screen = ?").get(screen) as { provider: SessionProvider; mode: string } | null;
  if (!row) return { ok: false, status: 404, error: "That session has ended." };
  if (row.mode !== "acp") return { ok: false, status: 404, error: "This session runs in a terminal, not in Chat mode." };
  const resolved = acpPaths(dataDir, screen);
  if (!resolved.ok) return { ok: false, status: 422, error: resolved.error };
  return { ok: true, screen, provider: row.provider, paths: resolved.paths };
}

/** Validate a POST body into one bridge command. Pure. */
export function parseAcpCommand(body: unknown): { ok: true; command: BridgeCommand } | { ok: false; error: string } {
  const b = body && typeof body === "object" ? body as Record<string, unknown> : {};
  switch (b.op) {
    case "prompt": {
      const text = typeof b.text === "string" ? b.text : "";
      if (!text.trim()) return { ok: false, error: "Type a message first." };
      if (text.length > MAX_PROMPT) return { ok: false, error: "That message is too long." };
      return { ok: true, command: { op: "prompt", text } };
    }
    case "cancel":
      return { ok: true, command: { op: "cancel" } };
    case "permission": {
      const requestId = typeof b.requestId === "string" ? b.requestId : "";
      const optionId = typeof b.optionId === "string" ? b.optionId : "";
      if (!/^perm-\d{1,9}$/.test(requestId) || !optionId || optionId.length > 256) return { ok: false, error: "That isn't a permission answer." };
      return { ok: true, command: { op: "permission", requestId, optionId } };
    }
    default:
      return { ok: false, error: "Unknown chat command." };
  }
}

export async function handleAcpRoute(request: Request, deps: AcpRouteDependencies): Promise<Response | null> {
  const url = new URL(request.url);
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE_NO_STORE_HEADERS });

  if (url.pathname === "/api/acp/agents" && request.method === "GET") return json({ agents: deps.agents() });

  const match = url.pathname.match(ROUTE_RE);
  if (!match || (request.method !== "GET" && request.method !== "POST")) return null;
  let id: string;
  try { id = decodeURIComponent(match[1]!); } catch { return json({ error: "No such session." }, 404); }
  const found = findAcpSession(deps.database, deps.dataDir, id);
  if (!found.ok) return json({ error: found.error }, found.status);
  // The bridge creates the directory 0700; anything else is not a directory we read from or connect into.
  const dirOk = checkPrivateDir(found.paths.dir);

  if (request.method === "GET") {
    if (!dirOk.ok) return json({ mode: "acp", state: "starting", agent: null, error: null, commands: [], events: [], cursor: 0, reset: false });
    const rawAfter = url.searchParams.get("after");
    const after = rawAfter !== null && /^\d{1,15}$/.test(rawAfter) ? Number(rawAfter) : null;
    const window = readEventWindow(found.paths.events, after);
    const state = readState(found.paths.state);
    return json({
      mode: "acp",
      state: state?.state ?? "starting",
      agent: state?.agent ?? null,
      error: state?.error ?? null,
      commands: state?.commands ?? [],
      ...window,
    });
  }

  const body = await request.json().catch(() => null);
  const parsed = parseAcpCommand(body);
  if (!parsed.ok) return json({ error: parsed.error }, 422);
  if (!dirOk.ok) return json({ error: "The chat bridge isn't running yet." }, 422);
  const answer = await (deps.send ?? sendBridgeCommand)(found.paths.socket, parsed.command);
  return answer.ok ? json({ ok: true }) : json({ error: answer.error }, 422);
}
