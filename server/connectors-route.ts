import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import { ConnectorError, type Connectors, type ConnectorView } from "./connectors";

export interface ConnectorsRouteDependencies {
  cookieName: string;
  checkBrowserSession: (token: string | null) => boolean;
  isAuthenticated: (request: Request) => boolean;
  connectors: Connectors;
}
const privateJson = (data: unknown, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json", ...PRIVATE_NO_STORE_HEADERS },
});
const STATUS: Record<ConnectorError["code"], number> = { unauthorized: 401, invalid_request: 400, not_found: 404, denied: 403, unavailable: 503, rate_limited: 429, storage: 503 };

/**
 * Outbound connectors are machine-wide credentials and grants, so only a browser session
 * may read or change them; CLI bearer tokens and MCP clients cannot.
 */
export async function handleConnectorsRoute(request: Request, deps: ConnectorsRouteDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  if (path !== "/api/connectors" && !path.startsWith("/api/connectors/")) return null;
  if (!hasBrowserSession(request, deps.cookieName, deps.checkBrowserSession)) {
    const anyAuthed = deps.isAuthenticated(request);
    return privateJson({ error: anyAuthed ? "Web session required." : "Unauthorized" }, anyAuthed ? 403 : 401);
  }
  const method = request.method;
  /** Malformed or non-object bodies are rejected, never treated as an empty request. */
  const body = async (): Promise<Record<string, unknown>> => {
    const value = await request.json().catch(() => undefined);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConnectorError("invalid_request", "Send a JSON object.");
    return value as Record<string, unknown>;
  };
  // Every response lists only sessions that are running now, so ended ones never reappear after a change.
  const live = async (view: ConnectorView) => {
    const ids = await deps.connectors.liveLaunchIds();
    return { ...view, launches: view.launches.filter(launch => ids.has(launch.launch_id)) };
  };
  const connector = async (view: ConnectorView | Promise<ConnectorView>) => privateJson({ connector: await live(await view) });
  try {
    if (path === "/api/connectors" && method === "GET") {
      const connectors = await Promise.all(deps.connectors.list().map(live));
      return privateJson({ connectors, launch_entry: deps.connectors.available() });
    }
    if (path === "/api/connectors" && method === "POST") {
      // The token is write-only: accepted here, never echoed.
      const { name, url, token } = await body();
      return await connector(deps.connectors.add({ name, url, token }));
    }
    const match = /^\/api\/connectors\/([0-9a-f-]{36})(?:\/([a-z-]+))?$/.exec(path);
    if (!match) return privateJson({ error: "Not found" }, 404);
    const [, id, action] = match as unknown as [string, string, string | undefined];
    if (!action && method === "DELETE") { deps.connectors.remove(id); return privateJson({ ok: true }); }
    if (!action && method === "GET") return privateJson({ connector: await live(deps.connectors.view(id)), audit: deps.connectors.audit(id) });
    // Only id-shaped paths reach here; every async step below is awaited inside this try.
    if (method !== "POST") return privateJson({ error: "Not found" }, 404);
    const input = await body();
    switch (action) {
      // Write-only: the response never carries the credential, sealed or not.
      // Only an explicit token property acts: a string sets or replaces, null or "" removes.
      case "credential":
        if (!Object.hasOwn(input, "token")) throw new ConnectorError("invalid_request", "Send token (a string, or null to remove it).");
        return await connector(deps.connectors.setCredential(id, input.token));
      case "name": return await connector(deps.connectors.rename(id, input.name));
      case "url": return await connector(deps.connectors.setUrl(id, input.url));
      case "check": return await connector(deps.connectors.check(id));
      case "enabled": return await connector(deps.connectors.setEnabled(id, input.enabled === true));
      case "tools": return await connector(deps.connectors.setTools(id, input.tools));
      case "providers": return await connector(deps.connectors.setDefaultProviders(id, input.providers));
      case "launch": return await connector(deps.connectors.setLaunchGrant(id, input.launch_id, input.granted === true));
    }
    return privateJson({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof ConnectorError) return privateJson({ error: error.message }, STATUS[error.code]);
    console.error("Connector settings request failed.");
    return privateJson({ error: "Connector request failed." }, 500);
  }
}
