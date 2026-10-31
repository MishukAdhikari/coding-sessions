import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const commands = source.slice(source.indexOf("  const shellQuote ="), source.indexOf("  async function copyText("));
function commandHarness(mode) {
  const state = { unrestrictedAgents: () => mode === "unrestricted", me: { mux: "screen" } };
  runInNewContext(commands, state);
  return state;
}

test("copied commands preserve standard approvals unless unrestricted mode is explicit", () => {
  for (const mode of [undefined, "standard", "unrestricted"]) {
    const h = commandHarness(mode);
    const generated = [
      h.terminalCmd("codex", "/work/project", "exact-id"),
      h.terminalCmd("claude", "/work/project", "exact-id"),
      h.terminalCmd("command-code", "/work/project", "exact-id"),
      h.managedClaudeCmd("/work/project", "exact-id", "test"),
    ];
    for (const command of generated) {
      expect(command).toContain("exact-id");
      expect(/--dangerously-|--yolo/.test(command)).toBe(mode === "unrestricted");
    }
  }
});

test("administrator-managed updates show status without unusable controls or retry advice", () => {
  const elements = new Map();
  const state = {
    cliUpdateBusy: false,
    cliUpdateState: { available: true, controllable: false, enabled: true, result: "failed", versions: {} },
    updateTime: () => "later",
    $: id => { if (!elements.has(id)) elements.set(id, { replaceChildren() {}, append() {} }); return elements.get(id); },
    document: { createElement: () => ({}) },
  };
  const render = source.slice(source.indexOf("  function renderCliUpdates()"), source.indexOf("  async function loadCliUpdates()"));
  runInNewContext(render, state);
  state.renderCliUpdates();
  expect(elements.get("chk-cli-updates").disabled).toBe(true);
  expect(elements.get("btn-cli-update-now").disabled).toBe(true);
  expect(elements.get("cli-update-status").textContent).toContain("server administrator");
  expect(elements.get("cli-update-status").textContent).not.toContain("retry with Update now");
});
