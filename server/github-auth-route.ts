import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";

export interface GithubAuthRouteController {
  status(): Promise<unknown>;
  saveToken(token: string): Promise<{ ok: boolean; error?: string; account?: string | null }>;
  logout(): Promise<{ ok: boolean; error?: string }>;
}

export interface GithubAuthRouteDependencies {
  cookieName: string;
  checkBrowserSession: (token: string | null) => boolean;
  isAuthenticated: (request: Request) => boolean;
  controller: GithubAuthRouteController;
}

const privateJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status,
  headers: {
    "content-type": "application/json",
    ...PRIVATE_NO_STORE_HEADERS,
  },
});

/** Handle browser-session-only, machine-wide GitHub (gh) authentication routes. */
export async function handleGithubAuthRoute(
  request: Request,
  dependencies: GithubAuthRouteDependencies,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (!path.startsWith("/api/github-auth/")) return null;

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

  if (path === "/api/github-auth/status" && request.method === "GET") {
    return privateJson(await dependencies.controller.status());
  }
  if (path === "/api/github-auth/token" && request.method === "POST") {
    const body = await request.json().catch(() => ({}));
    const token = typeof (body as { token?: unknown }).token === "string" ? (body as { token: string }).token.trim() : "";
    const result = await dependencies.controller.saveToken(token);
    return privateJson(result, result.ok ? 200 : 400);
  }
  if (path === "/api/github-auth/logout" && request.method === "POST") {
    const result = await dependencies.controller.logout();
    return privateJson(result, result.ok ? 200 : 400);
  }
  return privateJson({ error: "Not found" }, 404);
}
