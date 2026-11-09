import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// app.js's boot and offline screen, run against a scripted /api/me.
const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const bootCode = source.slice(source.indexOf("  let booting = false;"), source.indexOf("  /* ---------- login ---------- */"));

function harness(answer) {
  const els = {};
  const el = (id) => (els[id] ??= { id, hidden: true, disabled: false, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } });
  const timers = [];
  const calls = [];
  const context = {
    $: el, me: null, setupToken: null,
    api: (path, opts) => { calls.push({ path, signal: opts?.signal }); return answer(opts?.signal); },
    enterApp() { el("app").hidden = false; },
    showLogin() { el("login").hidden = false; },
    openSheet() {}, loginError() {},
    AbortController,
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].fn = null; },
  };
  runInNewContext(`${bootCode}; this.boot = boot;`, context);
  return { context, el, calls, fireTimers: () => timers.splice(0).forEach((t) => t.fn?.()) };
}

test("a failed first request shows the offline screen, and Try again recovers", async () => {
  let up = false;
  const h = harness(async () => { if (!up) throw new TypeError("Load failed"); return { authed: true }; });
  await h.context.boot();
  expect(h.el("offline").hidden).toBe(false);
  expect(h.el("btn-retry").disabled).toBe(false);
  up = true;
  await h.el("btn-retry").listeners.click();
  expect(h.el("offline").hidden).toBe(true);
  expect(h.el("app").hidden).toBe(false);
});

test("a request that hangs is cut off and still reaches the offline screen", async () => {
  const h = harness((signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
  const booting = h.context.boot();
  expect(h.el("btn-retry").disabled).toBe(true);
  h.fireTimers(); // the boot timeout elapses
  await booting;
  expect(h.el("offline").hidden).toBe(false);
});

test("a second boot while one is in flight does nothing", async () => {
  let release;
  const h = harness(() => new Promise((resolve) => { release = resolve; }));
  const first = h.context.boot();
  await h.context.boot();
  expect(h.calls).toHaveLength(1);
  release({ authed: false });
  await first;
  expect(h.el("login").hidden).toBe(false);
});

test("once the app is running, a failed boot leaves the list in place", async () => {
  const h = harness(async () => { throw new TypeError("Load failed"); });
  h.el("app").hidden = false;
  await h.context.boot();
  expect(h.el("offline").hidden).toBe(true);
});
