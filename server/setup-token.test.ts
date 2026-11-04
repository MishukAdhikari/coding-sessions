import { expect, test } from "bun:test";
import { consumeSetupToken, createSetupToken, SETUP_TOKEN_TTL_MS } from "./setup-token";

function memory() {
  const data = new Map<string, string>();
  return { data, get: (k: string) => data.get(k) ?? null, set: (k: string, v: string) => { data.set(k, v); }, delete: (k: string) => { data.delete(k); } };
}

test("a setup token works once, and only a hash of it is stored", () => {
  const store = memory();
  const token = createSetupToken(store, 1000);
  expect(token).toMatch(/^cssetup_[A-Za-z0-9_-]{43}$/);
  expect([...store.data.values()].join("")).not.toContain(token.slice(8));
  expect(consumeSetupToken(store, token, 2000)).toBe(true);
  expect(consumeSetupToken(store, token, 2000)).toBe(false);
});

test("expired, wrong, malformed and replaced tokens are refused", () => {
  const store = memory();
  const old = createSetupToken(store, 0);
  expect(consumeSetupToken(store, old, SETUP_TOKEN_TTL_MS + 1)).toBe(false);
  const first = createSetupToken(store, 0);
  const second = createSetupToken(store, 0);
  expect(consumeSetupToken(store, first, 1)).toBe(false);
  expect(consumeSetupToken(store, `cssetup_${"A".repeat(43)}`, 1)).toBe(false);
  expect(consumeSetupToken(store, "nope", 1)).toBe(false);
  expect(consumeSetupToken(store, 42, 1)).toBe(false);
  // A wrong guess does not burn the real token.
  expect(consumeSetupToken(store, second, 1)).toBe(true);
});
