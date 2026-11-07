import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/chat.js", import.meta.url), "utf8");

/** Just enough DOM for chat.js: elements by id, created elements and their text. */
function element(tag) {
  const el = {
    tag, hidden: false, className: "", title: "", value: "", disabled: false, style: {}, dataset: {},
    children: [], listeners: {}, scrollTop: 0, scrollHeight: 0, clientHeight: 0,
    append(...nodes) { this.children.push(...nodes); },
    replaceChildren(...nodes) { this.children = nodes; },
    remove() { this.removed = true; },
    addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); },
  };
  let text = "";
  Object.defineProperty(el, "textContent", { get: () => text, set: (v) => { text = String(v); } });
  Object.defineProperty(el, "innerHTML", { get: () => "", set: () => { throw new Error("innerHTML must not be used"); } });
  return el;
}

function harness(responses, id = "m:cs-demo") {
  const byId = new Map();
  const get = (name) => { if (!byId.has(name)) byId.set(name, element("div")); return byId.get(name); };
  const live = element("span");
  const timers = [];
  const requests = [];
  const document = {
    title: "", hidden: false, body: element("body"),
    getElementById: get,
    querySelector: () => live,
    createElement: element,
    addEventListener() {},
  };
  const fetch = async (url, options = {}) => {
    requests.push({ url, options });
    const next = responses.shift() ?? { status: 200, body: { messages: [], cursor: 0, state: "unknown" } };
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  const context = {
    document, fetch, URLSearchParams, Number, Set, String, Date, Math, encodeURIComponent,
    location: { search: `?id=${encodeURIComponent(id)}&name=demo`, href: "" },
    window: { open: () => null, close() {}, closed: false, addEventListener() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
  };
  runInNewContext(source, context);
  return { get, timers, requests, live, document };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("chat.js never writes markup", () => {
  expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
});

test("transcript text lands as text, even when it looks like HTML", async () => {
  const h = harness([{ status: 200, body: {
    cursor: 120, state: "waiting",
    messages: [
      { id: "0:0", role: "user", text: "<img src=x onerror=alert(1)>", at: "2026-11-07T12:00:00Z" },
      { id: "50:0", role: "assistant", text: "<script>steal()</script>", at: null },
      { id: "50:1", role: "tool", text: "Bash ls", at: null },
    ],
  } }]);
  await settle();
  const rows = h.get("chat-list").children;
  expect(rows.map((r) => r.className)).toEqual(["chat-msg chat-user", "chat-msg chat-assistant", "chat-msg chat-tool"]);
  expect(rows[0].children[0].textContent).toBe("<img src=x onerror=alert(1)>");
  expect(rows[1].children[0].textContent).toBe("<script>steal()</script>");
  expect(h.get("chat-state").textContent).toBe("Your turn");
  expect(h.get("chat-banner").hidden).toBe(true);
});

test("polls with the cursor and does not repeat messages it already shows", async () => {
  const msg = { id: "0:0", role: "assistant", text: "hi", at: null };
  const h = harness([
    { status: 200, body: { cursor: 10, state: "working", messages: [msg] } },
    { status: 200, body: { cursor: 10, state: "asking", messages: [msg] } },
  ]);
  await settle();
  expect(h.timers.at(-1).ms).toBe(2000);
  await h.timers.at(-1).fn();
  expect(h.requests[1].url).toBe("/api/sessions/m%3Acs-demo/transcript?after=10");
  expect(h.get("chat-list").children.length).toBe(1);
  expect(h.get("chat-banner").hidden).toBe(false);
  expect(h.get("chat-state").textContent).toBe("Waiting on you");
});

test("a reset replaces the shown messages", async () => {
  const h = harness([
    { status: 200, body: { cursor: 10, state: "waiting", messages: [{ id: "0:0", role: "user", text: "old", at: null }] } },
    { status: 200, body: { cursor: 5, reset: true, state: "waiting", messages: [{ id: "0:0", role: "user", text: "new", at: null }] } },
  ]);
  await settle();
  await h.timers.at(-1).fn();
  const rows = h.get("chat-list").children;
  expect(rows.length).toBe(1);
  expect(rows[0].children[0].textContent).toBe("new");
});

test("a session that ended stops polling and says so", async () => {
  const h = harness([{ status: 404, body: { error: "No such session." } }]);
  await settle();
  expect(h.get("chat-gone").hidden).toBe(false);
  expect(h.get("chat-main").hidden).toBe(true);
  expect(h.get("chat-form").hidden).toBe(true);
  expect(h.timers.length).toBe(0);
});

test("an id that is not a managed session never reaches the server", async () => {
  const h = harness([], "e:123");
  await settle();
  expect(h.requests).toEqual([]);
  expect(h.get("chat-gone").hidden).toBe(false);
});
