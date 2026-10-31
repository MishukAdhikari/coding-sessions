import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const window = {};
runInNewContext(readFileSync(new URL("../public/session-status.js", import.meta.url), "utf8"), { window });
const session = activity => ({ status: "running", activity });

test("turn changes have distinct labels without implying the session closed", () => {
  const labels = ["running", "waiting", "finished", "running"].map(activity => window.sessionStatus(session(activity)).label);
  expect(labels).toEqual(["Running", "Waiting for input", "Finished", "Running"]);
  expect(window.sessionStatus(session("finished")).detail).toContain("still open");
  expect(window.sessionStatus({ status: "ended", activity: "finished" }).label).toBe("Ended");
});

test("unknown activity stays honest and failed startup takes precedence", () => {
  expect(window.sessionStatus(session("unexpected")).label).toBe("Connected");
  expect(window.sessionStatus({ status: "starting", phase: "failed" }).label).toBe("Launch failed");
});

test("summary counts current activity instead of counting every process as running", () => {
  expect(window.sessionActivitySummary([session("running"), session("waiting"), session("finished")]))
    .toBe("1 running · 1 waiting for input · 1 finished");
  expect(window.sessionActivitySummary([])).toBe("No active sessions");
  expect(window.sessionActivitySummary([{ status: "ended" }])).toBe("No active sessions");
});

function refreshHarness() {
  const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  const pending = [];
  const renders = [];
  const context = {
    refreshVersion: 0, appliedRefreshVersion: 0, sessionSyncLost: false, sessions: [], archived: [], lastListJson: "",
    api: () => new Promise((resolve, reject) => pending.push({ resolve, reject })),
    renderHost() {}, checkAskingTransitions() {},
    renderList() { renders.push({ lost: context.sessionSyncLost, sessions: context.sessions }); },
  };
  const start = source.indexOf("  async function refresh(");
  runInNewContext(source.slice(start, source.indexOf("  /* ---------- notifications", start)), context);
  return { context, pending, renders };
}

test("a slow older API response cannot overwrite newer session activity", async () => {
  const { context, pending } = refreshHarness();
  const first = context.refresh();
  const second = context.refresh();
  pending[1].resolve({ sessions: [session("finished")] });
  await second;
  pending[0].resolve({ sessions: [session("running")] });
  await first;
  expect(context.sessions[0].activity).toBe("finished");
});

test("API failure clears confidence and identical data on recovery restores it", async () => {
  const { context, pending, renders } = refreshHarness();
  const data = { sessions: [session("running")] };
  const first = context.refresh(); pending[0].resolve(data); await first;
  const second = context.refresh(); pending[1].reject(new Error("Offline")); await second;
  expect(renders.at(-1).lost).toBe(true);
  const third = context.refresh(); pending[2].resolve(data); await third;
  expect(renders.at(-1).lost).toBe(false);
  expect(renders).toHaveLength(3);
});

test("steady slow overlapping requests still update as responses arrive", async () => {
  const { context, pending, renders } = refreshHarness();
  const requests = [context.refresh(), context.refresh(), context.refresh()];
  for (const [index, activity] of ["running", "waiting", "finished"].entries()) {
    pending[index].resolve({ sessions: [session(activity)] });
    await requests[index];
    expect(context.sessions[0].activity).toBe(activity);
  }
  expect(renders).toHaveLength(3);
});
