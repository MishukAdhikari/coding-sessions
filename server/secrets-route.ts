import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";
import { SecretStoreError, type SecretStore } from "./secret-store";

export interface SecretsRouteDependencies {
  cookieName: string;
  origin: string;
  checkBrowserSession: (token: string | null) => boolean;
  isAuthenticated: (request: Request) => boolean;
  store: () => SecretStore;
}

/**
 * Secrets are machine-wide credentials, so only a browser session may read the list or
 * change it: a CLI bearer token in someone's config file and MCP clients cannot. No
 * response ever carries a value — names, timestamps and source settings only.
 *
 *   GET    /api/secrets                      names + sources
 *   PUT    /api/secrets/:NAME   {value}      create or replace
 *   DELETE /api/secrets/:NAME
 *   POST   /api/secret-sources  {kind,label,config,credential}   test, then save
 *   POST   /api/secret-sources/:id/sync
 *   DELETE /api/secret-sources/:id
 */
export async function handleSecretsRoute(request: Request, deps: SecretsRouteDependencies): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const isSecrets = path === "/api/secrets" || path.startsWith("/api/secrets/");
  const isSources = path === "/api/secret-sources" || path.startsWith("/api/secret-sources/");
  if (!isSecrets && !isSources) return null;

  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: PRIVATE_NO_STORE_HEADERS });
  if (!hasBrowserSession(request, deps.cookieName, deps.checkBrowserSession)) {
    const anyAuthed = deps.isAuthenticated(request);
    return json({ error: anyAuthed ? "Web session required." : "Unauthorized" }, anyAuthed ? 403 : 401);
  }
  const method = request.method;
  if (method !== "GET" && request.headers.get("origin") !== deps.origin) return json({ error: "Same-origin request required." }, 403);
  const body = async (): Promise<Record<string, unknown>> => {
    const value: unknown = await request.json().catch(() => null);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new SecretStoreError("Send a JSON object.", 400);
    return value as Record<string, unknown>;
  };

  try {
    const store = deps.store();
    if (path === "/api/secrets" && method === "GET") return json(store.list());

    if (isSecrets) {
      const name = decodeURIComponent(path.slice("/api/secrets/".length));
      if (!name || name.includes("/")) return json({ error: "Not found." }, 404);
      if (method === "PUT") return json({ ok: true, secret: store.set(name, (await body()).value) });
      if (method === "DELETE") return store.remove(name) ? json({ ok: true }) : json({ error: "That secret is already gone." }, 404);
      return json({ error: "Method not allowed." }, 405);
    }

    if (path === "/api/secret-sources") {
      if (method === "GET") return json({ sources: store.list().sources });
      if (method === "POST") return json({ ok: true, source: await store.addSource(await body()) });
      return json({ error: "Method not allowed." }, 405);
    }
    const rest = path.slice("/api/secret-sources/".length);
    const [rawId, action, extra] = rest.split("/");
    const id = Number(rawId);
    if (!Number.isInteger(id) || id <= 0 || extra !== undefined) return json({ error: "Not found." }, 404);
    if (action === "sync" && method === "POST") return json({ ok: true, source: await store.syncSource(id) });
    if (action === undefined && method === "DELETE") return store.removeSource(id) ? json({ ok: true }) : json({ error: "That source is already gone." }, 404);
    return json({ error: "Method not allowed." }, 405);
  } catch (error) {
    if (error instanceof SecretStoreError) return json({ error: error.message }, error.status);
    return json({ error: "The secrets store could not complete that request." }, 500);
  }
}
