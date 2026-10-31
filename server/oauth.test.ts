import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { applyDatabaseSchema } from "./db-schema";
import * as oauth from "./oauth";
import { handleOAuthRoute, type OAuthRouteDeps } from "./oauth-route";

const ORIGIN = "https://sessions.example";
const VERIFIER = "v".repeat(43) + "-verifier";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");

function fresh() {
  const db = new Database(":memory:");
  applyDatabaseSchema(db);
  return db;
}

function deps(db: Database, signedIn = true): OAuthRouteDeps {
  return {
    db,
    origin: ORIGIN,
    cookieName: "xs_auth",
    checkBrowserSession: (t) => signedIn && t === "good",
    hasPasskey: () => true,
    rateLimited: () => false,
    clientIp: () => "1.2.3.4",
  };
}

const cookie = { cookie: "xs_auth=good" };

test("redirect URIs: claude.ai, claude.com and loopback only", () => {
  expect(oauth.redirectUriAllowed("https://claude.ai/api/mcp/auth_callback", [])).toBe(true);
  expect(oauth.redirectUriAllowed("https://claude.com/api/mcp/auth_callback", [])).toBe(true);
  expect(oauth.redirectUriAllowed("http://localhost:33418/callback", [])).toBe(true);
  expect(oauth.redirectUriAllowed("http://127.0.0.1:5555/callback", [])).toBe(true);
  expect(oauth.redirectUriAllowed("https://evil.example/cb", [])).toBe(false);
  expect(oauth.redirectUriAllowed("https://claude.ai.evil.example/cb", [])).toBe(false);
  expect(oauth.redirectUriAllowed("http://claude.ai/cb", [])).toBe(false);
  expect(oauth.redirectUriAllowed("https://chatgpt.com/cb", ["chatgpt.com"])).toBe(true);
});

test("loopback redirect may change port, nothing else", () => {
  const reg = ["http://localhost:1000/callback"];
  expect(oauth.redirectUriMatches("http://localhost:2000/callback", reg)).toBe(true);
  expect(oauth.redirectUriMatches("http://localhost:2000/other", reg)).toBe(false);
  expect(oauth.redirectUriMatches("http://127.0.0.1:2000/callback", reg)).toBe(false);
  expect(oauth.redirectUriMatches("https://claude.ai/x", ["https://claude.ai/y"])).toBe(false);
});

test("registration refuses a foreign redirect", () => {
  const db = fresh();
  const r = oauth.registerClient(db, { client_name: "x", redirect_uris: ["https://evil.example/cb"] });
  expect(r.ok).toBe(false);
});

test("full flow: register → consent → code → tokens → refresh rotates", async () => {
  const db = fresh();
  const reg = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/register`, {
    method: "POST",
    body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] }),
  }), deps(db));
  expect(reg!.status).toBe(201);
  const { client_id } = await reg!.json() as { client_id: string };

  const q = new URLSearchParams({
    client_id, response_type: "code", redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "st8", resource: `${ORIGIN}/mcp`,
  });

  // Not signed in: the sign-in page, never a code.
  const anon = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize?${q}`), deps(db, false));
  expect(await anon!.text()).toContain("data-oauth-signin");

  // Signed in: the consent page names the client.
  const consent = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize?${q}`, { headers: cookie }), deps(db));
  expect(await consent!.text()).toContain("Allow Claude?");

  // A post from another origin is refused.
  const foreign = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST", headers: { ...cookie, origin: "https://evil.example" }, body: `${q}&decision=allow`,
  }), deps(db));
  expect(foreign!.status).toBe(403);

  const allow = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST", headers: { ...cookie, origin: ORIGIN }, body: `${q}&decision=allow`,
  }), deps(db));
  expect(allow!.status).toBe(303);
  const back = new URL(allow!.headers.get("location")!);
  expect(back.origin + back.pathname).toBe("https://claude.ai/api/mcp/auth_callback");
  expect(back.searchParams.get("state")).toBe("st8");
  const code = back.searchParams.get("code")!;

  // Wrong verifier fails — and burns the code.
  const bad = oauth.exchangeToken(db, new URLSearchParams({ grant_type: "authorization_code", code, client_id, code_verifier: "w".repeat(43) }));
  expect(bad.ok).toBe(false);
  const reused = oauth.exchangeToken(db, new URLSearchParams({ grant_type: "authorization_code", code, client_id, code_verifier: VERIFIER }));
  expect(reused.ok).toBe(false);

  // A fresh code with the right verifier works.
  const check = oauth.checkAuthorize(db, q);
  if (!check.ok) throw new Error("authorize check failed");
  const code2 = oauth.issueCode(db, check.request);
  const tok = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: code2, client_id, code_verifier: VERIFIER, redirect_uri: "https://claude.ai/api/mcp/auth_callback" }).toString(),
  }), deps(db));
  expect(tok!.status).toBe(200);
  const pair = await tok!.json() as oauth.TokenResponse;
  expect(oauth.checkAccessToken(db, pair.access_token)).toBe(true);
  expect(oauth.checkAccessToken(db, pair.refresh_token)).toBe(false);

  const refreshed = oauth.exchangeToken(db, new URLSearchParams({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id }));
  expect(refreshed.ok).toBe(true);
  const again = oauth.exchangeToken(db, new URLSearchParams({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id }));
  expect(again.ok).toBe(false); // rotated

  expect(oauth.listConnections(db).map((c) => c.client_id)).toEqual([client_id]);
  oauth.revokeClient(db, client_id);
  if (refreshed.ok) expect(oauth.checkAccessToken(db, refreshed.body.access_token)).toBe(false);
});

test("the consent page keeps Origin on its own post", async () => {
  // Under referrer policy no-referrer a browser sends `Origin: null` on a form post,
  // and the Allow button would be refused as cross-site (seen on iOS, 2026-10-14).
  const db = fresh();
  const reg = oauth.registerClient(db, { redirect_uris: ["https://claude.ai/api/mcp/auth_callback"] });
  if (!reg.ok) throw new Error("register failed");
  const q = new URLSearchParams({
    client_id: reg.client.client_id, response_type: "code", redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    code_challenge: CHALLENGE, code_challenge_method: "S256",
  });
  const html = await (await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize?${q}`, { headers: cookie }), deps(db)))!.text();
  expect(html).toContain('content="same-origin"');
  expect(html).not.toContain("no-referrer");
});

test("deny sends access_denied back", async () => {
  const db = fresh();
  const reg = oauth.registerClient(db, { redirect_uris: ["http://localhost:9/callback"] });
  if (!reg.ok) throw new Error("register failed");
  const q = new URLSearchParams({
    client_id: reg.client.client_id, response_type: "code", redirect_uri: "http://localhost:4444/callback",
    code_challenge: CHALLENGE, code_challenge_method: "S256", state: "s",
  });
  const r = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize`, {
    method: "POST", headers: cookie, body: `${q}&decision=deny`,
  }), deps(db));
  const loc = new URL(r!.headers.get("location")!);
  expect(loc.port).toBe("4444");
  expect(loc.searchParams.get("error")).toBe("access_denied");
});

test("authorize without PKCE is refused at the client", async () => {
  const db = fresh();
  const reg = oauth.registerClient(db, { redirect_uris: ["https://claude.ai/cb"] });
  if (!reg.ok) throw new Error("register failed");
  const q = new URLSearchParams({ client_id: reg.client.client_id, response_type: "code", redirect_uri: "https://claude.ai/cb" });
  const r = await handleOAuthRoute(new Request(`${ORIGIN}/oauth/authorize?${q}`, { headers: cookie }), deps(db));
  expect(r!.status).toBe(302);
  expect(new URL(r!.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
});

test("discovery documents point at this origin", async () => {
  const db = fresh();
  const pr = await handleOAuthRoute(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), deps(db));
  expect((await pr!.json() as any).resource).toBe(`${ORIGIN}/mcp`);
  const as = await handleOAuthRoute(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), deps(db));
  expect((await as!.json() as any).token_endpoint).toBe(`${ORIGIN}/oauth/token`);
  expect(await handleOAuthRoute(new Request(`${ORIGIN}/api/me`), deps(db))).toBeNull();
});
