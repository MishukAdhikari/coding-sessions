import { expect, test } from "bun:test";
import { displayInitialFor, rememberPrefix } from "./display-initial";

test("the letter skips whichever earlier prefix the name was launched with", () => {
  const prefixes = ["k", "n-"];
  expect(displayInitialFor("n-ai-assistant-improvemts", prefixes)).toBe("A");
  expect(displayInitialFor("n-code-review-findings", prefixes)).toBe("C");
  expect(displayInitialFor("kfix-login", prefixes)).toBe("F");
});

test("names without a known prefix keep their own first letter", () => {
  expect(displayInitialFor("nobins-dm", ["n-"])).toBe("N");
  expect(displayInitialFor("presentation", ["k", "n-"])).toBe("P");
});

test("the longest matching prefix wins, and a bare prefix still shows a letter", () => {
  expect(displayInitialFor("cx-nova-import", ["c", "cx-"])).toBe("N");
  expect(displayInitialFor("n-", ["n-"])).toBe("N");
});

test("remembered prefixes are newest first, unique and bounded", () => {
  expect(rememberPrefix(["n-"], "k")).toEqual(["k", "n-"]);
  expect(rememberPrefix(["k", "n-"], "N-")).toEqual(["N-", "k"]);
  expect(rememberPrefix(["k"], "")).toEqual(["k"]);
  expect(rememberPrefix(Array.from({ length: 25 }, (_, i) => `p${i}`), "new")).toHaveLength(20);
});
