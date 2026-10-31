import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function harness() {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const timers = [];
  const sheets = new Map();
  const classes = () => ({ add() {}, remove() {} });
  const document = {
    body: { classList: classes() }, activeElement: null,
    querySelectorAll: () => [...sheets.values()],
    createElement: () => ({ addEventListener() {} }),
  };
  const control = parent => ({ parent, isConnected: true, focus() { document.activeElement = this; } });
  for (const id of ["sheet-menu", "sheet-projects", "sheet-agent-auth", "sheet-auth", "sheet-new", "sheet-cli-updates"]) {
    const button = { hidden: true, setAttribute(name, value) { this[name] = value; } };
    const sheet = {
      id, hidden: true, scrollTop: 0, classList: classes(),
      contains: node => node?.parent === id,
      focus() { document.activeElement = this; },
      querySelector: selector => selector === ".sheet-back" ? button : { textContent: id, before() {} },
    };
    sheets.set(id, sheet);
  }
  const scrim = { classList: classes(), hidden: true };
  const app = { inert: false };
  let dismissed = 0;
  const context = {
    document, $: id => id === "scrim" ? scrim : id === "app" ? app : sheets.get(id),
    requestAnimationFrame: fn => fn(), setTimeout: fn => timers.push(fn), clearTimeout() {},
    cliUpdatePoll: 1, agentAuth: { refreshAccounts() {}, dismissAccounts() { dismissed++; } },
  };
  const start = source.indexOf("  let openSheetEl = null;");
  runInNewContext(source.slice(start, source.indexOf('  document.addEventListener("keydown"', start)), context);
  const trigger = control("page"); trigger.focus();
  return { context, sheets, control, document, trigger, app, dismissed: () => dismissed, flush: () => timers.splice(0).forEach(fn => fn()) };
}

test("settings Back restores the originating control and scroll position", () => {
  const h = harness();
  h.context.openSheet("sheet-menu");
  const projects = h.control("sheet-menu"); projects.focus();
  h.sheets.get("sheet-menu").scrollTop = 240;
  h.context.openSheet("sheet-projects");
  expect(h.sheets.get("sheet-projects").querySelector(".sheet-back").hidden).toBe(false);
  h.context.backSheet(); h.flush();
  expect(h.sheets.get("sheet-menu").hidden).toBe(false);
  expect(h.sheets.get("sheet-menu").scrollTop).toBe(240);
  expect(h.document.activeElement).toBe(projects);
  expect(h.app.inert).toBe(true);
  expect(h.sheets.get("sheet-menu").querySelector(".sheet-back").hidden).toBe(true);
});

test("nested settings unwind one panel at a time and run dismissal cleanup", () => {
  const h = harness();
  h.context.openSheet("sheet-menu");
  h.context.openSheet("sheet-agent-auth");
  h.context.openSheet("sheet-auth");
  expect(h.dismissed()).toBe(1);
  h.context.backSheet(); h.flush();
  expect(h.sheets.get("sheet-agent-auth").hidden).toBe(false);
  h.context.backSheet(); h.flush();
  expect(h.sheets.get("sheet-menu").hidden).toBe(false);
  expect(h.dismissed()).toBe(2);
});

test("closing a settings child clears history and restores the original page trigger", () => {
  const h = harness();
  h.context.openSheet("sheet-menu");
  h.context.openSheet("sheet-cli-updates");
  h.context.closeSheet(); h.flush();
  expect(h.context.cliUpdatePoll).toBeNull();
  expect(h.document.activeElement).toBe(h.trigger);
  expect(h.app.inert).toBe(false);
  h.context.openSheet("sheet-new");
  expect(h.sheets.get("sheet-new").querySelector(".sheet-back").hidden).toBe(true);
});
