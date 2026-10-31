/**
 * HTTP side of the MCP connector's OAuth (logic in oauth.ts): discovery documents,
 * client registration, the sign-in and consent page, and the token endpoint.
 *
 * The consent page is the one human step. It needs the app's own browser session —
 * the same passkey or password as the web app — and the cookie is SameSite=Strict,
 * so the Allow form can only be posted from this origin. Arriving from claude.ai the
 * cookie isn't sent yet; the page signs in and reloads, and then it is.
 */
import type { Database } from "bun:sqlite";
import * as oauth from "./oauth";
import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";

export interface OAuthRouteDeps {
  db: Database;
  origin: string;
  cookieName: string;
  checkBrowserSession: (token: string | null) => boolean;
  hasPasskey: () => boolean;
  rateLimited: (key: string, max?: number) => boolean;
  clientIp: (req: Request) => string;
}

const noStoreJson = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { ...PRIVATE_NO_STORE_HEADERS } });

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function page(title: string, body: string, status = 200): Response {
  return new Response(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="referrer" content="same-origin">
<title>${esc(title)} · xCloud Sessions</title>
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app.css?v=28">
<script src="/vendor/webauthn.js"></script>
<script src="/oauth.js" defer></script>
</head>
<body>
<section id="login" class="screen">
  <div class="login-wrap">
    <div class="wordmark"><div class="wordmark-halo"></div><div class="wordmark-dot"></div></div>
    ${body}
  </div>
</section>
</body>
</html>`, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...PRIVATE_NO_STORE_HEADERS,
      // Nobody may frame the consent page and click Allow through it.
      "x-frame-options": "DENY",
      "content-security-policy": "frame-ancestors 'none'",
    },
  });
}

function errorPage(message: string, status = 400): Response {
  return page("Can't connect", `
    <h1 class="login-title">Can't connect</h1>
    <p class="login-sub">${esc(message)}</p>`, status);
}

function signInPage(hasPasskey: boolean): Response {
  return page("Sign in", `
    <h1 class="login-title">Sign in to connect</h1>
    <p class="login-sub">An app wants to use your sessions. Sign in first, then choose whether to allow it.</p>
    <div class="login-actions" data-oauth-signin data-has-passkey="${hasPasskey ? "1" : "0"}">
      <button id="btn-passkey" class="btn btn-primary" type="button" hidden>Unlock</button>
      <form id="form-password" hidden>
        <input id="input-password" class="field" type="password" autocomplete="current-password" placeholder="Admin password" required>
        <button class="btn btn-primary" type="submit">Sign in</button>
      </form>
      <button id="btn-use-password" class="btn-link" type="button" hidden>Use password instead</button>
    </div>
    <p id="login-error" class="login-error" hidden></p>`);
}

const AUTHORIZE_FIELDS = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"];

function consentPage(params: URLSearchParams, req: oauth.AuthorizeRequest): Response {
  const hidden = AUTHORIZE_FIELDS
    .filter((k) => params.get(k) != null)
    .map((k) => `<input type="hidden" name="${k}" value="${esc(params.get(k)!)}">`).join("\n      ");
  const dest = new URL(req.redirectUri);
  const where = dest.protocol === "http:" ? "a program on your own computer" : dest.host;
  return page("Allow access", `
    <h1 class="login-title">Allow ${esc(req.client.name)}?</h1>
    <p class="login-sub">It will be able to list, launch, read, type into and end the coding sessions on this server. Sessions run with permissions skipped.</p>
    <p class="login-sub">Sign-in goes back to <strong>${esc(where)}</strong>.</p>
    <form class="login-actions" method="post" action="/oauth/authorize">
      ${hidden}
      <button class="btn btn-primary" name="decision" value="allow" type="submit">Allow</button>
      <button class="btn-link" name="decision" value="deny" type="submit">Deny</button>
    </form>`);
}

/** Handle the connector's OAuth and discovery routes; null for any other path. */
export async function handleOAuthRoute(req: Request, deps: OAuthRouteDeps): Promise<Response | null> {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  /* ----- discovery (RFC 8414, RFC 9728). Clients probe the path-suffixed forms too. ----- */
  if (method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp"
    || path === "/.well-known/openid-configuration" || path === "/.well-known/openid-configuration/mcp")) {
    return Response.json(oauth.authorizationServerMetadata(deps.origin));
  }
  if (method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return Response.json(oauth.protectedResourceMetadata(deps.origin));
  }

  /* ----- dynamic client registration ----- */
  if (path === "/oauth/register" && method === "POST") {
    if (deps.rateLimited(`oreg:${deps.clientIp(req)}`, 20)) return noStoreJson({ error: "slow_down" }, 429);
    const body = await req.json().catch(() => null);
    const r = oauth.registerClient(deps.db, body);
    if (!r.ok) return noStoreJson({ error: r.error, error_description: r.description }, 400);
    return noStoreJson({
      client_id: r.client.client_id,
      client_id_issued_at: Math.floor(r.client.created_at / 1000),
      client_name: r.client.name,
      redirect_uris: r.client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }, 201);
  }

  /* ----- token endpoint ----- */
  if (path === "/oauth/token" && method === "POST") {
    if (deps.rateLimited(`otok:${deps.clientIp(req)}`, 60)) return noStoreJson({ error: "slow_down" }, 429);
    const type = req.headers.get("content-type") ?? "";
    const form = type.includes("application/json")
      ? new URLSearchParams(Object.entries(await req.json().catch(() => ({})) as Record<string, unknown>)
          .map(([k, v]): [string, string] => [k, String(v)]))
      : new URLSearchParams(await req.text());
    const r = oauth.exchangeToken(deps.db, form);
    return r.ok ? noStoreJson(r.body) : noStoreJson({ error: r.error, error_description: r.description }, r.status);
  }

  /* ----- authorization: sign in, then Allow or Deny ----- */
  if (path === "/oauth/authorize" && (method === "GET" || method === "POST")) {
    const signedIn = hasBrowserSession(req, deps.cookieName, deps.checkBrowserSession);
    let params = url.searchParams;
    if (method === "POST") {
      // SameSite=Strict already keeps the cookie off a cross-site post; refuse a
      // foreign Origin outright as well. The page's referrer policy must not be
      // no-referrer: under it a browser sends `Origin: null` on this very post.
      const from = req.headers.get("origin");
      if (from && from !== deps.origin) return errorPage("This form can only be sent from this site.", 403);
      if (!signedIn) return errorPage("Your sign-in expired. Go back to the app and connect again.", 401);
      params = new URLSearchParams(await req.text());
    }

    const check = oauth.checkAuthorize(deps.db, params);
    if (!check.ok) {
      if (check.fatal) return errorPage(check.message);
      return Response.redirect(oauth.redirectWith(check.redirectUri, {
        error: check.error, error_description: check.description, state: check.state, iss: deps.origin,
      }), 302);
    }

    if (method === "GET") return signedIn ? consentPage(params, check.request) : signInPage(deps.hasPasskey());

    const decision = params.get("decision");
    const target = decision === "allow"
      ? oauth.redirectWith(check.request.redirectUri, { code: oauth.issueCode(deps.db, check.request), state: check.request.state, iss: deps.origin })
      : oauth.redirectWith(check.request.redirectUri, { error: "access_denied", state: check.request.state, iss: deps.origin });
    return new Response(null, { status: 303, headers: { location: target, ...PRIVATE_NO_STORE_HEADERS } });
  }

  return null;
}

/** The 401 /mcp answers without a token: where to find the authorization server. */
export function mcpUnauthorized(origin: string): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } },
    { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` } },
  );
}
