import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

/** Just enough DOM for public/connectors.js; every element is a forgiving stub. */
function element() {
  const listeners = {};
  return {
    dataset: {}, style: {}, hidden: false, disabled: false, value: "", textContent: "", innerHTML: "", children: [],
    addEventListener(type, fn) { (listeners[type] ??= []).push(fn); }, listeners,
    append(...nodes) { this.children.push(...nodes); }, appendChild(node) { this.children.push(node); }, replaceChildren() { this.children = []; },
    querySelector: () => null, querySelectorAll: () => [], focus() {}, requestSubmit() {},
  };
}
function harness() {
  const nodes = new Map();
  const document = {
    getElementById: id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    querySelectorAll: () => [], querySelector: () => null, createElement: () => element(), createTextNode: textContent => ({ textContent }), activeElement: null,
  };
  const window = {};
  class MutationObserver { observe() {} }
  runInNewContext(readFileSync(new URL("../public/connectors.js", import.meta.url), "utf8"), { window, document, MutationObserver, location: { assign() {} }, URL, setTimeout, clearTimeout });
  const opened = [];
  const pending = [];
  const api = path => new Promise(resolve => pending.push({ path, resolve }));
  const ui = window.createConnectorsUI({ $: id => document.getElementById(id), api, openSheet: id => opened.push(id), showToast() {}, agoStr: () => "now", escapeHtml: s => String(s) });
  const respond = (path, body) => { const i = pending.findIndex(p => p.path === path); pending.splice(i, 1)[0].resolve(body); };
  return { ui, opened, pending, respond };
}
const ID = "11111111-2222-3333-4444-555555555555";
const view = { id: ID, name: "Notes", namespace: "notes", url: "https://mcp.example/mcp", host: "mcp.example", enabled: true, state: "connected",
  credential: { set: false, set_at: null }, auth: { mode: "oauth", oauth: { state: "connected", identity: null, connectedSince: 1, issuer: "https://as.example", registration: "dcr" } },
  oauth_client: null, server: null, checked_at: null, last_ok_at: null, check_detail: null, tools: [], discovered_count: 0, granted_tools: [], default_providers: [], launches: [] };
const settle = () => new Promise(r => setTimeout(r, 0));

test("returning from sign-in opens the connector however late the list arrives", async () => {
  const h = harness();
  const opening = h.ui.openConnector(ID);
  await settle();
  expect(h.opened).toEqual(["sheet-connectors"]);
  // Much later than the old two-second polling window.
  await new Promise(r => setTimeout(r, 2100));
  h.respond("/api/connectors", { connectors: [view] });
  await opening;
  expect(h.opened).toEqual(["sheet-connectors", "sheet-connector"]);
}, 10000);

test("navigating elsewhere while the list loads cancels opening the connector", async () => {
  const h = harness();
  const opening = h.ui.openConnector(ID);
  await settle();
  // The user opens the list again (a newer navigation) before the first response arrives.
  const again = h.ui.open();
  h.respond("/api/connectors", { connectors: [view] });
  h.respond("/api/connectors", { connectors: [view] });
  await opening; await again;
  expect(h.opened).toEqual(["sheet-connectors", "sheet-connectors"]);
});
