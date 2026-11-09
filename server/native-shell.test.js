import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

// Without a document only the pure decisions load, exactly as they ship.
function shell() {
  const context = {};
  runInNewContext(readFileSync(new URL("../public/native.js", import.meta.url), "utf8"), context);
  return context.NativeShell;
}

test("installed-app detection reads display-mode and iOS's navigator.standalone", () => {
  const ns = shell();
  const win = (modes, standalone) => ({ navigator: { standalone }, matchMedia: (q) => ({ matches: modes.some((m) => q.includes(m)) }) });
  expect(ns.isStandalone(win(["standalone"]))).toBe(true);
  expect(ns.isStandalone(win([], true))).toBe(true);
  expect(ns.isStandalone(win(["browser"]))).toBe(false);
  expect(ns.isStandalone({})).toBe(false);
});

test("iOS Safari is told apart from other iOS browsers and from Android", () => {
  const ns = shell();
  expect(ns.isIosSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1")).toBe(true);
  expect(ns.isIosSafari("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 CriOS/130.0 Mobile/15E148 Safari/604.1")).toBe(false);
  expect(ns.isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 5)).toBe(true);
  expect(ns.isIosSafari("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15", 0)).toBe(false);
  expect(ns.isIosSafari("Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36")).toBe(false);
});

test("a quick second tap on plain chrome is blocked, never on controls or content", () => {
  const ns = shell();
  expect(ns.blocksDoubleTap({ gapMs: 180, distance: 6, allowed: false })).toBe(true);
  expect(ns.blocksDoubleTap({ gapMs: 180, distance: 6, allowed: true })).toBe(false);
  expect(ns.blocksDoubleTap({ gapMs: 300, distance: 6, allowed: false })).toBe(false);
  expect(ns.blocksDoubleTap({ gapMs: 180, distance: 30, allowed: false })).toBe(false);
  for (const selector of ["button", "input", "textarea", "a", ".md", "pre", "code"]) expect(ns.DOUBLE_TAP_ALLOWED.split(",")).toContain(selector);
});

test("pull to refresh resists, caps, and triggers at its threshold", () => {
  const ns = shell();
  expect(ns.pullDistance(-20)).toBe(0);
  expect(ns.pullDistance(40)).toBe(20);
  expect(ns.pullDistance(200)).toBe(96);
  expect(ns.pullTriggered(64)).toBe(true);
  expect(ns.pullTriggered(63)).toBe(false);
  expect(ns.pullTriggered(ns.pullDistance(127))).toBe(false);
  expect(ns.pullTriggered(ns.pullDistance(128))).toBe(true);
});

test("a sheet closes when dragged a quarter of its height or flicked down", () => {
  const ns = shell();
  expect(ns.sheetShouldDismiss({ dy: 160, velocity: 0.1, height: 600 })).toBe(true);
  expect(ns.sheetShouldDismiss({ dy: 120, velocity: 0.1, height: 600 })).toBe(false);
  expect(ns.sheetShouldDismiss({ dy: 60, velocity: 0.8, height: 600 })).toBe(true);
  expect(ns.sheetShouldDismiss({ dy: 10, velocity: 2, height: 600 })).toBe(false);
  expect(ns.sheetShouldDismiss({ dy: -200, velocity: 3, height: 600 })).toBe(false);
});

test("the keyboard height applies only when a keyboard really covers the page", () => {
  const ns = shell();
  expect(ns.keyboardViewport({ innerHeight: 844, vvHeight: 500.4 })).toBe(500);
  expect(ns.keyboardViewport({ innerHeight: 844, vvHeight: 764 })).toBeNull();
  expect(ns.keyboardViewport({ innerHeight: 844, vvHeight: 0 })).toBeNull();
});

test("Enter sends from a hardware keyboard and starts a line on a soft one", () => {
  const ns = shell();
  expect(ns.enterSends({ softKeyboard: false, shift: false, composing: false })).toBe(true);
  expect(ns.enterSends({ softKeyboard: true, shift: false, composing: false })).toBe(false);
  expect(ns.enterSends({ softKeyboard: false, shift: true, composing: false })).toBe(false);
  expect(ns.enterSends({ softKeyboard: false, shift: false, composing: true })).toBe(false);
});

test("the install hint shows once, and only where installing is possible", () => {
  const ns = shell();
  expect(ns.installHintKind({ standalone: true, dismissed: false, hasPrompt: true, iosSafari: false })).toBeNull();
  expect(ns.installHintKind({ standalone: false, dismissed: true, hasPrompt: true, iosSafari: false })).toBeNull();
  expect(ns.installHintKind({ standalone: false, dismissed: false, hasPrompt: true, iosSafari: false })).toBe("prompt");
  expect(ns.installHintKind({ standalone: false, dismissed: false, hasPrompt: false, iosSafari: true })).toBe("ios");
  expect(ns.installHintKind({ standalone: false, dismissed: false, hasPrompt: false, iosSafari: false })).toBeNull();
});

test("a history step maps to closing sheets or stepping back through them", () => {
  const ns = shell();
  expect(ns.historyTarget(2, 1)).toEqual({ action: "back", steps: 1 });
  expect(ns.historyTarget(3, 1)).toEqual({ action: "back", steps: 2 });
  expect(ns.historyTarget(2, 0)).toEqual({ action: "close" });
  expect(ns.historyTarget(1, 1)).toEqual({ action: "none" });
  expect(ns.historyTarget(0, 1)).toEqual({ action: "none" });
});

test("passkey autofill starts only where it can work", () => {
  const ns = shell();
  expect(ns.passkeyAutofillPlan({ supported: true, hasPasskey: true, setupToken: null })).toBe(true);
  expect(ns.passkeyAutofillPlan({ supported: false, hasPasskey: true, setupToken: null })).toBe(false);
  expect(ns.passkeyAutofillPlan({ supported: true, hasPasskey: false, setupToken: null })).toBe(false);
  expect(ns.passkeyAutofillPlan({ supported: true, hasPasskey: true, setupToken: "abc" })).toBe(false);
});

test("closing a screen goes back in the app, closes its own tab, or loads the list", () => {
  const ns = shell();
  expect(ns.closeTarget({ referrerSameOrigin: true, historyLength: 2, opened: false })).toBe("back");
  expect(ns.closeTarget({ referrerSameOrigin: true, historyLength: 1, opened: true })).toBe("close");
  expect(ns.closeTarget({ referrerSameOrigin: false, historyLength: 3, opened: false })).toBe("list");
});

test("every page loads the shell and disables zoom in its viewport", () => {
  for (const page of ["index.html", "chat.html", "term.html"]) {
    const html = readFileSync(new URL(`../public/${page}`, import.meta.url), "utf8");
    const viewport = html.match(/<meta name="viewport" content="([^"]+)"/)?.[1] ?? "";
    for (const part of ["width=device-width", "initial-scale=1", "maximum-scale=1", "user-scalable=no", "viewport-fit=cover"]) expect(viewport).toContain(part);
    expect(html).toMatch(/<script src="\/native\.js\?v=\d+"><\/script>/);
    expect(html.indexOf("/theme.js")).toBeLessThan(html.indexOf("/native.js"));
  }
});
