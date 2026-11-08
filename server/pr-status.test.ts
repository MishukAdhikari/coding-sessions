import { expect, test } from "bun:test";
import { createPrStatusCache, prStateOf } from "./pr-status";
import type { PullDetail } from "./repo-refs";

const URL = "https://github.com/acme/api/pull/7";
const pull = (state: string, draft = false, title = "Add PR links"): PullDetail =>
  ({ number: 7, title, branch: "b", repo: "acme/api", state, draft, crossRepo: false });

test("GitHub's states map to the card's, and anything else is unknown", () => {
  expect(prStateOf(pull("OPEN"))).toBe("open");
  expect(prStateOf(pull("OPEN", true))).toBe("draft");
  expect(prStateOf(pull("MERGED"))).toBe("merged");
  expect(prStateOf(pull("CLOSED"))).toBe("closed");
  expect(prStateOf(pull("UNKNOWN"))).toBe("unknown");
});

test("a first lookup answers unknown at once and fetches once in the background", async () => {
  let calls = 0;
  const cache = createPrStatusCache({ fetch: async () => { calls++; return { ok: true, data: pull("MERGED") }; } });
  expect(cache.get(URL)).toEqual({ state: "unknown", title: null });
  expect(cache.get(URL)).toEqual({ state: "unknown", title: null }); // the same fetch, not a second one
  await cache.settled();
  expect(calls).toBe(1);
  expect(cache.get(URL)).toEqual({ state: "merged", title: "Add PR links" });
});

test("a cached state is reused until it is old, then refreshed while the old one is shown", async () => {
  let clock = 0;
  let state = "OPEN";
  let calls = 0;
  const cache = createPrStatusCache({ now: () => clock, ttlMs: 1000, fetch: async () => { calls++; return { ok: true, data: pull(state) }; } });
  cache.get(URL); await cache.settled();
  clock = 999;
  expect(cache.get(URL).state).toBe("open");
  expect(calls).toBe(1);
  state = "MERGED"; clock = 1000;
  expect(cache.get(URL).state).toBe("open"); // stale but confirmed, while the refresh runs
  await cache.settled();
  expect(cache.get(URL).state).toBe("merged");
  expect(calls).toBe(2);
});

test("a failure is unknown, retried only after the shorter wait, and never replaces a confirmed state", async () => {
  let clock = 0;
  let fail = true;
  let calls = 0;
  const cache = createPrStatusCache({ now: () => clock, ttlMs: 1000, failureTtlMs: 100,
    fetch: async () => { calls++; return fail ? { ok: false, error: "gh: not logged in" } : { ok: true, data: pull("CLOSED") }; } });
  cache.get(URL); await cache.settled();
  expect(cache.get(URL).state).toBe("unknown");
  clock = 50; cache.get(URL); await cache.settled();
  expect(calls).toBe(1);
  clock = 100; fail = false; cache.get(URL); await cache.settled();
  expect(cache.get(URL).state).toBe("closed");
  clock = 1200; fail = true; cache.get(URL); await cache.settled();
  expect(cache.get(URL).state).toBe("closed");
});

test("a fetch that throws is unknown, not a crash", async () => {
  const cache = createPrStatusCache({ fetch: async () => { throw new Error("spawn gh ENOENT"); } });
  cache.get(URL); await cache.settled();
  expect(cache.get(URL)).toEqual({ state: "unknown", title: null });
});
