import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import type { createAgentAccounts } from "./agent-accounts";

export async function handleAgentAccountsRoute(req: Request, deps: {
  cookieName: string;
  origin: string;
  checkBrowserSession: (token: string | null) => boolean;
  accounts: ReturnType<typeof createAgentAccounts>;
}): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/agent-accounts") return null;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE_NO_STORE_HEADERS });
  if (!hasBrowserSession(req, deps.cookieName, deps.checkBrowserSession)) return json({ error: "Web session required." }, 401);
  if (req.method === "GET") return json(await deps.accounts.list());
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (req.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("provider" in body) || !("action" in body)) return json({ error: "Choose an agent and an action." }, 422);
  const result = await deps.accounts.action(body.provider, body.action, "code" in body ? body.code : undefined);
  return json(result, result.ok ? 200 : 422);
}
