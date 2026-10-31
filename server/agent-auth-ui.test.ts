import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

test("a dismissed account switch cannot close a newer sheet or reopen sign-in", async () => {
  for (const reopen of [false, true]) {
    let resolveSwitch!: (value: unknown) => void;
    const pending = new Promise(resolve => { resolveSwitch = resolve; });
    interface FakeElement {
      hidden: boolean; disabled: boolean; value: string;
      handlers: Record<string, () => unknown>;
      addEventListener(event: string, fn: () => unknown): void;
      querySelectorAll(): never[]; focus(): void; classList: { toggle(): void };
    }
    interface Auth { openAccounts(provider: string): void; dismissAccounts(): void }
    const elements = new Map<string, FakeElement>();
    const element = (id: string) => {
      if (!elements.has(id)) elements.set(id, { hidden: false, disabled: false, value: "", handlers: {},
        addEventListener(event: string, fn: () => unknown) { this.handlers[event] = fn; },
        querySelectorAll: () => [], focus() {}, classList: { toggle() {} } });
      return elements.get(id)!;
    };
    const inputs = ["codex", "claude"].map(value => ({ ...element(value), value, checked: false }));
    const account = { provider: "codex", installed: true, loggedIn: true, email: "test@example.test" };
    const window: { createAgentAuth?: (dependencies: unknown) => Auth } = {};
    runInNewContext(readFileSync(new URL("../public/agent-auth.js", import.meta.url), "utf8"), {
      window, document: {
        querySelectorAll: (selector: string) => selector.includes("input") ? inputs : [],
        querySelector: (selector: string) => selector.includes(":checked") ? inputs.find(i => i.checked)
          : inputs.find(i => selector.includes(i.value)),
      }, requestAnimationFrame: (fn: () => void) => fn(), setTimeout, clearTimeout, setInterval, clearInterval,
    });
    if (!window.createAgentAuth) throw new Error("Authentication factory did not load");
    let currentSheet: string | null = null;
    const auth = window.createAgentAuth({ $: element,
      api: async (_: string, options?: { method: string }) => options?.method === "POST" ? pending : { accounts: [account] },
      openSheet: (id: string) => { currentSheet = id; },
      closeSheet: () => { currentSheet = null; auth.dismissAccounts(); },
      copyText() {}, showToast() {}, codexAuthSupported: () => true,
      commandCodeAuthSupported: () => true, capabilitiesResolved: () => true,
    });
    auth.openAccounts("codex");
    await Promise.resolve(); await Promise.resolve();
    const transition = element("btn-auth-provider-continue").handlers.click!();
    auth.dismissAccounts();
    currentSheet = null;
    if (reopen) auth.openAccounts("claude");
    resolveSwitch({ ok: true });
    await transition;
    expect<string | null>(currentSheet).toBe(reopen ? "sheet-agent-auth" : null);
  }
});
