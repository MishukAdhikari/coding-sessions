import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { createDocument, loadBody } from "./chat-test-dom.js";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const handler = source.slice(source.indexOf('  $("btn-new").addEventListener'), source.indexOf('  /* ---------- repo & branch picker'));
function harness(repository = "") {
  const elements = new Map();
  const requests = [];
  const state = { projects: [], selectedProject: null, FRESH_DEFAULT: "fresh", defaultRepository: () => repository, showSharedFolders: false,
    chosenRepo: null, chosenBranch: null, branchList: [], branchToken: 0, launchDrawerRequest: 0,
    openSheetEl: null, reposLoading: false, allRepos: [], renders: 0, opens: 0,
    $: id => {
      if (!elements.has(id)) elements.set(id, { value: "", hidden: false, textContent: "", addEventListener: (_, fn) => { state.click = fn; } });
      return elements.get(id);
    },
    api: path => new Promise((resolve, reject) => requests.push({ path, resolve, reject })),
    renderPicker: () => { state.renders++; }, updateProviderAvailability() {}, updateNamePreview() {}, renderRepoResults() {},
    launchProviderInputs: () => [], loadPrefix: () => Promise.resolve(), requestAnimationFrame: fn => fn(),
    openSheet: id => { state.openSheetEl = { id }; state.opens++; },
    modeCalls: [],
    launchMode: { reset() { state.modeCalls.push("reset"); }, refresh() { state.modeCalls.push("refresh"); }, update() {}, value: () => "terminal" },
  };
  runInNewContext(handler, state);
  return { state, requests, elements };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test("drawer opens before projects respond and late data preserves user input", async () => {
  const h = harness(); h.state.click();
  expect(h.state.openSheetEl.id).toBe("sheet-new");
  expect(h.requests.map(r => r.path)).toEqual(["/api/projects", "/api/repos"]);
  h.elements.get("input-name").value = "my-work";
  h.state.selectedProject = "chosen";
  h.requests[0].resolve({ projects: [{ id: 1 }] }); await flush();
  expect(h.state.projects).toEqual([{ id: 1 }]);
  expect(h.elements.get("input-name").value).toBe("my-work");
  expect(h.state.selectedProject).toBe("chosen");
});
test("closing or reopening ignores old project and repository responses", async () => {
  const h = harness(); h.state.click(); h.state.openSheetEl = null;
  h.requests[0].resolve({ projects: [{ id: "closed" }] }); await flush();
  expect(h.state.projects).toEqual([]);
  h.state.click(); h.state.click();
  h.requests[2].resolve({ projects: [{ id: "stale" }] });
  h.requests[3].resolve({ repos: ["stale"] }); await flush();
  expect(h.state.projects).toEqual([]); expect(h.state.allRepos).toEqual([]);
  expect(h.state.opens).toBe(3);
});
test("failed project loading leaves the drawer usable with an explanation", async () => {
  const h = harness(); h.state.click(); h.requests[0].reject(Error("offline")); await flush();
  expect(h.state.openSheetEl.id).toBe("sheet-new");
  expect(h.elements.get("project-load-status").textContent).toContain("Fresh workspaces are still available");
});

test("without a configured default the drawer immediately exposes shared folders and repos", () => {
  const h = harness(); h.state.click();
  expect(h.state.selectedProject).toBeNull();
  expect(h.state.showSharedFolders).toBe(true);
});
test("a configured default keeps the fresh workspace shortcut", () => {
  const h = harness("example/project"); h.state.click();
  expect(h.state.selectedProject).toBe("fresh");
  expect(h.state.showSharedFolders).toBe(false);
});

test("opening the drawer resets the launch mode to Terminal and asks the server which agents can chat", () => {
  const h = harness(); h.state.click();
  expect(h.state.modeCalls).toEqual(["reset", "refresh"]);
});

/* ---------- launch mode: Terminal or Chat (ACP) ---------- */

const launchModeSource = readFileSync(new URL("../public/launch-mode.js", import.meta.url), "utf8");
const indexHtml = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const AGENTS = { agents: [
  { provider: "claude", label: "Claude", available: true, reason: null },
  { provider: "codex", label: "Codex", available: false, reason: "Codex chat needs the ACP adapter codex-acp. Install it with: npm install -g @agentclientprotocol/codex-acp" },
  { provider: "cmd:aider", label: "Aider", available: false, reason: "Chat mode needs an agent registered from a preset (Gemini, Qwen, opencode or Kimi)." },
] };

/** launch-mode.js against the sheet's real markup. */
function modeHarness(load = () => Promise.resolve(AGENTS)) {
  const document = loadBody(createDocument(), indexHtml);
  const context = { document, Promise, Array };
  context.window = context;
  runInNewContext(launchModeSource, context);
  const changes = [];
  const mode = context.LaunchMode.create(document, { load, onChange: (value) => changes.push(value) });
  const $ = (id) => document.getElementById(id);
  const choose = (id) => {
    $("launch-mode-terminal").checked = id === "launch-mode-terminal";
    $("launch-mode-acp").checked = id === "launch-mode-acp";
    $(id).dispatch("change");
  };
  return { mode, $, choose, changes, LaunchMode: context.LaunchMode };
}

test("the sheet offers Terminal and Chat, with Terminal chosen and Chat off until the server answers", () => {
  const h = modeHarness(() => new Promise(() => {}));
  expect(h.$("launch-mode-terminal").checked).toBe(true);
  expect(h.$("launch-mode-acp").disabled).toBe(true);
  h.mode.refresh();
  h.mode.update({ provider: "claude", workspace: false });
  expect(h.$("launch-mode-acp").disabled).toBe(true);
  expect(h.$("launch-mode-note").textContent).toContain("Checking");
  expect(h.mode.value()).toBe("terminal");
});

test("Chat is enabled per agent from /api/acp/agents", async () => {
  const h = modeHarness();
  await h.mode.refresh();
  h.mode.update({ provider: "claude", workspace: false });
  expect(h.$("launch-mode-acp").disabled).toBe(false);
  expect(h.$("launch-mode-note").hidden).toBe(true);
  h.choose("launch-mode-acp");
  expect(h.mode.value()).toBe("acp");
  expect(h.changes).toEqual(["acp"]);
});

test("an agent without ACP support disables Chat with the server's reason, and switching back re-enables it", async () => {
  const h = modeHarness();
  await h.mode.refresh();
  h.mode.update({ provider: "claude", workspace: false });
  h.choose("launch-mode-acp");
  h.mode.update({ provider: "codex" });
  expect(h.$("launch-mode-acp").disabled).toBe(true);
  expect(h.$("launch-mode-terminal").checked).toBe(true);
  expect(h.mode.value()).toBe("terminal");
  expect(h.$("launch-mode-note").hidden).toBe(false);
  expect(h.$("launch-mode-note").textContent).toContain("npm install -g @agentclientprotocol/codex-acp");
  h.mode.update({ provider: "cmd:aider" });
  expect(h.$("launch-mode-note").textContent).toContain("registered from a preset");
  h.mode.update({ provider: "cmd:unknown" });
  expect(h.$("launch-mode-note").textContent).toBe("This agent can't run as a chat.");
  h.mode.update({ provider: "claude" });
  expect(h.$("launch-mode-acp").disabled).toBe(false);
});

test("a fresh workspace launch disables Chat with the reason", async () => {
  const h = modeHarness();
  await h.mode.refresh();
  h.mode.update({ provider: "claude", workspace: false });
  h.choose("launch-mode-acp");
  h.mode.update({ workspace: true });
  expect(h.$("launch-mode-acp").disabled).toBe(true);
  expect(h.mode.value()).toBe("terminal");
  expect(h.$("launch-mode-note").textContent).toBe(h.LaunchMode.WORKSPACE_REASON);
  h.mode.update({ workspace: false });
  expect(h.$("launch-mode-acp").disabled).toBe(false);
});

test("when the agents list can't load, Chat stays off and Terminal is still offered", async () => {
  const h = modeHarness(() => Promise.reject(new Error("offline")));
  await h.mode.refresh();
  h.mode.update({ provider: "claude", workspace: false });
  expect(h.$("launch-mode-acp").disabled).toBe(true);
  expect(h.$("launch-mode-note").textContent).toContain("Terminal is available");
});

/* ---------- the launch request and the chat link ---------- */

const submitHandler = source.slice(source.indexOf('  $("form-new").addEventListener("submit"'), source.indexOf("  /* ---------- end session"));

function submitHarness({ mode = "terminal", project = 7, repo = null, provider = "claude" } = {}) {
  const posts = [];
  const toasts = [];
  let submit;
  const elements = { "form-new": { addEventListener: (_, fn) => { submit = fn; } }, "input-name": { value: "fix-login" }, "input-repo": { value: "" }, "chk-remote-control": { checked: true } };
  const context = {
    $: (id) => elements[id], launchPending: false, BUILTIN_PROVIDERS: ["claude", "codex", "command-code"], builtinSupported: () => true,
    selectedLaunchProvider: () => provider, chosenRepo: repo, chosenBranch: null, selectedProject: project, FRESH_DEFAULT: "__fresh_default",
    defaultRepository: () => "", providerHas: (p, cap) => p === "claude" && cap === "remoteControl", providerName: (p) => ({ claude: "Claude", codex: "Codex" })[p] || p,
    showToast: (t) => toasts.push(t), closeSheet() {}, refresh() {}, setTimeout() {}, updateProviderSelection() {},
    launchMode: { value: () => mode },
    api: async (path, options) => { posts.push({ path, body: JSON.parse(options.body) }); return { ok: true }; },
    JSON,
  };
  runInNewContext(submitHandler, context);
  const run = () => submit({ preventDefault() {}, target: { querySelector: () => ({ disabled: false }) } });
  return { run, posts, toasts };
}

test("a Chat launch posts mode acp without remote control", async () => {
  const h = submitHarness({ mode: "acp" });
  await h.run();
  expect(h.posts).toEqual([{ path: "/api/sessions", body: { name: "fix-login", projectId: 7, provider: "claude", remoteControl: false, mode: "acp" } }]);
  expect(h.toasts[0]).toContain("starting as a chat");
});

test("a Terminal launch posts no mode, exactly as before", async () => {
  const h = submitHarness();
  await h.run();
  expect(h.posts[0].body).toEqual({ name: "fix-login", projectId: 7, provider: "claude", remoteControl: true });
});

test("a repository launch never carries Chat mode", async () => {
  const h = submitHarness({ mode: "acp", project: null, repo: "owner/app" });
  await h.run();
  expect(h.posts[0].body).toEqual({ name: "fix-login", repo: "owner/app", provider: "claude", remoteControl: true });
});

test("an ACP session's chat link opens the chat page in ACP mode", () => {
  const start = source.indexOf("  function chatUrl(");
  const fn = source.slice(start, source.indexOf("\n  }\n", start) + 4);
  const context = { URLSearchParams, providerName: (p) => ({ claude: "Claude", codex: "Codex" })[p] };
  runInNewContext(`${fn}\nthis.chatUrl = chatUrl;`, context);
  const acp = new URL(context.chatUrl({ id: "m:cs-fix", name: "fix", mode: "acp" }, "codex"), "https://cs.example");
  expect(acp.pathname).toBe("/chat.html");
  expect(Object.fromEntries(acp.searchParams)).toEqual({ id: "m:cs-fix", name: "fix", mode: "acp", agent: "Codex" });
  const transcript = new URL(context.chatUrl({ id: "m:cs-fix", name: "fix", mode: "terminal" }, "claude"), "https://cs.example");
  expect(Object.fromEntries(transcript.searchParams)).toEqual({ id: "m:cs-fix", name: "fix" });
});
