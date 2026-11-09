import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** The real service worker against a fake cache, network and clock. */
function worker({ network }) {
  const listeners = {};
  const timers = [];
  const shell = { body: "cached shell" };
  const context = {
    self: { addEventListener: (type, fn) => { listeners[type] = fn; }, clients: {} },
    location: { origin: "https://cs.example" },
    URL,
    fetch: network,
    caches: {
      match: async (req) => (req === "/" || req.url?.endsWith("/") ? shell : null),
      open: async () => ({ put() {} }),
    },
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (n) => { timers[n - 1] = null; },
    Response: { error: () => ({ error: true }) },
  };
  runInNewContext(readFileSync(new URL("../public/sw.js", import.meta.url), "utf8"), context);
  const request = (path, init = {}) => {
    let answered = null;
    listeners.fetch({ request: { url: `https://cs.example${path}`, method: "GET", mode: "cors", ...init }, respondWith: (p) => { answered = p; } });
    return answered;
  };
  return { request, shell, fire: () => timers.splice(0).forEach((fn) => fn?.()) };
}

test("the API, passkey ceremonies included, never goes through the service worker", () => {
  const sw = worker({ network: () => new Promise(() => {}) });
  expect(sw.request("/api/auth/login/options")).toBeNull();
  expect(sw.request("/api/auth/login/verify", { method: "POST" })).toBeNull();
  expect(sw.request("/api/auth/register/options")).toBeNull();
  expect(sw.request("/api/sessions")).toBeNull();
  expect(sw.request("/term/abcd1234/")).toBeNull();
});

test("a page load that hangs gets the cached shell instead of a blank screen", async () => {
  const sw = worker({ network: () => new Promise(() => {}) });
  const answer = sw.request("/", { mode: "navigate" });
  expect(answer).not.toBeNull();
  sw.fire();
  expect(await answer).toBe(sw.shell);
});

test("a page load that answers in time is the network's answer", async () => {
  const fresh = { ok: true, clone: () => ({}) };
  const sw = worker({ network: async () => fresh });
  const answer = sw.request("/chat.html?id=m%3Acs-demo", { mode: "navigate" });
  expect(await answer).toBe(fresh);
});

test("offline, a page load falls back to the cached shell at once", async () => {
  const sw = worker({ network: async () => { throw new TypeError("Load failed"); } });
  expect(await sw.request("/", { mode: "navigate" })).toBe(sw.shell);
});
