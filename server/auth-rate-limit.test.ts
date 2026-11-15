import { afterEach, expect, setSystemTime, test } from "bun:test";
import { clearRateLimit, rateLimited, rateLimitSize } from "./auth";

afterEach(() => setSystemTime());

test("a successful check clears the counter, so correct sign-ins never lock the operator out", () => {
  const key = "test:success";
  for (let i = 0; i < 20; i++) {
    expect(rateLimited(key, 5)).toBe(false);
    clearRateLimit(key);
  }
  for (let i = 0; i < 5; i++) expect(rateLimited(key, 5)).toBe(false);
  expect(rateLimited(key, 5)).toBe(true);
  clearRateLimit(key);
});

test("finished windows are forgotten instead of piling up per address", () => {
  setSystemTime(new Date("2030-01-01T00:00:00Z"));
  const before = rateLimitSize();
  for (let i = 0; i < 50; i++) rateLimited(`test:sweep:${i}`);
  expect(rateLimitSize()).toBe(before + 50);
  setSystemTime(new Date("2030-01-01T00:20:00Z"));
  rateLimited("test:sweep:later");
  expect(rateLimitSize()).toBeLessThanOrEqual(before + 1);
  clearRateLimit("test:sweep:later");
});
