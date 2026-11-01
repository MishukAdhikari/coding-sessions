import { config } from "./config";
import { loadTokenKey } from "./secrets";
import { resolvePublicFile, requestClientIp, allowsApiMutation } from "./http-security";
import { db, setMeta } from "./db";
import * as auth from "./auth";
import { listSessions, launchSession, launchWorkspaceSession, killSession, killAll, workspaceState, listRepos, sessionPrefix, PREFIX_RE, listArchive, deleteArchived, clearArchive, resumeArchived, syncedStatus, prepareSynced, launchSynced, managedSessionId } from "./sessions";
import * as claudeAuth from "./claude-auth";
import { codexAuth } from "./codex-auth";
import * as claudeChat from "./claude-chat";
import * as terminal from "./terminal";
import * as mux from "./mux";
import { filterDownstream, filterUpstream } from "./ttyd-filter";
import { existsSync, statSync } from "node:fs";
import { join, normalize } from "node:path";
import { APP_CAPABILITIES, PROVIDER_CAPABILITIES, BUILTIN_SESSION_PROVIDERS, commandSlug, commandProviderId, isCommandProvider, launchOptionsFromRequest, type SessionProvider } from "./session-provider";
import { cookieValue, hasBrowserSession } from "./browser-session";
import { handleCodexAuthRoute } from "./codex-auth-route";
import { handleGithubAuthRoute } from "./github-auth-route";
import { githubStatus, saveGithubToken, removeGithubAuth } from "./github-auth";
import { validateProjectPath } from "./project-path";
import { hostStats } from "./host-stats";
import { clearCommandToken, createCommand, deleteCommand, findCommand, listCommands, setCommandToken } from "./commands";
import { clearCommandCodeToken, hasCommandCodeToken, preflightCommandCode, setCommandCodeToken } from "./command-code";
import { fetchBranches, fetchPull, parsePullRef, parseRepoRef } from "./repo-refs";
import * as oauth from "./oauth";
import { handleOAuthRoute, mcpUnauthorized } from "./oauth-route";
import { handleMcpPost, type McpDeps } from "./mcp";
import { handleCommunicatorRequest } from "./communicator-mcp";
import { communicator, connectors } from "./communicator-runtime";
import { handleConnectorRequest } from "./connector-mcp";
import { handleConnectorsRoute } from "./connectors-route";
import { ConnectorOAuth } from "./connector-oauth";
import { handleConnectorOAuthPublic } from "./connector-oauth-route";
import * as sessionIo from "./session-io";
import { cliUpdates } from "./cli-updates";
import { handleCliUpdatesRoute } from "./cli-updates-route";
import { agentAccounts } from "./agent-accounts";
import { handleAgentAccountsRoute } from "./agent-accounts-route";
import { recordAccountLogin } from "./account-history";

const PORT = config.port;
const COOKIE_SECURE = config.cookieSecure;
const COOKIE_NAME = "xs_auth";
const PUBLIC_DIR = new URL("../public", import.meta.url).pathname;

loadTokenKey(); // Reject a missing/malformed configured encryption key before serving requests.
// The redirect URI and client metadata derive from the configured ORIGIN, never a request's Host.
const connectorOAuth = new ConnectorOAuth({ connectors, origin: auth.ORIGIN });
const bootstrapPath = await auth.ensureAdminPassword();
if (bootstrapPath) console.log(`Initial admin credential is in the protected file: ${bootstrapPath}`);

/* ---------- helpers ---------- */

const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", ...headers } });

function authCookie(token: string, maxAge: number): string {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${COOKIE_SECURE ? "; Secure" : ""}`;
}

function clientIp(req: Request, server: Bun.Server): string {
  return requestClientIp(req, server.requestIP(req)?.address ?? null, config.trustProxy);
}

function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** A `cmd:*` id can be well-formed and still name nothing — say so before launching. */
function unregisteredCommand(provider: SessionProvider): string | null {
  if (!isCommandProvider(provider)) return null;
  const slug = commandSlug(provider);
  return slug && findCommand(slug) ? null : "That command is not registered.";
}

function isAuthed(req: Request): boolean {
  return hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession) || auth.checkCliToken(bearerToken(req));
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
};

/* Code and markup revalidate on every load and answer 304 when unchanged, so a
   deploy lands even if someone forgets to bump the ?v= on a script tag — that
   silence is worse than the handful of conditional requests it costs. Images and
   the manifest keep the long cache; they change with a new filename. */
const REVALIDATE = new Set([".html", ".js", ".css"]);

function serveStatic(pathname: string, req: Request): Response | null {
  const full = resolvePublicFile(PUBLIC_DIR, pathname);
  if (!full) return null;
  const ext = full.slice(full.lastIndexOf("."));
  const stat = statSync(full);
  const etag = `"${stat.size.toString(36)}-${Math.floor(stat.mtimeMs).toString(36)}"`;
  const headers = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "cache-control": REVALIDATE.has(ext) ? "no-cache" : "public, max-age=3600",
    etag,
  };
  if (req.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(full), { headers });
}

/* ---------- MCP connector ---------- */

/** /mcp takes a connector's OAuth access token, or an xcm CLI token for clients
 *  configured with a fixed header. Never the browser cookie: /mcp is for programs. */
function isMcpAuthed(req: Request): boolean {
  const token = bearerToken(req);
  return oauth.checkAccessToken(db, token) || auth.checkCliToken(token);
}

const mcpDeps: McpDeps = {
  accounts: agentAccounts,
  listSessions,
  listArchive,
  hostStats,
  listProjects: () => db.query("SELECT id, path, label FROM projects ORDER BY label").all() as Array<{ id: number; path: string; label: string }>,
  listRepos,
  providers: () => [
    ...BUILTIN_SESSION_PROVIDERS.map((id) => ({
      id: id as SessionProvider,
      name: PROVIDER_CAPABILITIES[id].displayName,
      remoteControl: PROVIDER_CAPABILITIES[id].remoteControl,
      turnState: PROVIDER_CAPABILITIES[id].semanticStatus,
    })),
    ...listCommands().map((c) => ({ id: commandProviderId(c.slug), name: c.label, remoteControl: false, turnState: false })),
  ],
  async launch({ name, provider, projectId, repo, remoteControl }) {
    const options = launchOptionsFromRequest({ provider, remoteControl: PROVIDER_CAPABILITIES[provider as keyof typeof PROVIDER_CAPABILITIES]?.remoteControl ? remoteControl : false });
    if (!options.ok) return options;
    const unknown = unregisteredCommand(options.provider);
    if (unknown) return { ok: false, error: unknown };
    const r = repo
      ? await launchWorkspaceSession(name, repo, options.remoteControl, options.provider)
      : await launchSession(name, Number(projectId), options.remoteControl, options.provider);
    return r.ok ? { ok: true, id: managedSessionId(name) } : r;
  },
  end: (id, deleteWorkspace) => killSession(id, false, deleteWorkspace, false),
  async resume(archiveId) {
    const entry = listArchive().find((a) => a.id === archiveId);
    if (!entry) return { ok: false, error: "No archived session with that id." };
    return resumeArchived(archiveId, entry.provider);
  },
  readScreen: sessionIo.readScreen,
  sendText: sessionIo.sendText,
  sendKeys: sessionIo.sendKeys,
  sleep: (ms) => Bun.sleep(ms),
  now: () => Date.now(),
};

/* ---------- server ---------- */

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: PORT,
  maxRequestBodySize: 1024 * 1024,
  async fetch(req, srv) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    /* ----- web terminal: reverse-proxy to the per-terminal ttyd ----- */
    if (path.startsWith("/term/")) {
      const isWs = req.headers.get("upgrade")?.toLowerCase() === "websocket";
      if (!isAuthed(req)) {
        return isWs ? new Response("Unauthorized", { status: 401 }) : Response.redirect("/", 302);
      }
      const id = path.split("/")[2] ?? "";
      const t = terminal.get(id);
      if (!t) return new Response("No such terminal", { status: 404 });

      if (isWs) {
        if (req.headers.get("origin") !== auth.ORIGIN) return new Response("Forbidden", { status: 403 });
        const proto = req.headers.get("sec-websocket-protocol")?.split(",")[0].trim() || null;
        const ok = srv.upgrade(req, {
          data: { term: { id, socketPath: t.socketPath, path: path + (url.search || ""), proto, mouse: t.mux === "zmx" } },
          headers: proto ? { "Sec-WebSocket-Protocol": proto } : undefined,
        });
        return ok ? undefined : new Response("Upgrade failed", { status: 400 });
      }

      const headers = new Headers(req.headers);
      headers.delete("host");
      headers.set("accept-encoding", "identity"); // ask ttyd not to compress
      const init: RequestInit = { method, headers, redirect: "manual" };
      if (method !== "GET" && method !== "HEAD") { init.body = req.body; (init as any).duplex = "half"; }
      const up = await fetch(`http://localhost${path}${url.search}`, { ...init, unix: t.socketPath });
      // Bun's fetch decodes any content-encoding into the body stream — drop the
      // stale encoding/length headers so the browser doesn't try to gunzip plain bytes.
      const rh = new Headers(up.headers);
      rh.delete("content-encoding");
      rh.delete("content-length");
      return new Response(up.body, { status: up.status, statusText: up.statusText, headers: rh });
    }

    /* ----- MCP connector: OAuth + discovery, then the endpoint itself ----- */

    const oauthResponse = await handleOAuthRoute(req, {
      db,
      origin: auth.ORIGIN,
      cookieName: COOKIE_NAME,
      checkBrowserSession: auth.checkAuthSession,
      hasPasskey: auth.hasPasskey,
      rateLimited: auth.rateLimited,
      clientIp: (r) => clientIp(r, srv),
    });
    if (oauthResponse) return oauthResponse;

    if (path === "/mcp/communicator") return handleCommunicatorRequest(communicator, req);
    if (path === "/mcp/connectors") return handleConnectorRequest(connectors, req);

    if (path === "/mcp") {
      if (!isMcpAuthed(req)) return mcpUnauthorized(auth.ORIGIN);
      // Stateless and JSON-only: no server-sent stream to open, no session to end.
      if (method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: { allow: "POST" } });
      return handleMcpPost(mcpDeps, req);
    }

    // Outbound connector OAuth: the public client-metadata document and the inert callback
    // landing (no app cookie arrives on the provider's cross-site redirect; completion is a
    // same-origin POST under /api/connectors that requires the cookie and Origin).
    const connectorOAuthResponse = handleConnectorOAuthPublic(req, { oauth: connectorOAuth });
    if (connectorOAuthResponse) return connectorOAuthResponse;

    if (!path.startsWith("/api/")) {
      const res = serveStatic(path, req);
      return res ?? new Response("Not found", { status: 404 });
    }

    if (!allowsApiMutation(req, auth.ORIGIN, COOKIE_NAME)) {
      return json({ error: "Same-origin request required." }, 403);
    }

    /* ----- public auth endpoints ----- */

    if (path === "/api/me" && method === "GET") {
      return json({ authed: isAuthed(req), hasPasskey: auth.hasPasskey(), rpId: auth.RP_ID, mux: mux.newSessionBackend() });
    }

    if (path === "/api/auth/password" && method === "POST") {
      const ip = clientIp(req, srv);
      if (auth.rateLimited(`pw:${ip}`)) return json({ error: "Too many attempts. Try again in 15 minutes." }, 429);
      const body = await req.json().catch(() => ({}));
      if (typeof body.password !== "string" || !(await auth.verifyPassword(body.password))) {
        return json({ error: "Wrong password." }, 401);
      }
      const token = auth.createAuthSession(req.headers.get("user-agent"));
      return json({ ok: true }, 200, { "set-cookie": authCookie(token, 30 * 24 * 3600) });
    }

    if (path === "/api/auth/login/options" && method === "GET") {
      if (auth.rateLimited(`lo:${clientIp(req, srv)}`, 30)) return json({ error: "Too many attempts." }, 429);
      return json(await auth.authenticationOptions());
    }

    if (path === "/api/auth/login/verify" && method === "POST") {
      if (auth.rateLimited(`lv:${clientIp(req, srv)}`, 15)) return json({ error: "Too many attempts." }, 429);
      const body = await req.json().catch(() => ({}));
      const result = await auth.verifyAuthentication(body.challengeId, body.response);
      if (!result.verified) return json({ error: result.error }, 401);
      const token = auth.createAuthSession(req.headers.get("user-agent"));
      return json({ ok: true }, 200, { "set-cookie": authCookie(token, 30 * 24 * 3600) });
    }

    /* ----- machine-wide Codex auth: browser session only, never CLI bearer ----- */

    const codexAuthResponse = await handleCodexAuthRoute(req, {
      cookieName: COOKIE_NAME,
      checkBrowserSession: auth.checkAuthSession,
      isAuthenticated: isAuthed,
      controller: codexAuth,
    });
    if (codexAuthResponse) return codexAuthResponse;

    /* ----- machine-wide GitHub (gh) auth: browser session only, never CLI bearer ----- */

    const accountResponse = await handleAgentAccountsRoute(req, {
      cookieName: COOKIE_NAME, origin: auth.ORIGIN,
      checkBrowserSession: auth.checkAuthSession, accounts: agentAccounts,
    });
    if (accountResponse) return accountResponse;

    const cliUpdatesResponse = await handleCliUpdatesRoute(req, {
      cookieName: COOKIE_NAME,
      origin: auth.ORIGIN,
      checkBrowserSession: auth.checkAuthSession,
      controller: cliUpdates,
    });
    if (cliUpdatesResponse) return cliUpdatesResponse;

    const connectorsResponse = await handleConnectorsRoute(req, {
      cookieName: COOKIE_NAME, checkBrowserSession: auth.checkAuthSession, isAuthenticated: isAuthed, connectors,
      oauth: connectorOAuth, origin: auth.ORIGIN,
    });
    if (connectorsResponse) return connectorsResponse;

    const githubAuthResponse = await handleGithubAuthRoute(req, {
      cookieName: COOKIE_NAME,
      checkBrowserSession: auth.checkAuthSession,
      isAuthenticated: isAuthed,
      controller: {
        status: githubStatus,
        saveToken: saveGithubToken,
        logout: removeGithubAuth,
      },
    });
    if (githubAuthResponse) return githubAuthResponse;

    /* ----- everything below requires auth ----- */

    if (!isAuthed(req)) return json({ error: "Unauthorized" }, 401);

    if (path === "/api/capabilities" && method === "GET") {
      // Never the token itself — hasToken is all any client needs to render state.
      return json({
        ...APP_CAPABILITIES,
        defaults: { repository: config.repository },
        agentPermissions: config.unrestrictedAgents ? "unrestricted" : "standard",
        commandCode: { hasToken: hasCommandCodeToken() },
        commands: listCommands().map(({ id, slug, provider, label, envVar, hasToken }) =>
          ({ id, slug, provider, label, envVar, hasToken })),
      });
    }

    if (path === "/api/auth/logout" && method === "POST") {
      auth.destroyAuthSession(cookieValue(req, COOKIE_NAME));
      return json({ ok: true }, 200, { "set-cookie": authCookie("", 0) });
    }

    if (path === "/api/auth/register/options" && method === "GET") {
      return json(await auth.registrationOptions());
    }

    if (path === "/api/auth/register/verify" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const label = typeof body.label === "string" ? body.label.slice(0, 60) : null;
      const result = await auth.verifyRegistration(body.challengeId, body.response, label);
      return result.verified ? json({ ok: true }) : json({ error: result.error }, 400);
    }

    if (path === "/api/passkeys" && method === "GET") {
      return json({ passkeys: auth.credentialSummaries() });
    }

    if (path.startsWith("/api/passkeys/") && method === "DELETE") {
      auth.deleteCredential(Number(path.split("/").pop()));
      return json({ ok: true });
    }

    /* ----- Commands registry (managed from a web session only) -----
       Registering a Command is arbitrary execution as the service user, so it takes
       the same posture as the credential routes: browser session, never a bearer
       token that lives in a config file on someone's laptop. */

    if (path === "/api/commands" && method === "GET") {
      if (!isAuthed(req)) return json({ error: "Unauthorized" }, 401);
      return json({ commands: listCommands() });
    }

    if (path === "/api/commands" && method === "POST") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      const body = await req.json().catch(() => ({}));
      const result = createCommand(body);
      return result.ok ? json({ command: result.command }) : json({ error: result.error }, 422);
    }

    // Per-Command credential. Browser session only — a CLI bearer token living in a
    // config file must not be able to write another service's credential. The stored
    // token is never returned by any route; listCommands reports only hasToken.
    if (path.startsWith("/api/commands/") && path.endsWith("/token") && method === "POST") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      const id = Number(path.slice("/api/commands/".length, -"/token".length));
      if (!Number.isInteger(id)) return json({ error: "Bad id." }, 422);
      const body = await req.json().catch(() => ({}));
      const result = setCommandToken(id, body.token);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, 422);
    }

    if (path.startsWith("/api/commands/") && path.endsWith("/token") && method === "DELETE") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      const id = Number(path.slice("/api/commands/".length, -"/token".length));
      if (!Number.isInteger(id)) return json({ error: "Bad id." }, 422);
      return clearCommandToken(id) ? json({ ok: true }) : json({ error: "That command is already gone." }, 404);
    }

    if (path.startsWith("/api/commands/") && method === "DELETE") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      const id = Number(path.split("/").pop());
      if (!Number.isInteger(id)) return json({ error: "Bad id." }, 422);
      return deleteCommand(id) ? json({ ok: true }) : json({ error: "That command is already gone." }, 404);
    }

    /* ----- CLI access tokens (managed from a web session only) ----- */

    if (path === "/api/cli-tokens" && method === "GET") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      return json({ tokens: auth.listCliTokens() });
    }

    if (path === "/api/cli-tokens" && method === "POST") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      const body = await req.json().catch(() => ({}));
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : null;
      return json({ token: auth.createCliToken(label) }); // raw value shown once
    }

    if (path.startsWith("/api/cli-tokens/") && method === "DELETE") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      auth.revokeCliToken(Number(path.split("/").pop()));
      return json({ ok: true });
    }

    /* ----- MCP connections (managed from a web session only) ----- */

    if (path === "/api/mcp-connections" && method === "GET") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      return json({ connections: oauth.listConnections(db) });
    }

    if (path.startsWith("/api/mcp-connections/") && method === "DELETE") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      oauth.revokeClient(db, decodeURIComponent(path.split("/").pop() ?? ""));
      return json({ ok: true });
    }

    /* ----- Web terminals ----- */

    if (path === "/api/terminal" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const target = body.kind === "attach"
        ? { kind: "attach" as const, screen: String(body.screen ?? "") }
        : { kind: "shell" as const, cwd: body.cwd ? String(body.cwd) : undefined };
      const r = await terminal.open(target);
      return r.ok ? json({ ok: true, id: r.id, url: r.url, mux: r.mux }) : json({ error: r.error }, 422);
    }

    if (path === "/api/terminals" && method === "GET") {
      return json({ terminals: terminal.list() });
    }

    if (path.startsWith("/api/terminals/") && method === "DELETE") {
      await terminal.close(decodeURIComponent(path.split("/").pop() ?? ""), url.searchParams.get("quit") === "1");
      return json({ ok: true });
    }

    /* ----- Synced Launch (xcm CLI): status → prepare → [caller rsyncs] → launch ----- */

    if (path === "/api/synced/status" && method === "GET") {
      const r = await syncedStatus(String(url.searchParams.get("name") ?? ""));
      return r.ok ? json(r.status) : json({ error: r.error }, 422);
    }

    if (path === "/api/synced/prepare" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = await prepareSynced(String(body.name ?? ""), String(body.repo ?? ""), body.branch ? String(body.branch) : null);
      return r.ok ? json({ ok: true, workspacePath: r.workspacePath }) : json({ error: r.error }, 422);
    }

    if (path === "/api/synced/launch" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = await launchSynced(String(body.name ?? ""), body.prompt ? String(body.prompt) : null, body.resumeId ? String(body.resumeId) : null, { autoMode: body.autoMode === true });
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 422);
    }

    if (path === "/api/sessions" && method === "GET") {
      return json({ sessions: await listSessions(), archived: listArchive(), host: hostStats() });
    }

    if (path === "/api/archive/clear" && method === "POST") {
      return json(clearArchive());
    }

    if (path.startsWith("/api/archive/") && path.endsWith("/resume") && method === "POST") {
      const id = Number(path.slice("/api/archive/".length, -"/resume".length));
      if (!Number.isInteger(id)) return json({ error: "Bad id." }, 422);
      const body = await req.json().catch(() => ({}));
      const options = launchOptionsFromRequest(body);
      if (!options.ok) return json({ error: options.error }, 422);
      const r = await resumeArchived(id, options.provider);
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 422);
    }

    if (path.startsWith("/api/archive/") && method === "DELETE") {
      const id = Number(path.split("/").pop());
      if (!Number.isInteger(id)) return json({ error: "Bad id." }, 422);
      const result = await deleteArchived(id, url.searchParams.get("ws") === "1", url.searchParams.get("chat") === "1");
      return result.ok ? json(result) : json({ error: result.error }, 422);
    }

    if (path === "/api/browser-auth/start" && method === "POST") {
      const started = await claudeChat.startBrowserAuth();
      return started.ok ? json(started) : json({ error: started.error }, 422);
    }

    if (path === "/api/browser-auth/status" && method === "GET") {
      return json({ ...claudeChat.browserAuthStatus(), queue: claudeChat.queueState() });
    }

    if (path === "/api/browser-auth/code" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = claudeChat.submitBrowserCode(String(body.code ?? "").trim());
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 422);
    }

    if (path === "/api/browser-auth/cancel" && method === "POST") {
      return json(await claudeChat.cancelBrowserAuth());
    }

    if (path === "/api/chat-queue/retry" && method === "POST") {
      const n = claudeChat.retryFailed();
      claudeChat.processQueue().catch(() => {});
      return json({ retried: n });
    }

    if (path === "/api/sessions" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const options = launchOptionsFromRequest(body);
      if (!options.ok) return json({ error: options.error }, 422);
      const unknown = unregisteredCommand(options.provider);
      if (unknown) return json({ error: unknown }, 422);
      const result = typeof body.repo === "string" && body.repo.trim()
        ? await launchWorkspaceSession(String(body.name ?? ""), body.repo, options.remoteControl, options.provider)
        : await launchSession(String(body.name ?? ""), Number(body.projectId), options.remoteControl, options.provider);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, 422);
    }

    if (path === "/api/sessions/kill-all" && method === "POST") {
      return json(await killAll());
    }

    if (path.startsWith("/api/sessions/") && path.endsWith("/ws-state") && method === "GET") {
      const id = decodeURIComponent(path.slice("/api/sessions/".length, -"/ws-state".length));
      return json(await workspaceState(id));
    }

    if (path.startsWith("/api/sessions/") && method === "DELETE") {
      const id = decodeURIComponent(path.slice("/api/sessions/".length));
      const force = url.searchParams.get("force") === "1";
      const deleteWs = url.searchParams.get("ws") === "1";
      const deleteChat = url.searchParams.get("chat") === "1";
      const result = await killSession(id, force, deleteWs, deleteChat);
      return result.ok ? json({ ok: true }) : json({ error: result.error }, 422);
    }

    if (path === "/api/settings" && method === "GET") {
      return json({ prefix: sessionPrefix() });
    }

    if (path === "/api/settings" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const prefix = String(body.prefix ?? "").trim();
      if (prefix && !PREFIX_RE.test(prefix)) {
        return json({ error: "Prefix must be 1-12 chars: letters, numbers, dashes." }, 422);
      }
      setMeta("session_prefix", prefix);
      return json({ ok: true, prefix });
    }

    if (path === "/api/repos" && method === "GET") {
      return json({ repos: await listRepos() });
    }

    // Branches for one repo, so the launcher can offer a picker instead of asking
    // the operator to remember a branch name and type it after a `#`.
    if (path === "/api/repos/branches" && method === "GET") {
      const ref = parseRepoRef(url.searchParams.get("repo") ?? "");
      if (!ref) return json({ error: "That doesn't look like owner/repo." }, 422);
      const result = await fetchBranches(ref);
      return result.ok ? json({ repo: ref.slug, ...result.data }) : json({ error: result.error }, 422);
    }

    // A pasted pull-request URL resolves to the branch it wants to merge.
    if (path === "/api/repos/pull" && method === "GET") {
      const ref = parsePullRef(url.searchParams.get("url") ?? "");
      if (!ref) return json({ error: "That doesn't look like a pull request URL." }, 422);
      const result = await fetchPull(ref);
      return result.ok ? json(result.data) : json({ error: result.error }, 422);
    }

    if (path === "/api/claude-auth/start" && method === "POST") {
      const r = await claudeAuth.startAuth();
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 500);
    }

    if (path === "/api/claude-auth/status" && method === "GET") {
      return json(await claudeAuth.authStatus());
    }

    if (path === "/api/claude-auth/code" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const r = await claudeAuth.submitCode(String(body.code ?? "").trim());
      return r.ok ? json({ ok: true }) : json({ error: r.error }, 422);
    }

    if (path === "/api/claude-auth/cancel" && method === "POST") {
      return json(await claudeAuth.cancelAuth());
    }

    /* ----- Command Code credential: an API key the sessions inherit as an env var.
       Reported, never returned: the status route says whether a key is stored and
       whether the CLI accepts it, and no route hands the key back to a client. ----- */

    if (path === "/api/command-code-auth/status" && method === "GET") {
      const preflight = await preflightCommandCode();
      return json({
        hasToken: hasCommandCodeToken(),
        ok: preflight.ok,
        ...(preflight.ok
          ? { version: preflight.version }
          : { code: preflight.code, message: preflight.message }),
      });
    }

    // Browser session only, like every other credential write: a CLI bearer token
    // living in a config file must not be able to set another service's key.
    if (path === "/api/command-code-auth/token" && method === "POST") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      const body = await req.json().catch(() => ({}));
      const saved = setCommandCodeToken(body.token);
      if (!saved.ok) return json({ error: saved.error }, 422);
      // Report what the CLI makes of the key just stored, rather than "saved" alone.
      const preflight = await preflightCommandCode();
      if (preflight.ok) recordAccountLogin("command-code", null);
      return json({
        ok: true,
        verified: preflight.ok,
        ...(preflight.ok ? { version: preflight.version } : { message: preflight.message }),
      });
    }

    if (path === "/api/command-code-auth/token" && method === "DELETE") {
      if (!hasBrowserSession(req, COOKIE_NAME, auth.checkAuthSession)) return json({ error: "Web session required." }, 403);
      return clearCommandCodeToken() ? json({ ok: true }) : json({ error: "No API key was stored." }, 404);
    }

    if (path === "/api/projects" && method === "GET") {
      return json({ projects: db.query("SELECT id, path, label FROM projects ORDER BY label").all() });
    }

    if (path === "/api/projects" && method === "POST") {
      const body = await req.json().catch(() => ({}));
      const checked = validateProjectPath(body.path, body.create === true);
      if (!checked.ok) return json({ error: checked.error }, 422);
      const p = checked.path;
      const label = typeof body.label === "string" && body.label.trim() ? body.label.trim().slice(0, 60) : p;
      db.query("INSERT OR IGNORE INTO projects (path, label) VALUES (?, ?)").run(p, label);
      return json({ ok: true });
    }

    if (path.startsWith("/api/projects/") && method === "DELETE") {
      db.query("DELETE FROM projects WHERE id = ?").run(Number(path.split("/").pop()));
      return json({ ok: true });
    }

    return json({ error: "Not found" }, 404);
  },

  /* Relay each browser terminal socket to its per-terminal ttyd (raw byte proxy). */
  websocket: {
    open(ws) {
      const d = ws.data as any;
      const info = d?.term;
      if (!info) { ws.close(); return; }
      terminal.markOpen(info.id);
      d.buf = [];
      const uws = new WebSocket(`ws+unix://${info.socketPath}:${info.path}`, info.proto ?? undefined);
      uws.binaryType = "arraybuffer";
      d.uws = uws;
      uws.onopen = () => { for (const m of d.buf ?? []) { try { uws.send(m); } catch {} } d.buf = null; };
      // Downstream: on screen bridges, strip mouse-mode enables so the browser
      // terminal never emits mouse reports (they leak into Claude's prompt as
      // junk through screen). zmx bridges pass the mouse through.
      const filter = { mouse: !!info.mouse };
      d.filter = filter;
      uws.onmessage = (e) => { try { ws.send(filterDownstream(e.data as any, filter) as any); } catch {} };
      uws.onclose = () => { try { ws.close(); } catch {} };
      uws.onerror = () => { try { ws.close(); } catch {} };
    },
    message(ws, message) {
      const d = ws.data as any;
      const uws = d?.uws as WebSocket | undefined;
      if (!uws) return;
      // Upstream: on screen bridges, drop mouse reports that still slip through.
      const m = filterUpstream(message as any, d.filter) as any;
      if (uws.readyState === WebSocket.OPEN) { try { uws.send(m); } catch {} }
      else if (d.buf) d.buf.push(m);
    },
    close(ws) {
      const d = ws.data as any;
      if (d?.term?.id) terminal.markClose(d.term.id);
      try { d?.uws?.close(); } catch {}
    },
  },
});

console.log(`xcloud-sessions listening on http://127.0.0.1:${server.port} (rpID: ${auth.RP_ID})`);

// Live agents survive service restarts; retain their credentials until their launch ends.
setInterval(() => {
  void communicator.prune().catch(() => console.error("Communicator retention cleanup failed."));
  void connectors.prune().catch(() => console.error("Connector retention cleanup failed."));
}, 6 * 60 * 60 * 1000).unref();
