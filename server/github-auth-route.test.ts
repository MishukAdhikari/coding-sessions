import { expect, test } from "bun:test";
import {
  handleGithubAuthRoute,
  type GithubAuthRouteDependencies,
} from "./github-auth-route";
import { isPlausibleGithubToken } from "./github-auth";

const COOKIE_NAME = "xs_auth";
const BROWSER_TOKEN = "browser-secret";
const CLI_TOKEN = "xcm_cli_secret";

function harness() {
  const calls: Array<string | [string, string]> = [];
  const dependencies: GithubAuthRouteDependencies = {
    cookieName: COOKIE_NAME,
    checkBrowserSession: (token) => token === BROWSER_TOKEN,
    isAuthenticated: (request) => {
      const bearer = request.headers.get("authorization");
      if (bearer === `Bearer ${CLI_TOKEN}`) return true;
      return request.headers.get("cookie")?.includes(`${COOKIE_NAME}=${BROWSER_TOKEN}`) === true;
    },
    controller: {
      async status() {
        calls.push("status");
        return { installed: true, authenticated: false, account: null };
      },
      async saveToken(token: string) {
        calls.push(["saveToken", token]);
        return token === "good" ? { ok: true, account: "someone" } : { ok: false, error: "bad token" };
      },
      async logout() {
        calls.push("logout");
        return { ok: true };
      },
    },
  };
  return { calls, dependencies };
}

function request(path: string, method = "GET", headers: HeadersInit = {}, body?: unknown): Request {
  return new Request(`https://example.test${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-type")).toBe("application/json");
}

test("GitHub auth routes reject unauthenticated and bearer-only requests without calling the controller", async () => {
  const { calls, dependencies } = harness();

  const unauthenticated = await handleGithubAuthRoute(request("/api/github-auth/status"), dependencies);
  expect(unauthenticated!.status).toBe(401);
  expect(await unauthenticated!.json()).toEqual({ error: "Unauthorized" });
  expectPrivate(unauthenticated!);

  const bearerOnly = await handleGithubAuthRoute(
    request("/api/github-auth/token", "POST", { authorization: `Bearer ${CLI_TOKEN}` }, { token: "good" }),
    dependencies,
  );
  expect(bearerOnly!.status).toBe(403);
  expect(await bearerOnly!.json()).toEqual({ error: "Web session required." });
  expectPrivate(bearerOnly!);
  expect(calls).toEqual([]);
});

test("browser-authenticated requests reach status, token save, and logout", async () => {
  const { calls, dependencies } = harness();
  const headers = { cookie: `theme=dark; ${COOKIE_NAME}=${BROWSER_TOKEN}` };

  const status = await handleGithubAuthRoute(request("/api/github-auth/status", "GET", headers), dependencies);
  expect(status!.status).toBe(200);
  expect(await status!.json()).toEqual({ installed: true, authenticated: false, account: null });

  const good = await handleGithubAuthRoute(
    request("/api/github-auth/token", "POST", headers, { token: "  good  " }),
    dependencies,
  );
  expect(good!.status).toBe(200);
  expect(await good!.json()).toEqual({ ok: true, account: "someone" });

  const bad = await handleGithubAuthRoute(
    request("/api/github-auth/token", "POST", headers, { token: "nope" }),
    dependencies,
  );
  expect(bad!.status).toBe(400);
  expect(await bad!.json()).toEqual({ ok: false, error: "bad token" });

  const logout = await handleGithubAuthRoute(request("/api/github-auth/logout", "POST", headers), dependencies);
  expect(logout!.status).toBe(200);

  // tokens are trimmed before they reach the controller; malformed bodies become ""
  expect(calls).toEqual(["status", ["saveToken", "good"], ["saveToken", "nope"], "logout"]);
});

test("unsupported GitHub auth paths and methods return private 404 responses", async () => {
  const { calls, dependencies } = harness();
  const headers = { cookie: `${COOKIE_NAME}=${BROWSER_TOKEN}` };
  for (const candidate of [
    request("/api/github-auth/token", "GET", headers),
    request("/api/github-auth/status", "POST", headers),
    request("/api/github-auth/unknown", "POST", headers),
  ]) {
    const response = await handleGithubAuthRoute(candidate, dependencies);
    expect(response!.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "Not found" });
  }
  expect(calls).toEqual([]);
});

test("non-GitHub-auth paths are left for the main router", async () => {
  const { dependencies } = harness();
  expect(await handleGithubAuthRoute(request("/api/sessions"), dependencies)).toBeNull();
});

test("token shape validation accepts real GitHub token formats and rejects junk", () => {
  expect(isPlausibleGithubToken("ghp_" + "a".repeat(36))).toBe(true);
  expect(isPlausibleGithubToken("gho_" + "B".repeat(20))).toBe(true);
  expect(isPlausibleGithubToken("github_pat_" + "c".repeat(60))).toBe(true);
  expect(isPlausibleGithubToken("0123456789abcdef0123456789abcdef01234567")).toBe(true);
  expect(isPlausibleGithubToken("")).toBe(false);
  expect(isPlausibleGithubToken("hello world")).toBe(false);
  expect(isPlausibleGithubToken("ghp_short")).toBe(false);
  expect(isPlausibleGithubToken("token with spaces ghp_aaaaaaaaaaaaaaaaaaaa")).toBe(false);
});
