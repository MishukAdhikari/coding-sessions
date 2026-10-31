import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";

export interface CodexAuthRouteController {
  start(): Promise<unknown>;
  status(): Promise<unknown>;
  cancel(): Promise<unknown>;
}

export interface CodexAuthRouteDependencies {
  cookieName: string;
  checkBrowserSession: (token: string | null) => boolean;
  isAuthenticated: (request: Request) => boolean;
  controller: CodexAuthRouteController;
}

const privateJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json",
    ...PRIVATE_NO_STORE_HEADERS,
  },
});

/** Handle browser-session-only, machine-wide Codex authentication routes. */
export async function handleCodexAuthRoute(
  request: Request,
  dependencies: CodexAuthRouteDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/codex-auth/")) return null;

  const browserAuthed = hasBrowserSession(
    request,
    dependencies.cookieName,
    dependencies.checkBrowserSession,
  );
  if (!browserAuthed) {
    const anyAuthed = dependencies.isAuthenticated(request);
    return privateJson(
      { error: anyAuthed ? "Web session required." : "Unauthorized" },
      anyAuthed ? 403 : 401,
    );
  }

  if (path === "/api/codex-auth/start" && request.method === "POST") {
    return privateJson(await dependencies.controller.start());
  }
  if (path === "/api/codex-auth/status" && request.method === "GET") {
    return privateJson(await dependencies.controller.status());
  }
  if (path === "/api/codex-auth/cancel" && request.method === "POST") {
    return privateJson(await dependencies.controller.cancel());
  }
  return privateJson({ error: "Not found" }, 404);
}
