import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createDocument, loadBody } from "./chat-test-dom.js";

const read = (path) => readFileSync(new URL(`../public/${path}`, import.meta.url), "utf8");
const source = read("command-palette.js");

/** The palette module against the real index.html markup. */
function load(html = read("index.html")) {
  const document = loadBody(createDocument(), html);
  const context = { document, navigator: {}, Event: class { constructor(type) { this.type = type; } } };
  context.window = context;
  runInNewContext(source, context, { filename: "command-palette.js" });
  return { document, P: context.CommandPalette };
}

const labels = (items) => items.map((item) => item.label);

test("every Settings page and its static controls are indexed from the markup", () => {
  const { document, P } = load();
  const items = P.collectSettings(document);
  const pages = items.filter((i) => i.page).map((i) => i.sheet);
  for (const sheet of ["sheet-menu", "sheet-agent-auth", "sheet-commands", "sheet-connectors", "sheet-secrets", "sheet-cli", "sheet-server-settings", "sheet-app-updates", "sheet-cli-updates", "sheet-github", "sheet-browser", "sheet-projects", "sheet-connect"]) {
    expect(pages).toContain(sheet);
  }
  // Every page names a real opener.
  for (const sheet of document.querySelectorAll(".sheet")) {
    if (sheet.dataset.settings) expect(document.getElementById(sheet.dataset.settings)).not.toBeNull();
  }
  const all = labels(items);
  for (const label of ["Appearance", "Notify me when a session needs my answer", "Session name prefix", "Add Face ID / Touch ID", "External MCP connectors", "Update automatically every 24 hours", "Codex", "Preferences"]) {
    expect(all).toContain(label);
  }
  const appearance = items.find((i) => i.label === "Appearance");
  expect(appearance.section).toBe("Settings › Preferences");
  expect(appearance.locate).toEqual({ id: "theme-preference" });
  expect(appearance.keywords).toContain("dark");
  const codex = items.find((i) => i.label === "Codex" && i.sheet === "sheet-agent-auth");
  expect(codex.desc).toBe("Device-code sign in");
  expect(codex.section).toBe("Settings › Agent authentication");
  const prefix = items.find((i) => i.label === "Session name prefix");
  expect(prefix.desc).toContain("Added to every new session name");
  // Sheets that aren't settings pages (start a session, confirmations) stay out.
  expect(items.some((i) => i.sheet === "sheet-new" || i.sheet === "sheet-confirm")).toBe(false);
});

test("a setting added later is picked up without touching the palette", () => {
  const html = read("index.html").replace(
    '<div id="server-settings-list" class="server-settings-list"></div>',
    '<div id="server-settings-list" class="server-settings-list"><div class="server-setting"><label class="label" for="server-setting-workspaceTrust">Workspace trust</label><select id="server-setting-workspaceTrust" class="field"><option>Ask</option><option>Always</option></select><p class="hint">Whether agents trust new workspace folders.</p></div></div>',
  );
  const { document, P } = load(html);
  const items = P.collectSettings(document);
  const trust = items.find((i) => i.label === "Workspace trust");
  expect(trust).toMatchObject({ sheet: "sheet-server-settings", section: "Settings › Server settings", desc: "Whether agents trust new workspace folders.", locate: { id: "server-setting-workspaceTrust" } });
  expect(P.rank(items, "trust")[0].label).toBe("Workspace trust");
});

test("dynamic rows (connectors, secret names, agents) are indexed by name and found again", () => {
  const { document, P } = load();
  const connector = document.createElement("button");
  connector.className = "row-btn connector-row";
  const name = document.createElement("span");
  name.className = "connector-row-name";
  name.textContent = "Linear";
  const status = document.createElement("span");
  status.className = "connection-status";
  status.textContent = "Connected";
  const detail = document.createElement("span");
  detail.className = "connection-detail";
  detail.textContent = "mcp.linear.app · 3 tools granted";
  connector.append(name, status, detail);
  document.getElementById("connector-list").append(connector);

  const secret = document.createElement("div");
  secret.className = "proj-row";
  const span = document.createElement("span");
  const path = document.createElement("div");
  path.className = "pick-path";
  path.textContent = "updated 2 hours ago";
  span.append("OPENAI_API_KEY", path);
  secret.append(span);
  document.getElementById("secret-list").append(secret);

  const items = P.collectSettings(document);
  const linear = items.find((i) => i.label === "Linear");
  expect(linear).toMatchObject({ sheet: "sheet-connectors", desc: "mcp.linear.app · 3 tools granted", locate: { label: "Linear" } });
  const key = items.find((i) => i.label === "OPENAI_API_KEY");
  expect(key).toMatchObject({ sheet: "sheet-secrets", desc: "updated 2 hours ago" });
  expect(P.locate(document, linear)).toBe(connector);
  expect(P.rank(items, "openai")[0].label).toBe("OPENAI_API_KEY");
  expect(P.rank(items, "linear")[0].label).toBe("Linear");
});

test("hidden and opted-out elements are not offered", () => {
  const { document, P } = load();
  const before = labels(P.collectSettings(document));
  expect(before).toContain("Session name prefix");
  document.getElementById("input-prefix").parentNode.setAttribute("data-search-skip", "");
  document.getElementById("chk-notify").parentNode.hidden = true;
  const after = labels(P.collectSettings(document));
  expect(after).not.toContain("Session name prefix");
  expect(after).not.toContain("Notify me when a session needs my answer");
});

test("fuzzy matching: exact, prefix, word, substring, then in-order letters", () => {
  const { P } = load();
  expect(P.fuzzy("passkey", "passkey")).toBe(100);
  expect(P.fuzzy("pass", "passkey")).toBe(90);
  expect(P.fuzzy("key", "add api key")).toBe(80);
  expect(P.fuzzy("key", "passkey")).toBe(60);
  expect(P.fuzzy("pskey", "passkey")).toBeGreaterThan(20);
  expect(P.fuzzy("pskey", "passkey")).toBeLessThan(60);
  expect(P.fuzzy("zz", "passkey")).toBe(0);
  expect(P.fuzzy("pk", "passkey")).toBe(0); // two letters must be contiguous
  expect(P.normalize("  Café  & Co. ")).toBe("cafe co.");
});

test("ranking: synonyms reach the right setting, settings rank above sessions", () => {
  const { document, P } = load();
  const items = [
    ...P.collectSettings(document),
    ...P.collectActions(document),
    { id: "session:a", kind: "session", label: "passkey-refactor", section: "Session", desc: "", keywords: "" },
  ];
  expect(P.rank(items, "password")[0].label).toBe("Add Face ID / Touch ID");
  expect(P.rank(items, "passkey")[0].label).toBe("Add Face ID / Touch ID");
  expect(labels(P.rank(items, "passkey"))).toContain("passkey-refactor");
  expect(P.rank(items, "dark")[0].label).toBe("Appearance");
  expect(labels(P.rank(items, "theme"))).toContain("Appearance: Dark");
  expect(labels(P.rank(items, "update").slice(0, 4))).toEqual(expect.arrayContaining(["App updates", "CLI updates"]));
  expect(P.rank(items, "codex")[0].sheet).toBe("sheet-agent-auth");
  expect(labels(P.rank(items, "token").slice(0, 6))).toEqual(expect.arrayContaining(["CLI & MCP access"]));
  expect(P.rank(items, "new session")[0].label).toBe("New session");
  expect(P.rank(items, "qqqqzzz")).toEqual([]);
  // Every word has to match somewhere.
  expect(P.rank(items, "passkey zebra")).toEqual([]);
});

test("an empty query shows recent items first, then the settings pages", () => {
  const { document, P } = load();
  const items = P.collectSettings(document);
  const shown = P.rank(items, "", { recent: ["setting:sheet-secrets", "missing", "setting:sheet-menu:theme-preference"] });
  expect(shown[0]).toMatchObject({ id: "setting:sheet-secrets", recent: true });
  expect(shown[1]).toMatchObject({ label: "Appearance", recent: true });
  expect(shown.slice(2).every((i) => i.page)).toBe(true);
});

test("arrow keys wrap, Home and End jump", () => {
  const { P } = load();
  expect(P.moveActive(0, "ArrowDown", 3)).toBe(1);
  expect(P.moveActive(2, "ArrowDown", 3)).toBe(0);
  expect(P.moveActive(0, "ArrowUp", 3)).toBe(2);
  expect(P.moveActive(-1, "ArrowUp", 3)).toBe(2);
  expect(P.moveActive(1, "Home", 3)).toBe(0);
  expect(P.moveActive(0, "End", 3)).toBe(2);
  expect(P.moveActive(0, "ArrowDown", 0)).toBe(-1);
});

test("the shortcut: Cmd+K on a Mac, Ctrl+K elsewhere, never in a terminal or editor", () => {
  const { document, P } = load();
  const body = document.body;
  const key = (init, target = body) => ({ key: "k", target, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, defaultPrevented: false, ...init });
  expect(P.isPaletteShortcut(key({ metaKey: true }), { mac: true })).toBe(true);
  expect(P.isPaletteShortcut(key({ ctrlKey: true }), { mac: true })).toBe(true);
  expect(P.isPaletteShortcut(key({ ctrlKey: true }), { mac: false })).toBe(true);
  expect(P.isPaletteShortcut(key({ metaKey: true }), { mac: false })).toBe(false);
  expect(P.isPaletteShortcut(key({ key: "K", metaKey: true }), { mac: true })).toBe(true);
  expect(P.isPaletteShortcut(key({ metaKey: true, shiftKey: true }), { mac: true })).toBe(false);
  expect(P.isPaletteShortcut(key({ key: "j", metaKey: true }), { mac: true })).toBe(false);
  expect(P.isPaletteShortcut(key({ metaKey: true, defaultPrevented: true }), { mac: true })).toBe(false);

  const input = document.getElementById("session-search");
  expect(P.isPaletteShortcut(key({ metaKey: true }, input), { mac: true })).toBe(true);
  // Ctrl+K in a Mac text field deletes to the end of the line.
  expect(P.isPaletteShortcut(key({ ctrlKey: true }, input), { mac: true })).toBe(false);
  const textarea = document.createElement("textarea");
  body.append(textarea);
  expect(P.isPaletteShortcut(key({ metaKey: true }, textarea), { mac: true })).toBe(false);
  const term = document.createElement("div");
  term.className = "xterm";
  const inner = document.createElement("textarea");
  term.append(inner);
  body.append(term);
  expect(P.isPaletteShortcut(key({ ctrlKey: true }, inner), { mac: false })).toBe(false);
  const own = document.createElement("div");
  own.setAttribute("data-own-cmdk", "");
  const field = document.createElement("input");
  own.append(field);
  body.append(own);
  expect(P.isPaletteShortcut(key({ metaKey: true }, field), { mac: true })).toBe(false);
});

test("actions come from data-command, a select gives one per option", () => {
  const { document, P } = load();
  const actions = labels(P.collectActions(document));
  expect(actions).toEqual(expect.arrayContaining(["New session", "Open settings", "Show ended sessions", "Appearance: Light", "Appearance: Dark", "Appearance: System"]));
});

test("the palette markup is an accessible combobox dialog with a 16px input", () => {
  const { document } = load();
  const dialog = document.getElementById("palette").querySelector(".palette-box");
  expect(dialog.getAttribute("role")).toBe("dialog");
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  const input = document.getElementById("palette-input");
  expect(input.getAttribute("role")).toBe("combobox");
  expect(input.getAttribute("aria-controls")).toBe("palette-list");
  expect(document.getElementById("palette-list").getAttribute("role")).toBe("listbox");
  expect(document.getElementById("btn-palette").getAttribute("aria-label")).toBe("Search settings and actions");
  expect(read("app.css")).toMatch(/\.palette-field input \{[^}]*font: 400 16px/);
  expect(source).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
});

test("a setting that also carries data-command is offered once", () => {
  const html = read("index.html").replace('id="btn-web-terminal" ', 'id="btn-web-terminal" data-command="Open a terminal on the server" ');
  const { document, P } = load(html);
  const items = [...P.collectSettings(document), ...P.collectActions(document)];
  expect(items.filter((i) => i.label === "Open a terminal on the server")).toHaveLength(1);
  const real = load();
  const all = [...real.P.collectSettings(real.document), ...real.P.collectActions(real.document)];
  expect(all.filter((i) => i.label === "Open a terminal on the server")).toHaveLength(1);
  // A select inside Settings still gives its option actions.
  expect(labels(all)).toContain("Appearance: Dark");
});

/* ---------- background loads for settings search are silent ---------- */

async function failingModule(file, factory) {
  const { document } = load();
  const toasts = [];
  const warnings = [];
  const context = {
    document, console: { warn: (...a) => warnings.push(a.join(" ")), log() {}, error() {} },
    MutationObserver: class { observe() {} }, setTimeout, clearTimeout, URL, location: { origin: "http://x", href: "http://x/" },
  };
  context.window = context;
  runInNewContext(read(file), context, { filename: file });
  const ui = context[factory]({
    $: (id) => document.getElementById(id), api: async () => { throw new Error("Server unavailable"); },
    openSheet() {}, showToast: (m) => toasts.push(m), agoStr: () => "", escapeHtml: (s) => s,
  });
  await ui.preload();
  return { toasts, warnings };
}

test("secrets: a failed background load logs and shows nothing", async () => {
  const { toasts, warnings } = await failingModule("secrets.js", "createSecretsUI");
  expect(toasts).toEqual([]);
  expect(warnings.join()).toContain("Server unavailable");
});

test("connectors: a failed background load logs and shows nothing", async () => {
  const { toasts, warnings } = await failingModule("connectors.js", "createConnectorsUI");
  expect(toasts).toEqual([]);
  expect(warnings.join()).toContain("Server unavailable");
});

test("app: every palette preload runs its loader quietly", () => {
  const app = read("app.js");
  const start = app.indexOf("preload: [");
  const block = app.slice(start, app.indexOf("],", start));
  for (const loader of ["loadCommands", "loadPresets", "loadCliTokens", "loadMcpConnections"]) {
    expect(block).toContain(`${loader}({ quiet: true })`);
    expect(app).toMatch(new RegExp(`async function ${loader}\\(\\{ quiet = false \\} = \\{\\}\\)[\\s\\S]*?loadFailed\\(e, quiet\\)`));
  }
  expect(app).toMatch(/function loadFailed\(error, quiet\) \{\s*if \(quiet\) console\.warn/);
  expect(block).toContain("secretsUI.preload()");
  expect(block).toContain("connectorsUI.preload()");
});
