/**
 * Last-activity signal for idle checks run on the same machine (CS_ACTIVITY_PORT).
 *
 * A host that stops or suspends idle machines needs to know when this instance was last
 * in use, without a browser sign-in. Activity is any agent working or starting, any
 * agent waiting for an answer or approval, or a web terminal with a browser attached.
 * The response carries a timestamp and counts only: no session names, repositories or
 * content. It is served on its own listener bound to 127.0.0.1, which the HTTPS proxy
 * never forwards to, so it is reachable only from this machine.
 */

export interface ActivityCounts {
  working: number;   // agents working on a turn or starting
  waiting: number;   // agents blocked on a question or approval
  terminals: number; // web terminals with at least one browser attached
}

export interface ActivitySnapshot extends ActivityCounts {
  active: boolean;
  last_activity_at: string; // ISO 8601
  idle_seconds: number;
}

interface SessionLike { status: string; activity?: string }

/** Count activity from the session list and open terminal connections. */
export function countActivity(sessions: SessionLike[], terminalClients: number): ActivityCounts {
  let working = 0, waiting = 0;
  for (const session of sessions) {
    if (session.status === "ended") continue;
    if (session.activity === "waiting") waiting++;
    else if (session.status === "starting" || session.activity === "running" || session.activity === "starting") working++;
  }
  return { working, waiting, terminals: terminalClients };
}

export function createActivitySignal(deps: { sample: () => Promise<ActivityCounts>; now?: () => number; startedAt?: number }) {
  const now = deps.now ?? Date.now;
  // Before anything was seen, the last activity is when the server started.
  let lastActivity = deps.startedAt ?? now();
  let last: ActivityCounts = { working: 0, waiting: 0, terminals: 0 };

  /** Record activity that happened outside a sample, such as a terminal closing. */
  function touch(): void { lastActivity = now(); }

  async function refresh(): Promise<ActivitySnapshot> {
    try { last = await deps.sample(); } catch { /* keep the previous counts */ }
    const active = last.working + last.waiting + last.terminals > 0;
    if (active) touch();
    const at = now();
    return { active, ...last, last_activity_at: new Date(lastActivity).toISOString(), idle_seconds: active ? 0 : Math.max(0, Math.floor((at - lastActivity) / 1000)) };
  }

  return { touch, refresh };
}

export type ActivitySignal = ReturnType<typeof createActivitySignal>;

/** The listener's request handler: one read-only route. */
export async function handleActivityRequest(request: Request, signal: ActivitySignal): Promise<Response> {
  const path = new URL(request.url).pathname;
  if (path !== "/activity") return new Response("Not found\n", { status: 404 });
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed\n", { status: 405, headers: { allow: "GET, HEAD" } });
  return Response.json(await signal.refresh(), { headers: { "cache-control": "no-store" } });
}
