import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
const context: { window: { sessionMatches?: (session: Record<string, unknown>, query: string, label: string) => boolean } } = { window: {} };
runInNewContext(readFileSync(new URL("../public/session-search.js", import.meta.url), "utf8"), context);
const matches = context.window.sessionMatches;
if (!matches) throw new Error("Session search did not load");
const session = { name: "Checkout Fix", project: "/work/Storefront", projectLabel: "Shop", provider: "codex", model: "gpt-5" };
test("search combines case-insensitive terms across displayed metadata", () => {
  expect(matches(session, "  CHECKOUT   shop  ", "Codex")).toBe(true);
  expect(matches(session, "storefront gpt-5 codex", "Codex")).toBe(true);
  expect(matches(session, "checkout backend", "Codex")).toBe(false);
});
test("empty searches include all sessions and missing archive metadata is safe", () => {
  expect(matches({}, "   ", "Claude")).toBe(true);
  expect(matches({ name: "Old work", project: null }, "old claude", "Claude")).toBe(true);
  expect(matches({}, "codex", "Claude")).toBe(false);
});
test("search treats punctuation literally and includes registered agent labels", () => {
  expect(matches({ name: "fix [auth]", provider: "cmd:12" }, "[auth] custom", "Custom Agent")).toBe(true);
  expect(matches(session, ".*", "Codex")).toBe(false);
});
