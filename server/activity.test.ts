import { test, expect } from "bun:test";
import { resolveActivity } from "./sessions";

// resolveActivity maps (high CPU?, transcript turn-state) → the user-facing flags.
// Transcript evidence decides activity; CPU remains a separate process indicator.

test("busy transcript with high CPU → working", () => {
  expect(resolveActivity(true, "busy")).toEqual({ active: true, busy: true, waiting: false, asking: false, telemetryUnknown: false });
});

test("THE FIX: low CPU but transcript busy → still working, not idle", () => {
  // ps pcpu is a lifetime average — a long-lived session mid-tool reads ~0% CPU.
  expect(resolveActivity(false, "busy")).toEqual({ active: false, busy: true, waiting: false, asking: false, telemetryUnknown: false });
});

test("done → waiting for you", () => {
  expect(resolveActivity(false, "done")).toEqual({ active: false, busy: false, waiting: true, asking: false, telemetryUnknown: false });
});

test("asking → needs your answer (and counts as waiting)", () => {
  expect(resolveActivity(false, "asking")).toEqual({ active: false, busy: false, waiting: true, asking: true, telemetryUnknown: false });
});

for (const cpuHigh of [false, true]) {
  test(`transcript wins over CPU (${cpuHigh}) for completed turns and questions`, () => {
    expect(resolveActivity(cpuHigh, "done")).toMatchObject({ busy: false, waiting: true, asking: false });
    expect(resolveActivity(cpuHigh, "asking")).toMatchObject({ busy: false, waiting: true, asking: true });
    expect(resolveActivity(cpuHigh, "unknown")).toMatchObject({ busy: false, waiting: false, telemetryUnknown: true });
  });
}
