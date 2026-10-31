import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import type { createCliUpdates } from "./cli-updates";

export interface CliUpdatesRouteDependencies {
  cookieName: string;
  origin: string;
  checkBrowserSession: (token: string | null) => boolean;
  controller: ReturnType<typeof createCliUpdates>;
}

const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: PRIVATE_NO_STORE_HEADERS,
});

export async function handleCliUpdatesRoute(req: Request, deps: CliUpdatesRouteDependencies): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/cli-updates") return null;
  if (!hasBrowserSession(req, deps.cookieName, deps.checkBrowserSession)) {
    return json({ error: "Web session required." }, 401);
  }
  if (req.method === "GET") return json(await deps.controller.status());
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (req.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || !("action" in body)) {
    return json({ error: "Choose enable, disable, or run." }, 422);
  }
  const action = body.action;
  if (action !== "enable" && action !== "disable" && action !== "run") return json({ error: "Invalid action." }, 422);
  const result = await deps.controller.control(action);
  return json(result, result.ok ? 200 : 503);
}
