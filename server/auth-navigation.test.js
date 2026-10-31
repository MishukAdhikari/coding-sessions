import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function harness() {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: false, disabled: false, value: "", handlers: {},
      addEventListener(event, fn) { this.handlers[event] = fn; },
      querySelectorAll: () => [], focus() {}, classList: { toggle() {} },
    });
    return elements.get(id);
  };
  const inputs = ["codex", "claude", "command-code"].map(value => ({ ...element(value), value, checked: false }));
  const window = {};
  runInNewContext(readFileSync(new URL("../public/agent-auth.js", import.meta.url), "utf8"), {
    window, document: {
      querySelectorAll: selector => selector.includes("input") ? inputs : [],
      querySelector: selector => selector.includes(":checked") ? inputs.find(input => input.checked)
        : inputs.find(input => selector.includes(input.value)),
    }, requestAnimationFrame: fn => fn(), setTimeout: fn => fn(), clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  const history = ["sheet-menu"];
  let closes = 0;
  const auth = window.createAgentAuth({
    $: element, api: async () => ({ accounts: [{ provider: "command-code", installed: true, loggedIn: false }] }),
    openSheet: id => history.push(id), closeSheet: () => { closes++; history.length = 0; },
    copyText() {}, showToast() {}, codexAuthSupported: () => true,
    commandCodeAuthSupported: () => true, capabilitiesResolved: () => true,
  });
  return { auth, element, history, closes: () => closes };
}

test("account Continue opens token setup without discarding settings ancestry", async () => {
  const h = harness();
  h.auth.openAccounts("command-code");
  await Promise.resolve(); await Promise.resolve();
  await h.element("btn-auth-provider-continue").handlers.click();
  expect(h.closes()).toBe(0);
  expect(h.history).toEqual(["sheet-menu", "sheet-agent-auth", "sheet-command-token"]);
});

test("Claude browser settings opens directly without clearing the menu history", () => {
  const h = harness();
  h.element("btn-browser-auth").handlers.click();
  expect(h.closes()).toBe(0);
  expect(h.history).toEqual(["sheet-menu", "sheet-browser"]);
});
