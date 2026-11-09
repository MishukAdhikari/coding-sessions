import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createDocument, loadBody, text } from "./chat-test-dom.js";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const page = read("chat.html");
const scripts = ["native.js", "chat-markdown.js", "chat-view.js", "chat.js"].map((name) => [name, read(name)]);

/** The real chat page (its markup and its three scripts) against scripted server replies. */
function harness({ responses = [], id = "m:cs-demo", query = "", hold = false, keyboard = false } = {}) {
  const document = loadBody(createDocument(), page);
  document.documentElement.style.setProperty = (name, value) => { document.documentElement.style[name] = value; };
  const timers = [];
  const requests = [];
  const held = []; // with hold, each GET waits until release() answers it
  const fetch = async (url, options = {}) => {
    requests.push({ url, method: options.method || "GET", body: options.body ? JSON.parse(options.body) : null });
    if (options.method === "POST") return { ok: true, status: 200, json: async () => ({ ok: true }) };
    if (hold) await new Promise((resolve) => held.push(resolve));
    const next = responses.shift() ?? { status: 200, body: { messages: [], cursor: 0, state: "unknown" } };
    return { ok: next.status >= 200 && next.status < 300, status: next.status, json: async () => next.body };
  };
  const context = {
    document, fetch, URLSearchParams, JSON, Promise,
    location: { search: `?id=${encodeURIComponent(id)}&name=demo${query}`, href: "" },
    navigator: {},
    open: () => null, close() {}, closed: false, addEventListener() {},
    // An on-screen keyboard covering the bottom 344px of an 844px phone.
    innerHeight: 844, visualViewport: keyboard ? { height: 500, addEventListener() {} } : undefined, scrollY: 0,
    setTimeout: (fn, ms) => { const t = { fn, ms, live: true }; timers.push(t); return timers.length; },
    clearTimeout: (n) => { if (timers[n - 1]) timers[n - 1].live = false; },
  };
  context.window = context;
  for (const [name, source] of scripts) runInNewContext(source, context, { filename: name });
  const $ = (elementId) => document.getElementById(elementId);
  const rows = () => $("chat-list").children;
  // Runs the poll the page scheduled last, as its timer would.
  const tick = async () => {
    const t = timers.filter((x) => x.live && x.ms >= 150).at(-1);
    t.live = false;
    await t.fn();
    await settle();
  };
  const release = async () => { held.shift()?.(); await settle(); await settle(); };
  return { document, $, rows, timers, requests, tick, release, held };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const ev = (seq, kind, fields) => ({ seq, at: "2026-11-08T12:00:00.000Z", kind, ...fields });
const up = (seq, update) => ev(seq, "update", { update });

test("no chat source writes markup", () => {
  for (const name of ["chat.js", "chat-view.js", "chat-markdown.js", "launch-mode.js", "chat.html"]) {
    const found = read(name).match(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/g) ?? [];
    expect(`${name}: ${found.join(", ") || "none"}`).toBe(`${name}: none`);
  }
});

/* ---------- transcript chats ---------- */

test("transcript messages map to user, assistant and tool items, with HTML kept as text", async () => {
  const h = harness({ responses: [{ status: 200, body: {
    cursor: 120, state: "waiting",
    messages: [
      { id: "0:0", role: "user", text: "<img src=x onerror=alert(1)>", at: "2026-11-07T12:00:00Z" },
      { id: "50:0", role: "assistant", text: "<script>steal()</script> and **bold**", at: null },
      { id: "50:1", role: "tool", text: "Bash ls -la", at: null },
    ],
  } }] });
  await settle();
  const [user, assistant, tool] = h.rows();
  expect(user.className).toContain("cv-user");
  expect(text(user.querySelector(".cv-user-text"))).toBe("<img src=x onerror=alert(1)>");
  expect(assistant.className).toContain("cv-assistant");
  expect(assistant.querySelectorAll("script")).toHaveLength(0);
  expect(text(assistant.querySelector("strong"))).toBe("bold");
  expect(text(assistant)).toContain("<script>steal()</script>");
  expect(tool.className).toContain("cv-tool");
  expect(tool.className).toContain("is-preview");
  expect(text(h.$("chat-status-text"))).toBe("Finished");
  expect(h.$("chat-banner").hidden).toBe(true);
  expect(h.$("btn-chat-term").hidden).toBe(false);
});

test("polls with the cursor and does not repeat messages it already shows", async () => {
  const msg = { id: "0:0", role: "assistant", text: "hi", at: null };
  const h = harness({ responses: [
    { status: 200, body: { cursor: 10, state: "working", messages: [msg] } },
    { status: 200, body: { cursor: 10, state: "asking", messages: [msg] } },
  ] });
  await settle();
  expect(h.timers.at(-1).ms).toBe(2000);
  expect(h.$("chat-working").hidden).toBe(false);
  await h.tick();
  expect(h.requests[1].url).toBe("/api/sessions/m%3Acs-demo/transcript?after=10");
  expect(h.rows()).toHaveLength(1);
  expect(h.$("chat-banner").hidden).toBe(false);
  expect(text(h.$("chat-status-text"))).toBe("Waiting on you");
});

test("a reset replaces the shown messages", async () => {
  const h = harness({ responses: [
    { status: 200, body: { cursor: 10, state: "waiting", messages: [{ id: "0:0", role: "user", text: "old", at: null }] } },
    { status: 200, body: { cursor: 5, reset: true, state: "waiting", messages: [{ id: "0:0", role: "user", text: "new", at: null }] } },
  ] });
  await settle();
  await h.tick();
  expect(h.rows()).toHaveLength(1);
  expect(text(h.rows()[0])).toContain("new");
});

test("a reply is posted to the session and the composer clears", async () => {
  const h = harness({ responses: [{ status: 200, body: { cursor: 1, state: "waiting", messages: [] } }] });
  await settle();
  expect(text(h.$("chat-empty"))).toContain("No messages yet");
  h.$("chat-input").value = "please continue";
  h.$("chat-input").dispatch("input");
  expect(h.$("chat-send").disabled).toBe(false);
  h.$("chat-form").dispatch("submit");
  await settle();
  expect(h.requests.at(-1)).toEqual({ url: "/api/sessions/m%3Acs-demo/message", method: "POST", body: { text: "please continue" } });
  expect(h.$("chat-input").value).toBe("");
});

test("a session that ended stops polling and says so", async () => {
  const h = harness({ responses: [{ status: 404, body: { error: "No such session." } }] });
  await settle();
  expect(h.$("chat-gone").hidden).toBe(false);
  expect(h.$("chat-main").hidden).toBe(true);
  expect(h.$("chat-dock").hidden).toBe(true);
  expect(h.timers.filter((t) => t.live)).toHaveLength(0);
});

test("a proxy error or restart retries instead of ending the chat", async () => {
  const h = harness({ responses: [
    { status: 502, body: {} },
    { status: 200, body: { cursor: 3, state: "waiting", messages: [{ id: "0:0", role: "assistant", text: "back", at: null }] } },
  ] });
  await settle();
  expect(h.$("chat-main").hidden).toBe(false);
  expect(text(h.$("chat-status-text"))).toBe("Reconnecting…");
  expect(h.timers.at(-1).ms).toBe(5000);
  await h.tick();
  expect(h.rows()).toHaveLength(1);
  expect(h.$("chat-gone").hidden).toBe(true);
});

test("an id that is not a managed session never reaches the server", async () => {
  const h = harness({ id: "e:123" });
  await settle();
  expect(h.requests).toEqual([]);
  expect(h.$("chat-gone").hidden).toBe(false);
});

/* ---------- ACP chats ---------- */

const PERMISSION_OPTIONS = [
  { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
  { optionId: "reject", name: "Reject", kind: "reject_once" },
];

const conversation = () => [
  ev(1, "status", { agent: { name: "claude-agent-acp", title: "Claude Code", version: "0.9.0" } }),
  ev(2, "user", { text: "Fix the failing test" }),
  up(3, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "Looking at " } }),
  up(4, { sessionUpdate: "agent_message_chunk", messageId: "m1", content: { type: "text", text: "the **test** now." } }),
  up(5, { sessionUpdate: "tool_call", toolCallId: "t1", title: "bun test", kind: "execute", status: "in_progress", rawInput: { command: "bun test" } }),
  up(6, { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "failed", content: [{ type: "content", content: { type: "text", text: "1 test failed" } }] }),
  up(7, { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit src/a.ts", kind: "edit", status: "completed", content: [{ type: "diff", path: "/repo/src/a.ts", oldText: "one\ntwo\nthree\n", newText: "one\nTWO\nthree\n" }] }),
  up(8, { sessionUpdate: "plan", entries: [{ content: "Read the test", status: "completed" }, { content: "Fix it", status: "in_progress" }] }),
  up(9, { sessionUpdate: "plan", entries: [{ content: "Read the test", status: "completed" }, { content: "Fix it", status: "completed" }, { content: "Run the suite", status: "pending" }] }),
  up(10, { sessionUpdate: "agent_thought_chunk", messageId: "th1", content: { type: "text", text: "The suite should pass now." } }),
  ev(11, "permission", { requestId: "perm-1", toolCall: { toolCallId: "t3", title: "Write CHANGELOG.md", kind: "edit" }, options: PERMISSION_OPTIONS }),
];

const acp = (state, events, extra = {}) => ({ status: 200, body: { mode: "acp", state, agent: { name: "claude-agent-acp", title: "Claude Code", version: "0.9.0" }, error: null, events, cursor: events.at(-1)?.seq ?? 0, reset: false, ...extra } });

test("an ACP chat folds the event log into one message, tool rows, a plan and a thought", async () => {
  const h = harness({ query: "&mode=acp&agent=Claude", responses: [acp("waiting", conversation())] });
  await settle();
  expect(h.requests[0].url).toBe("/api/sessions/m%3Acs-demo/acp");
  const rows = h.rows();
  const assistants = rows.filter((r) => r.className.includes("cv-assistant"));
  expect(assistants).toHaveLength(1);
  expect(text(assistants[0].querySelector(".md"))).toBe("Looking at the test now.");

  const tools = rows.filter((r) => r.className.includes("cv-tool"));
  const failed = tools.filter((r) => r.className.includes("is-failed"));
  expect(failed).toHaveLength(1);
  expect(text(failed[0].querySelector(".cv-tool-status"))).toBe("Failed");
  expect(text(failed[0])).toContain("1 test failed");
  expect(failed[0].open).toBe(true);

  const diff = rows.find((r) => r.querySelector(".cv-diff"));
  expect(diff.querySelectorAll(".cv-dl.is-del").map((l) => text(l.querySelector(".cv-dl-text")))).toEqual(["two"]);
  expect(diff.querySelectorAll(".cv-dl.is-add").map((l) => text(l.querySelector(".cv-dl-text")))).toEqual(["TWO"]);

  const plans = rows.filter((r) => r.className.includes("cv-plan"));
  expect(plans).toHaveLength(1);
  expect(plans[0].querySelectorAll("li")).toHaveLength(3);
  expect(text(plans[0].querySelector(".cv-plan-count"))).toBe("2 of 3 done");

  const thought = rows.find((r) => r.className.includes("cv-thought"));
  expect(thought.localName).toBe("details");
  expect(thought.open).toBe(false);
});

test("an ACP chat has no Terminal button and names the agent in the header", async () => {
  const h = harness({ query: "&mode=acp", responses: [acp("idle", [ev(1, "status", { agent: { name: "x", title: "Claude Code" } })])] });
  await settle();
  expect(h.$("btn-chat-term").hidden).toBe(true);
  expect(text(h.$("chat-agent"))).toBe("Claude Code");
  expect(text(h.$("chat-status-text"))).toBe("Ready");
  expect(text(h.$("chat-empty"))).toContain("Start the conversation");
});

test("a pending permission shows the agent's exact options, and answering it sends that option", async () => {
  const h = harness({ query: "&mode=acp", responses: [
    acp("waiting", conversation()),
    acp("working", [ev(12, "permission_resolved", { requestId: "perm-1", optionId: "allow-once", auto: false })]),
  ] });
  await settle();
  const card = h.$("chat-permission");
  expect(card.hidden).toBe(false);
  expect(text(card.querySelector(".cv-perm-what"))).toBe("Write CHANGELOG.md");
  const buttons = card.querySelectorAll(".cv-perm-btn");
  expect(buttons.map((b) => text(b))).toEqual(["Allow once", "Allow always", "Reject"]);
  expect(text(h.$("chat-status-text"))).toBe("Waiting on you");
  expect(h.$("chat-send").disabled).toBe(true);

  buttons[0].click();
  await settle();
  expect(h.requests.at(-1)).toEqual({ url: "/api/sessions/m%3Acs-demo/acp", method: "POST", body: { op: "permission", requestId: "perm-1", optionId: "allow-once" } });
  // While the answer is on its way the card stays, with every option held.
  expect(h.$("chat-permission").querySelectorAll(".cv-perm-btn").every((b) => b.disabled)).toBe(true);

  await h.tick();
  expect(h.$("chat-permission").hidden).toBe(true);
  expect(text(h.$("chat-status-text"))).toBe("Working");
  expect(h.rows().some((r) => text(r).includes("You chose “Allow once” · Write CHANGELOG.md"))).toBe(true);
});

test("Stop cancels the running turn, and the turn's end is shown", async () => {
  const h = harness({ query: "&mode=acp", responses: [
    acp("working", [ev(1, "user", { text: "go" })]),
    acp("idle", [ev(2, "turn_end", { stopReason: "cancelled" })]),
  ] });
  await settle();
  expect(h.$("chat-stop").hidden).toBe(false);
  expect(h.$("chat-send").hidden).toBe(true);
  expect(h.timers.at(-1).ms).toBe(600);
  h.$("chat-stop").click();
  await settle();
  expect(h.requests.at(-1).body).toEqual({ op: "cancel" });
  await h.tick();
  expect(h.$("chat-stop").hidden).toBe(true);
  expect(text(h.rows().at(-1))).toBe("Stopped");
  expect(text(h.$("chat-status-text"))).toBe("Finished");
});

test("a prompt is sent through the bridge and shown at once", async () => {
  const h = harness({ query: "&mode=acp", responses: [acp("idle", [])] });
  await settle();
  h.$("chat-input").value = "Add a changelog entry";
  h.$("chat-input").dispatch("input");
  h.$("chat-input").dispatch("keydown", { key: "Enter", shiftKey: false });
  await settle();
  expect(h.requests.at(-1).body).toEqual({ op: "prompt", text: "Add a changelog entry" });
  const echo = h.rows().at(-1);
  expect(echo.className).toContain("is-pending");
  expect(text(echo)).toBe("Add a changelog entry");
});

test("starting and failed ACP sessions say so in the composer", async () => {
  const starting = harness({ query: "&mode=acp", responses: [acp("starting", [])] });
  await settle();
  expect(text(starting.$("chat-status-text"))).toBe("Starting");
  expect(starting.$("chat-send").disabled).toBe(true);
  expect(text(starting.$("chat-reason"))).toContain("is starting");

  const failed = harness({ query: "&mode=acp&agent=Codex", responses: [acp("failed", [], { agent: null, error: "codex-acp is not installed." })] });
  await settle();
  expect(text(failed.$("chat-status-text"))).toBe("Failed");
  expect(failed.$("chat-input").disabled).toBe(true);
  expect(failed.rows().some((r) => r.className.includes("is-error") && text(r) === "codex-acp is not installed.")).toBe(true);
});

test("a poll asked for while one is still running waits for it, so streamed text is never added twice", async () => {
  const h = harness({ query: "&mode=acp", hold: true, responses: [
    acp("working", [ev(1, "user", { text: "go" }), up(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } })]),
    acp("working", [up(3, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } })]),
  ] });
  await settle();
  expect(h.held).toHaveLength(1); // the first poll is in flight
  h.$("chat-stop").click(); // asks for a poll in 150 ms while the first one runs
  await settle();
  const gets = () => h.requests.filter((r) => r.method === "GET");
  expect(gets()).toHaveLength(1); // no second poll started on the same cursor
  await h.release();
  expect(h.timers.filter((t) => t.live).at(-1).ms).toBe(150); // the soonest request wins once the poll ends
  const next = h.tick();
  await settle();
  expect(gets()).toHaveLength(2);
  expect(gets()[1].url).toContain("after=");
  await h.release();
  await next;
  const all = h.rows().map(text).join("\n");
  expect(all).toContain("Hello world");
  expect(all.split("Hello").length - 1).toBe(1);
  expect(all.split(" world").length - 1).toBe(1);
});

test("with an on-screen keyboard up, Enter starts a new line and the send button sends", async () => {
  const h = harness({ query: "&mode=acp", responses: [acp("idle", [])], keyboard: true });
  await settle();
  expect(h.document.documentElement.style["--chat-vh"]).toBe("500px");
  h.$("chat-input").value = "first line";
  h.$("chat-input").dispatch("input");
  h.$("chat-input").dispatch("keydown", { key: "Enter", shiftKey: false });
  await settle();
  expect(h.requests.filter((r) => r.method === "POST")).toEqual([]);
  h.$("chat-send").click();
  h.$("chat-form").dispatch("submit");
  await settle();
  expect(h.requests.filter((r) => r.method === "POST").map((r) => r.body)).toEqual([{ op: "prompt", text: "first line" }]);
});
