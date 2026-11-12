import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createDocument, loadBody, text } from "./chat-test-dom.js";

/* public/agent-auth.js against the page's real Agent authentication markup: every
 * agent gets a row with its own way to connect, whatever else is installed. */

const source = readFileSync(new URL("../public/agent-auth.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const PRESETS = [
  { id: "gemini", label: "Gemini CLI", envVar: "GEMINI_API_KEY", loginHint: "Starts Gemini." },
  { id: "kimi", label: "Kimi Code", envVar: null, loginHint: "Runs kimi login." },
  { id: "qwen", label: "Qwen Code", envVar: "OPENAI_API_KEY", loginHint: "Type /auth." },
  { id: "opencode", label: "opencode", envVar: null, loginHint: "Runs opencode auth login." },
];
const account = (provider, installed, loggedIn = false) =>
  ({ provider, installed, loggedIn: installed ? loggedIn : null, email: loggedIn ? "me@example.test" : null, plan: null, organization: null, loggedInSince: null });

async function sheet({ installed = [], loggedIn = [], commands = [] } = {}) {
  const document = loadBody(createDocument(), indexHtml);
  // The small DOM keeps markup attributes as attributes; a browser reflects these two.
  for (const input of document.querySelectorAll("input")) {
    input.value = input.getAttribute("value") ?? "";
    input.name = input.getAttribute("name") ?? "";
  }
  const calls = [];
  const terminals = [];
  const sheets = [];
  const api = async (path, opts = {}) => {
    calls.push({ path, method: opts.method || "GET", body: opts.body ? JSON.parse(opts.body) : undefined });
    if (path === "/api/agent-accounts") return {
      accounts: ["codex", "claude", "command-code"].map(p => account(p, installed.includes(p), loggedIn.includes(p))),
      agents: PRESETS.map(p => ({ ...p, installed: installed.includes(p.id) })),
    };
    if (path === "/api/codex-auth/start") return { state: "starting", running: true };
    return { state: "idle" };
  };
  const context = { document, requestAnimationFrame: (fn) => fn(), setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {} };
  context.window = context;
  runInNewContext(source, context);
  const auth = context.createAgentAuth({
    $: (id) => document.getElementById(id), api,
    openSheet: (id) => { sheets.push(id); document.getElementById(id).hidden = false; },
    closeSheet() {}, copyText() {}, showToast() {},
    codexAuthSupported: () => true, commandCodeAuthSupported: () => true, capabilitiesResolved: () => true,
    registeredCommands: () => commands,
    openTerminal: async (body, label) => { terminals.push({ body, label }); },
  });
  auth.openAccounts();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  const $ = (id) => document.getElementById(id);
  const inputs = () => document.querySelectorAll('input[name="auth-provider"]');
  const card = (p) => document.querySelectorAll("[data-auth-provider-card]").find(c => c.dataset.authProviderCard === p) || null;
  const pick = (p) => {
    const input = inputs().find(i => i.value === p);
    for (const i of inputs()) i.checked = i === input;
    input.dispatch("change");
  };
  const view = () => ({
    button: $("btn-auth-provider-continue").textContent, disabled: $("btn-auth-provider-continue").disabled,
    state: $("agent-account-state").textContent, hint: $("agent-terminal-hint").hidden ? "" : text($("agent-terminal-hint")),
    terminalButton: !$("btn-agent-terminal-login").hidden,
  });
  return { $, calls, terminals, sheets, inputs, card, pick, view };
}

const ALL = ["codex", "claude", "command-code", "gemini", "kimi", "qwen", "opencode"];

test("rows: built-ins always; each preset agent once it is installed, by the app or by hand", async () => {
  const none = await sheet();
  expect(none.inputs().map(i => i.value)).toEqual(["claude", "codex", "command-code"]);
  const all = await sheet({ installed: ALL });
  expect(all.inputs().map(i => i.value)).toEqual(["claude", "codex", "command-code", "preset:gemini", "preset:kimi", "preset:qwen", "preset:opencode"]);
  for (const i of all.inputs()) expect(i.disabled).toBe(false);
  for (const id of ["gemini", "kimi", "qwen", "opencode"]) {
    const one = await sheet({ installed: [id] });
    expect(one.inputs().map(i => i.value)).toEqual(["claude", "codex", "command-code", `preset:${id}`]);
    expect(text(one.card(`preset:${id}`))).toContain("Installed · sign in in a terminal");
  }
});

test("built-in rows: not installed, signed out, signed in", async () => {
  for (const p of ["codex", "claude", "command-code"]) {
    const missing = await sheet();
    missing.pick(p);
    expect(missing.view()).toMatchObject({ state: "CLI not installed", disabled: true });
    const out = await sheet({ installed: [p] });
    out.pick(p);
    expect(out.view()).toMatchObject({ state: "Signed out", disabled: false, button: "Sign in", terminalButton: false, hint: "" });
    const signed = await sheet({ installed: [p], loggedIn: [p] });
    signed.pick(p);
    expect(signed.view()).toMatchObject({ state: "Signed in", button: "Change account" });
    expect(signed.$("btn-agent-signout").hidden).toBe(false);
  }
});

test("Codex keeps Connect with opencode installed, and its device flow starts", async () => {
  const s = await sheet({ installed: ["codex", "opencode"], commands: [
    { id: 1, provider: "cmd:opencode", label: "opencode", envVar: null, hasToken: false, preset: "opencode" }] });
  expect(s.inputs().map(i => i.value)).toContain("codex");
  expect(s.inputs().find(i => i.value === "codex").disabled).toBe(false);
  s.pick("codex");
  expect(s.view()).toMatchObject({ state: "Signed out", disabled: false, button: "Sign in" });
  s.$("btn-auth-provider-continue").click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(s.calls.some(c => c.path === "/api/codex-auth/start" && c.method === "POST")).toBe(true);
  expect(s.terminals).toEqual([]);
});

test("every terminal-sign-in agent opens its own login, from an unregistered row or a registered Command", async () => {
  for (const id of ["gemini", "kimi", "qwen", "opencode"]) {
    const s = await sheet({ installed: ALL });
    s.pick(`preset:${id}`);
    expect(s.view()).toMatchObject({ button: "Sign in in a terminal", disabled: false });
    expect(s.view().hint).toContain("Its sign-in status is not read by this app.");
    s.$("btn-auth-provider-continue").click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(s.terminals.map(t => t.body)).toEqual([{ kind: "shell", login: id }]);
  }
  // opencode added as a Command: no token, so its row signs in in a terminal (was disabled).
  const oc = await sheet({ installed: ["opencode"], commands: [{ id: 1, provider: "cmd:opencode", label: "opencode", envVar: null, hasToken: false, preset: "opencode" }] });
  expect(oc.inputs().filter(i => i.value.endsWith("opencode")).map(i => i.value)).toEqual(["cmd:opencode"]);
  oc.pick("cmd:opencode");
  oc.$("btn-auth-provider-continue").click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(oc.terminals.map(t => t.body)).toEqual([{ kind: "shell", login: "opencode" }]);
});

test("Gemini as a Command keeps its key sheet and also offers the terminal sign-in", async () => {
  const s = await sheet({ installed: ["gemini"], commands: [{ id: 2, provider: "cmd:gemini", label: "Gemini CLI", envVar: "GEMINI_API_KEY", hasToken: false, preset: "gemini" }] });
  s.pick("cmd:gemini");
  expect(s.view()).toMatchObject({ button: "Manage token", terminalButton: true });
  s.$("btn-auth-provider-continue").click();
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(s.sheets).toContain("sheet-command-token");
  s.$("btn-agent-terminal-login").click();
  expect(s.terminals.map(t => t.body)).toEqual([{ kind: "shell", login: "gemini" }]);
});

test("a registered preset that is not installed stays listed but cannot connect", async () => {
  const s = await sheet({ commands: [{ id: 1, provider: "cmd:opencode", label: "opencode", envVar: null, hasToken: false, preset: "opencode" }] });
  expect(text(s.card("cmd:opencode"))).toContain("Not installed on this server");
  expect(s.inputs().find(i => i.value === "cmd:opencode").disabled).toBe(true);
});
