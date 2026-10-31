import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function themeHarness(stored: string | null, dark = false, blocked = false) {
  const storage = new Map(stored ? [["xs_theme", stored]] : []);
  const root = { dataset: { theme: "" } };
  const meta = { content: "" };
  const events = new Map<string, (event?: unknown) => void>();
  const picker = { value: "", addEventListener: (name: string, fn: (event?: unknown) => void) => events.set(`picker:${name}`, fn) };
  const media = { matches: dark, addEventListener: (name: string, fn: () => void) => events.set(`media:${name}`, fn) };
  runInNewContext(readFileSync(new URL("../public/theme.js", import.meta.url), "utf8"), {
    window: { matchMedia: () => media, addEventListener: (name: string, fn: (event?: unknown) => void) => events.set(name, fn) },
    localStorage: {
      getItem: (key: string) => { if (blocked) throw Error(); return storage.get(key) ?? null; },
      setItem: (key: string, value: string) => { if (blocked) throw Error(); storage.set(key, value); },
      removeItem: (key: string) => { if (blocked) throw Error(); storage.delete(key); },
    },
    document: { documentElement: root, querySelector: () => meta, getElementById: () => picker,
      addEventListener: (name: string, fn: () => void) => events.set(name, fn) },
  });
  return { root, meta, media, storage, picker,
    fire: (name: string, event?: unknown) => { const fn = events.get(name); if (!fn) throw Error(name); fn(event); } };
}

test("theme applies before DOM readiness and explicit choice survives OS changes", () => {
  const h = themeHarness("dark", false);
  expect(h.root.dataset.theme).toBe("dark");
  expect(h.meta.content).toBe("#141b20");
  h.fire("DOMContentLoaded");
  expect(h.picker.value).toBe("dark");
  h.fire("media:change");
  expect(h.root.dataset.theme).toBe("dark");
  h.fire("picker:change", { target: { value: "light" } });
  expect(h.storage.get("xs_theme")).toBe("light");
  h.media.matches = true; h.fire("media:change");
  expect(h.root.dataset.theme).toBe("light");
});

test("system follows live OS changes and cross-tab changes synchronize", () => {
  const h = themeHarness(null, true);
  h.fire("DOMContentLoaded");
  expect(h.root.dataset.theme).toBe("dark");
  h.fire("picker:change", { target: { value: "light" } });
  h.fire("picker:change", { target: { value: "system" } });
  expect(h.storage.has("xs_theme")).toBe(false);
  expect(h.root.dataset.theme).toBe("dark");
  h.media.matches = false; h.fire("media:change");
  expect(h.root.dataset.theme).toBe("light");
  h.fire("storage", { key: "xs_theme", newValue: "dark" });
  expect(h.picker.value).toBe("dark");
  h.fire("storage", { key: null, newValue: null });
  expect(h.picker.value).toBe("system");
});

test("invalid preferences and unavailable storage keep the theme usable", () => {
  expect(themeHarness("invalid", true).root.dataset.theme).toBe("dark");
  const h = themeHarness(null, false, true);
  h.fire("DOMContentLoaded");
  h.fire("picker:change", { target: { value: "dark" } });
  expect(h.root.dataset.theme).toBe("dark");
});
