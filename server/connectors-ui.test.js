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
  const api = (path, options = {}) => new Promise(resolve => pending.push({ path, resolve, body: options.body ? JSON.parse(options.body) : undefined }));
  const ui = window.createConnectorsUI({ $: id => document.getElementById(id), api, openSheet: id => opened.push(id), showToast() {}, agoStr: () => "now", escapeHtml: s => String(s) });
  const respond = (path, body) => { const i = pending.findIndex(p => p.path === path); pending.splice(i, 1)[0].resolve(body); };
  return { ui, opened, pending, respond, el: id => document.getElementById(id) };
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

const settled = async (h, path) => { for (let i = 0; i < 50 && !h.pending.some(p => p.path === path); i++) await settle(); return h.pending.find(p => p.path === path); };

test("adding a local command sends its command, one argument per line and the picked secret names", async () => {
  const h = harness();
  h.ui.open();
  h.respond("/api/secrets", { secrets: [{ name: "MY_KEY", updatedAt: 1 }], sources: [{ names: ["SOURCE_KEY"] }] });
  h.respond("/api/connectors", { connectors: [] });
  await settle();
  h.el("select-connector-transport").value = "stdio";
  h.el("select-connector-transport").listeners.change[0]();
  expect(h.el("connector-add-local").hidden).toBe(false);
  expect(h.el("connector-add-remote").hidden).toBe(true);
  expect(h.el("input-connector-url").required).toBe(false);
  const picker = h.el("connector-add-secrets").children;
  expect(picker.length).toBe(2);
  const mine = picker.find(row => row.children[1].innerHTML.includes("MY_KEY")).children[0];
  mine.checked = true; mine.listeners.change[0]();
  h.el("input-connector-name").value = "Local";
  h.el("input-connector-command").value = " npx ";
  h.el("input-connector-args").value = "-y\n\n@example/server\n";
  h.el("input-connector-cwd").value = "";
  h.el("form-connector-add").listeners.submit[0]({ preventDefault() {} });
  const sent = await settled(h, "/api/connectors");
  expect(sent.body).toEqual({ name: "Local", transport: "stdio", command: "npx", args: ["-y", "@example/server"], env_secrets: ["MY_KEY"], cwd: "" });
});

test("extra headers are sent as name and value; a saved header with no new value keeps it", async () => {
  const h = harness();
  h.ui.open();
  h.respond("/api/connectors", { connectors: [] });
  await settle();
  h.el("btn-connector-add-header").listeners.click[0]();
  const row = h.el("connector-add-headers").children[0];
  row.headerInputs.nameInput.value = "X-API-Key";
  row.headerInputs.valueInput.value = "secret-value";
  h.el("input-connector-name").value = "Remote";
  h.el("input-connector-url").value = "https://mcp.example/mcp";
  h.el("form-connector-add").listeners.submit[0]({ preventDefault() {} });
  const sent = await settled(h, "/api/connectors");
  expect(sent.body).toEqual({ name: "Remote", url: "https://mcp.example/mcp", headers: [{ name: "X-API-Key", value: "secret-value" }] });
});

test("connector details show the negotiated transport; a local command hides URL, token and sign-in settings", async () => {
  const h = harness();
  const local = { ...view, id: ID, transport: "stdio", url: null, host: null, headers: [], auth: { mode: "none", oauth: null },
    protocol: { transport: "stdio", version: "2026-07-28", label: "stdio (2026-07-28)" }, local: { command: "/usr/bin/srv", args: ["--x"], env_secrets: ["MY_KEY"], cwd: null } };
  const opening = h.ui.openConnector(ID);
  await settle();
  h.respond("/api/connectors", { connectors: [local] });
  await opening;
  expect(h.el("connector-transport").textContent).toBe("stdio (2026-07-28)");
  expect(h.el("connector-host").textContent).toBe("/usr/bin/srv");
  expect(h.el("connector-remote-settings").hidden).toBe(true);
  expect(h.el("form-connector-local").hidden).toBe(false);
  expect(h.el("connector-edit-url").hidden).toBe(true);
  expect(h.el("input-connector-local-args").value).toBe("--x");
  expect(h.el("connector-credential").textContent).toContain("MY_KEY");

  const h2 = harness();
  const remote = { ...view, headers: ["X-API-Key"], transport: "http", protocol: { transport: "sse", version: "2024-11-05", label: "HTTP+SSE (2024-11-05, deprecated)" }, local: null };
  const again = h2.ui.openConnector(ID);
  await settle();
  h2.respond("/api/connectors", { connectors: [remote] });
  await again;
  expect(h2.el("connector-transport").textContent).toBe("HTTP+SSE (2024-11-05, deprecated)");
  expect(h2.el("connector-remote-settings").hidden).toBe(false);
  const saved = h2.el("connector-headers").children;
  expect(saved.map(r => r.headerInputs.nameInput.value)).toEqual(["X-API-Key"]);
  expect(saved[0].headerInputs.valueInput.value).toBe("");
});
