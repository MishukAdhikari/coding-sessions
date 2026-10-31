import { expect, test } from "bun:test";
import {
  handleCodexAuthRoute,
  type CodexAuthRouteDependencies,
} from "./codex-auth-route";

const COOKIE_NAME = "xs_auth";
const BROWSER_TOKEN = "browser-secret";
const CLI_TOKEN = "xcm_cli_secret";

function harness() {
  const calls: string[] = [];
  const checkBrowserSession = (token: string | null) => token === BROWSER_TOKEN;
  const dependencies: CodexAuthRouteDependencies = {
    cookieName: COOKIE_NAME,
    checkBrowserSession,
    isAuthenticated: (request) => {
      const bearer = request.headers.get("authorization");
      if (bearer === `Bearer ${CLI_TOKEN}`) return true;
      return request.headers.get("cookie")?.includes(`${COOKIE_NAME}=${BROWSER_TOKEN}`) === true;
    },
    controller: {
      async start() {
        calls.push("start");
        return { operation: "start" };
      },
      async status() {
        calls.push("status");
        return { operation: "status" };
      },
      async cancel() {
        calls.push("cancel");
        return { operation: "cancel" };
      },
    },
  };
  return { calls, dependencies };
}

function request(path: string, method = "GET", headers: HeadersInit = {}): Request {
  return new Request(`https://example.test${path}`, { method, headers });
}

function expectPrivate(response: Response): void {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("pragma")).toBe("no-cache");
  expect(response.headers.get("content-type")).toBe("application/json");
}

test("Codex auth routes reject unauthenticated and bearer-only requests without calling the controller", async () => {
  const { calls, dependencies } = harness();

  const unauthenticated = await handleCodexAuthRoute(
    request("/api/codex-auth/status"),
    dependencies,
  );
  expect(unauthenticated).not.toBeNull();
  expect(unauthenticated!.status).toBe(401);
  expect(await unauthenticated!.json()).toEqual({ error: "Unauthorized" });
  expectPrivate(unauthenticated!);

  const bearerOnly = await handleCodexAuthRoute(
    request("/api/codex-auth/start", "POST", { authorization: `Bearer ${CLI_TOKEN}` }),
    dependencies,
  );
  expect(bearerOnly).not.toBeNull();
  expect(bearerOnly!.status).toBe(403);
  expect(await bearerOnly!.json()).toEqual({ error: "Web session required." });
  expectPrivate(bearerOnly!);
  expect(calls).toEqual([]);
});

test("browser-authenticated requests reach only the exact Codex auth routes and methods", async () => {
  const { calls, dependencies } = harness();
  const headers = { cookie: `theme=dark; ${COOKIE_NAME}=${BROWSER_TOKEN}` };
  const routes = [
    ["/api/codex-auth/start", "POST", "start"],
    ["/api/codex-auth/status", "GET", "status"],
    ["/api/codex-auth/cancel", "POST", "cancel"],
  ] as const;

  for (const [path, method, operation] of routes) {
    const response = await handleCodexAuthRoute(request(path, method, headers), dependencies);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(200);
    expect(await response!.json()).toEqual({ operation });
    expectPrivate(response!);
  }
  expect(calls).toEqual(["start", "status", "cancel"]);
});

test("unsupported Codex auth paths and methods return private 404 responses", async () => {
  const { calls, dependencies } = harness();
  const headers = { cookie: `${COOKIE_NAME}=${BROWSER_TOKEN}` };
  const requests = [
    request("/api/codex-auth/start", "GET", headers),
    request("/api/codex-auth/status", "POST", headers),
    request("/api/codex-auth/cancel", "GET", headers),
    request("/api/codex-auth/unknown", "POST", headers),
  ];

  for (const candidate of requests) {
    const response = await handleCodexAuthRoute(candidate, dependencies);
    expect(response).not.toBeNull();
    expect(response!.status).toBe(404);
    expect(await response!.json()).toEqual({ error: "Not found" });
    expectPrivate(response!);
  }
  expect(calls).toEqual([]);
});

test("non-Codex-auth paths are left for the main router", async () => {
  const { dependencies } = harness();
  expect(await handleCodexAuthRoute(request("/api/sessions"), dependencies)).toBeNull();
});
