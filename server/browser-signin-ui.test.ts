import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

interface FakeElement {
  hidden: boolean; disabled: boolean; value: string; textContent: string;
  handlers: Record<string, (event?: unknown) => unknown>;
  addEventListener(event: string, fn: (event?: unknown) => unknown): void;
  querySelectorAll(): never[]; focus(): void; classList: { toggle(): void };
}

function load(status: { state: string; message?: string }) {
  const elements = new Map<string, FakeElement>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, value: "", textContent: "", handlers: {},
      addEventListener(event, fn) { this.handlers[event] = fn; },
      querySelectorAll: () => [], focus() {}, classList: { toggle() {} } });
    return elements.get(id)!;
  };
  $("sheet-browser").hidden = false;
  const posts: string[] = [];
  const window: { createAgentAuth?: (dependencies: unknown) => unknown } = {};
  const timers: Array<() => unknown> = [];
  runInNewContext(readFileSync(new URL("../public/agent-auth.js", import.meta.url), "utf8"), {
    window, document: { querySelectorAll: () => [], querySelector: () => null },
    requestAnimationFrame: (fn: () => void) => fn(), setTimeout, clearTimeout,
    setInterval: (fn: () => unknown) => { timers.push(fn); return timers.length; }, clearInterval() {},
  });
  window.createAgentAuth!({ $,
    api: async (path: string, options?: { method: string }) => {
      if (options?.method === "POST") { posts.push(path); return { ok: true }; }
      return path === "/api/browser-auth/status" ? { ...status, queue: {} } : { accounts: [] };
    },
    openSheet() {}, closeSheet() {}, copyText() {}, showToast() {}, codexAuthSupported: () => true,
    commandCodeAuthSupported: () => true, capabilitiesResolved: () => true,
  });
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  const poll = async () => { await timers.at(-1)!(); await settle(); };
  return { $, posts, status, settle, poll };
}

test("once a code is emailed, Submit code is the only primary action", async () => {
  const t = load({ state: "idle" });
  t.$("btn-browser-auth").handlers.click!();
  await t.settle();
  expect(t.$("btn-browser-start").hidden).toBe(false);
  expect(t.$("form-browser-code").hidden).toBe(true);

  t.$("btn-browser-start").handlers.click!();
  t.$("btn-browser-start").handlers.click!(); // a double click must not start twice
  await t.settle();
  expect(t.posts.filter(p => p === "/api/browser-auth/start")).toHaveLength(1);
  expect(t.$("btn-browser-start").hidden).toBe(true);

  t.status.state = "code_sent";
  await t.poll();
  expect(t.$("btn-browser-start").hidden).toBe(true);
  expect(t.$("form-browser-code").hidden).toBe(false);
  expect(t.$("btn-browser-resend").hidden).toBe(false);

  t.$("input-browser-code").value = "297744";
  t.$("form-browser-code").handlers.submit!({ preventDefault() {} });
  await t.settle();
  expect(t.posts).toContain("/api/browser-auth/code");
  expect(t.$("btn-browser-resend").hidden).toBe(true);
  await t.poll(); // still code_sent while the server checks it
  expect(t.$("browser-wait").textContent).toBe("Code sent — signing in…");

  t.status.state = "success";
  await t.poll();
  expect(t.$("btn-browser-start").hidden).toBe(true);
  expect(t.$("form-browser-code").hidden).toBe(true);
  expect(t.$("btn-browser-resend").hidden).toBe(true);
});

test("an error offers a fresh start", async () => {
  const t = load({ state: "error", message: "bad code" });
  t.$("btn-browser-auth").handlers.click!();
  await t.settle();
  expect(t.$("btn-browser-start").hidden).toBe(false);
  expect(t.$("btn-browser-start").textContent).toBe("Try again — email me a code");
  expect(t.$("form-browser-code").hidden).toBe(true);
});
