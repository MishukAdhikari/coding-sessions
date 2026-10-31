import { expect, test } from "bun:test";
import { hasBrowserSession, PRIVATE_NO_STORE_HEADERS } from "./browser-session";

test("machine-credential routes require the browser cookie and reject bearer-only callers", () => {
  const valid = (token: string | null) => token === "browser-secret";
  const bearerOnly = new Request("https://example.test/api/codex-auth/status", {
    headers: { authorization: "Bearer xcm_cli_secret" },
  });
  const browser = new Request("https://example.test/api/codex-auth/status", {
    headers: { cookie: "theme=dark; xs_auth=browser-secret", authorization: "Bearer ignored" },
  });
  const wrongCookie = new Request("https://example.test/api/codex-auth/status", {
    headers: { cookie: "xs_auth=wrong" },
  });

  expect(hasBrowserSession(bearerOnly, "xs_auth", valid)).toBe(false);
  expect(hasBrowserSession(browser, "xs_auth", valid)).toBe(true);
  expect(hasBrowserSession(wrongCookie, "xs_auth", valid)).toBe(false);
});

test("machine-credential responses are explicitly private and non-cacheable", () => {
  expect(PRIVATE_NO_STORE_HEADERS).toEqual({
    "cache-control": "private, no-store",
    pragma: "no-cache",
  });
});
