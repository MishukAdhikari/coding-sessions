import type { ConnectorOAuth } from "./connector-oauth";

/**
 * The two public, unauthenticated paths of outbound OAuth. Neither can change anything:
 * - the CIMD document describing this instance as an OAuth client (no secrets), and
 * - the callback landing. The provider redirects here cross-site, so the SameSite=Strict app
 *   cookie is not sent; the page only moves code/state out of the URL and posts them same-origin
 *   (where the cookie and Origin are checked) to /api/connectors/oauth/complete.
 */
export const CALLBACK_PATH = "/oauth/connectors/callback";
export const CLIENT_METADATA_PATH = "/.well-known/oauth-client/coding-sessions.json";

const LANDING = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>Finishing sign-in · Coding Sessions</title>
<script src="/theme.js"></script>
<link rel="stylesheet" href="/tokens.css">
<link rel="stylesheet" href="/connector-oauth-callback.css">
<script src="/connector-oauth-callback.js" defer></script>
</head>
<body>
<main class="callback" aria-live="polite">
<p class="callback-eyebrow">External MCP connector</p>
<h1 id="title">Finishing sign-in…</h1>
<p id="detail">Keep this page open.</p>
<a id="back" class="callback-action" href="/?settings=connectors" hidden>Back to connector settings</a>
</main>
</body>
</html>`;

export function handleConnectorOAuthPublic(request: Request, deps: { oauth: ConnectorOAuth }): Response | null {
  const path = new URL(request.url).pathname;
  if (path !== CLIENT_METADATA_PATH && path !== CALLBACK_PATH) return null;
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method Not Allowed", { status: 405, headers: { allow: "GET" } });
  if (path === CLIENT_METADATA_PATH) {
    return Response.json(deps.oauth.clientMetadata(), { headers: { "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" } });
  }
  return new Response(LANDING, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      pragma: "no-cache",
      "referrer-policy": "no-referrer",
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      // Same-origin script, styles and fonts only; nothing third-party, no inline code.
      "content-security-policy": "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'self'; font-src 'self'; img-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'",
    },
  });
}
