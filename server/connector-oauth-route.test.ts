import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import { createSecretCodec } from "./secrets";
import { Connectors } from "./connectors";
import { ConnectorOAuth } from "./connector-oauth";
import { handleConnectorOAuthPublic } from "./connector-oauth-route";
import { handleConnectorsRoute } from "./connectors-route";

const ORIGIN = "https://sessions.example.com";
function fixture() {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const key = randomBytes(32);
  const connectors = new Connectors({ database, isLive: async () => true, env: { CS_CONNECTOR_ALLOW_LOOPBACK: "1" }, codec: () => createSecretCodec(key) });
  const oauth = new ConnectorOAuth({ connectors, origin: ORIGIN });
  const deps = { cookieName: "xs_auth", origin: ORIGIN, checkBrowserSession: (t: string | null) => t === "browser-a" || t === "browser-b", isAuthenticated: () => true, connectors, oauth };
  return { connectors, oauth, deps };
}

test("the CIMD document is public, exact-path, JSON and secret-free", async () => {
  const f = fixture();
  const response = handleConnectorOAuthPublic(new Request(`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`), { oauth: f.oauth })!;
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(await response.json()).toEqual(f.oauth.clientMetadata());
  expect(handleConnectorOAuthPublic(new Request(`${ORIGIN}/.well-known/oauth-client/other.json`), { oauth: f.oauth })).toBeNull();
  expect(handleConnectorOAuthPublic(new Request(`${ORIGIN}/.well-known/oauth-client/coding-sessions.json`, { method: "POST" }), { oauth: f.oauth })!.status).toBe(405);
});

test("the callback landing is inert: no cookie needed, no-store, no-referrer, strict CSP, and it never echoes the code", async () => {
  const f = fixture();
  const response = handleConnectorOAuthPublic(new Request(`${ORIGIN}/oauth/connectors/callback?code=SECRET_CODE_1&state=STATE_1&iss=x`), { oauth: f.oauth })!;
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toContain("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const csp = response.headers.get("content-security-policy")!;
  for (const part of ["default-src 'none'", "script-src 'self'", "connect-src 'self'", "frame-ancestors 'none'", "form-action 'none'", "base-uri 'none'"]) expect(csp).toContain(part);
  const html = await response.text();
  expect(html).not.toContain("SECRET_CODE_1");
  expect(html).not.toContain("STATE_1");
  expect(html).toContain('src="/connector-oauth-callback.js');
  expect(html).not.toMatch(/https?:\/\//);
  expect(handleConnectorOAuthPublic(new Request(`${ORIGIN}/oauth/connectors/callback`, { method: "POST" }), { oauth: f.oauth })!.status).toBe(405);
});

test("completion requires the exact Origin and a live browser session; CLI tokens and state alone are refused", async () => {
  const f = fixture();
  const post = (headers: Record<string, string>, body: unknown = { state: "x".repeat(43), code: "c" }) =>
    handleConnectorsRoute(new Request(`${ORIGIN}/api/connectors/oauth/complete`, { method: "POST", headers, body: JSON.stringify(body) }), f.deps);
  expect((await post({ authorization: "Bearer cli-token" }))!.status).toBe(403);
  expect((await post({ cookie: "xs_auth=browser-a" }))!.status).toBe(403);
  expect((await post({ cookie: "xs_auth=browser-a", origin: "null" }))!.status).toBe(403);
  expect((await post({ cookie: "xs_auth=browser-a", origin: "https://evil.example" }))!.status).toBe(403);
  // A cookie that is not a live session is refused by the existing browser-session guard.
  expect((await post({ cookie: "xs_auth=expired", origin: ORIGIN }))!.status).toBe(403);
  // Right browser and origin but an unknown state: refused without detail.
  const unknown = await post({ cookie: "xs_auth=browser-a", origin: ORIGIN });
  expect(unknown!.status).toBe(400);
  expect(((await unknown!.json()) as { error: string }).error).toMatch(/no longer valid/);
  expect((await post({ cookie: "xs_auth=browser-a", origin: ORIGIN }, "not-json"))!.status).toBe(400);
});

test("starting sign-in and setting a preregistered client are browser-session only and never echo the secret", async () => {
  const f = fixture();
  const { id } = await f.connectors.add({ name: "Files", url: "http://127.0.0.1:9/mcp" });
  const req = (path: string, body: unknown, headers: Record<string, string> = { cookie: "xs_auth=browser-a", origin: ORIGIN }) =>
    handleConnectorsRoute(new Request(`${ORIGIN}/api/connectors/${id}/${path}`, { method: "POST", headers, body: JSON.stringify(body) }), f.deps);
  expect((await req("auth", { mode: "oauth" }, { authorization: "Bearer cli" }))!.status).toBe(403);
  expect(((await (await req("auth", { mode: "oauth" }))!.json()) as any).connector.auth.mode).toBe("oauth");
  const client = await req("oauth-client", { client_id: "prereg", client_secret: "prereg-secret-CANARY-77" });
  const text = await client!.text();
  expect(client!.status).toBe(200);
  expect(text).not.toContain("prereg-secret-CANARY-77");
  expect(JSON.parse(text).connector.oauth_client).toEqual({ client_id: "prereg", secret_set: true, issuer: null });
  // Starting against an unreachable server fails cleanly as JSON, not a 500.
  const start = await req("oauth/start", {});
  expect([400, 503]).toContain(start!.status);
});

test("disconnect is browser-session only and reports the remote revocation result", async () => {
  const f = fixture();
  const { id } = await f.connectors.add({ name: "Files", url: "http://127.0.0.1:9/mcp" });
  f.connectors.setAuthMode(id, "oauth");
  const req = (headers: Record<string, string>) => handleConnectorsRoute(new Request(`${ORIGIN}/api/connectors/${id}/oauth/disconnect`, { method: "POST", headers, body: "{}" }), f.deps);
  expect((await req({ authorization: "Bearer cli" }))!.status).toBe(403);
  const response = await req({ cookie: "xs_auth=browser-a", origin: ORIGIN });
  expect(response!.status).toBe(200);
  const body = await response!.json() as any;
  expect(body.revocation).toBe("none");
  expect(body.connector.auth.oauth.state).toBe("disconnected");
});
