import { expect, test } from "bun:test";
import { countActivity, createActivitySignal, handleActivityRequest } from "./activity-signal";
import { readConfig } from "./config";

test("counts working, waiting and attached terminals; ignores finished, ready and ended sessions", () => {
  const sessions = [
    { status: "running", activity: "running" },
    { status: "starting" },
    { status: "running", activity: "starting" },
    { status: "running", activity: "waiting" },
    { status: "running", activity: "finished" },
    { status: "running", activity: "ready" },
    { status: "running", activity: "connected" },
    { status: "ended", activity: "running" },
  ];
  expect(countActivity(sessions, 2)).toEqual({ working: 3, waiting: 1, terminals: 2 });
  expect(countActivity([], 0)).toEqual({ working: 0, waiting: 0, terminals: 0 });
});

test("last activity moves while anything is active and stays put when idle", async () => {
  let clock = 1_000_000;
  let counts = { working: 1, waiting: 0, terminals: 0 };
  const signal = createActivitySignal({ sample: async () => counts, now: () => clock, startedAt: 0 });

  const busy = await signal.refresh();
  expect(busy).toMatchObject({ active: true, working: 1, idle_seconds: 0, last_activity_at: new Date(1_000_000).toISOString() });

  counts = { working: 0, waiting: 0, terminals: 0 };
  clock += 90_000;
  const idle = await signal.refresh();
  expect(idle).toMatchObject({ active: false, idle_seconds: 90, last_activity_at: new Date(1_000_000).toISOString() });

  signal.touch(); // a terminal just closed
  clock += 5_000;
  expect((await signal.refresh()).idle_seconds).toBe(5);
});

test("before any activity the start time counts, and a failed sample keeps the last counts", async () => {
  let clock = 50_000;
  let fail = false;
  const signal = createActivitySignal({
    sample: async () => { if (fail) throw new Error("ps failed"); return { working: 0, waiting: 2, terminals: 0 }; },
    now: () => clock, startedAt: 10_000,
  });
  const fresh = createActivitySignal({ sample: async () => ({ working: 0, waiting: 0, terminals: 0 }), now: () => clock, startedAt: 10_000 });
  expect(await fresh.refresh()).toMatchObject({ active: false, idle_seconds: 40, last_activity_at: new Date(10_000).toISOString() });

  await signal.refresh();
  fail = true;
  clock += 1_000;
  expect(await signal.refresh()).toMatchObject({ active: true, waiting: 2, idle_seconds: 0 });
});

test("the listener serves only GET /activity, with counts and no session details", async () => {
  const signal = createActivitySignal({ sample: async () => ({ working: 1, waiting: 0, terminals: 1 }) });
  const ok = await handleActivityRequest(new Request("http://127.0.0.1:9131/activity"), signal);
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("no-store");
  expect(Object.keys(await ok.json()).sort()).toEqual(["active", "idle_seconds", "last_activity_at", "terminals", "waiting", "working"]);

  expect((await handleActivityRequest(new Request("http://127.0.0.1:9131/api/sessions"), signal)).status).toBe(404);
  expect((await handleActivityRequest(new Request("http://127.0.0.1:9131/activity", { method: "POST" }), signal)).status).toBe(405);
});

test("CS_ACTIVITY_PORT is off by default and must be a different valid port", () => {
  expect(readConfig({}).activityPort).toBeNull();
  expect(readConfig({ CS_ACTIVITY_PORT: "9131" }).activityPort).toBe(9131);
  expect(() => readConfig({ CS_ACTIVITY_PORT: "9121" })).toThrow("CS_ACTIVITY_PORT");
  expect(() => readConfig({ CS_ACTIVITY_PORT: "70000" })).toThrow("CS_ACTIVITY_PORT");
  expect(() => readConfig({ CS_ACTIVITY_PORT: "abc" })).toThrow("CS_ACTIVITY_PORT");
});
