import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import type { createAppUpdates } from "./app-updates";

export interface AppUpdatesRouteDependencies {
  cookieName: string;
  origin: string;
  checkBrowserSession: (token: string | null) => boolean;
  controller: Pick<ReturnType<typeof createAppUpdates>, "status" | "setEnabled">;
}

const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: PRIVATE_NO_STORE_HEADERS,
});

export async function handleAppUpdatesRoute(req: Request, deps: AppUpdatesRouteDependencies): Promise<Response | null> {
  if (new URL(req.url).pathname !== "/api/app-updates") return null;
  if (!hasBrowserSession(req, deps.cookieName, deps.checkBrowserSession)) {
    return json({ error: "Web session required." }, 401);
  }
  if (req.method === "GET") return json(await deps.controller.status());
  if (req.method !== "POST") return json({ error: "Method not allowed." }, 405);
  if (req.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
  const body: unknown = await req.json().catch(() => null);
  if (!body || typeof body !== "object" || typeof (body as { enabled?: unknown }).enabled !== "boolean") {
    return json({ error: "Send enabled: true or false." }, 422);
  }
  const result = await deps.controller.setEnabled((body as { enabled: boolean }).enabled);
  return json(result, result.ok ? 200 : 409);
}
