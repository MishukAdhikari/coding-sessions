import { cookieValue, hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import { SecretRequestError, type SecretRequests } from "./secret-requests";
import type { StepUpGrants } from "./step-up";

export interface SecretRequestsRouteDependencies {
  cookieName: string;
  origin: string;
  checkBrowserSession: (token: string | null) => boolean;
  isAuthenticated: (request: Request) => boolean;
  requests: () => SecretRequests;
  /** Step-up grants from /api/server-settings/step-up, spent by Replace and by connector tokens. */
  grants: StepUpGrants;
}

/**
 * The member's side of secret and connector requests. Like Secrets, a browser session only:
 * a CLI bearer token or an MCP client can create requests but never answer them. Every
 * change needs the exact Origin. The link token travels only in POST bodies, never a URL.
 *
 *   GET  /api/secret-requests                    pending requests (Settings › Secrets)
 *   POST /api/secret-requests/lookup  {token|id}
 *   POST /api/secret-requests/fulfil  {token|id, value, replace?, grant?}
 *   POST /api/secret-requests/decline {token|id}
 *   POST /api/secret-requests/connector {token|id, auth: "bearer"|"oauth", value?, grant?}
 */
export async function handleSecretRequestsRoute(request: Request, deps: SecretRequestsRouteDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/secret-requests" && !path.startsWith("/api/secret-requests/")) return null;
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE_NO_STORE_HEADERS });
  if (!hasBrowserSession(request, deps.cookieName, deps.checkBrowserSession)) {
    const anyAuthed = deps.isAuthenticated(request);
    return json({ error: anyAuthed ? "Web session required." : "Unauthorized" }, anyAuthed ? 403 : 401);
  }
  const session = cookieValue(request, deps.cookieName);
  try {
    const requests = deps.requests();
    if (path === "/api/secret-requests") {
      if (request.method !== "GET") return json({ error: "Method not allowed." }, 405);
      return json({ requests: requests.pending() });
    }
    if (request.method !== "POST") return json({ error: "Method not allowed." }, 405);
    if (request.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Send a JSON object." }, 400);
    const input = body as Record<string, unknown>;
    const ref = input.token !== undefined ? { token: input.token } : { id: input.id };
    // Only when a change needs it, and only once: a grant is single use.
    const stepUp = () => !!session && deps.grants.consume(input.grant, session);

    switch (path.slice("/api/secret-requests/".length)) {
      case "lookup": return json({ request: requests.lookup(ref) });
      case "fulfil": return json(requests.fulfilSecret(ref, input.value, { replace: input.replace === true, stepUp }));
      case "decline": return json(requests.decline(ref));
      case "connector":
        if (input.auth === "oauth") return json(await requests.connectorOAuth(ref));
        if (input.auth === "bearer") return json(await requests.connectorBearer(ref, input.value, { stepUp }));
        return json({ error: 'auth must be "bearer" or "oauth".' }, 400);
    }
    return json({ error: "Not found." }, 404);
  } catch (error) {
    if (error instanceof SecretRequestError) return json({ error: error.message, code: error.code }, error.status);
    console.error("Secret request failed.");
    return json({ error: "The request could not be completed." }, 500);
  }
}
