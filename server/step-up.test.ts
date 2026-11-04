import { expect, test } from "bun:test";
import { createStepUpGrants } from "./step-up";

test("a grant works once, for the session that earned it, before it expires", () => {
  let clock = 0;
  const grants = createStepUpGrants({ ttlMs: 1000, now: () => clock });
  const grant = grants.issue("session-a");
  expect(grants.consume(grant, "session-b")).toBe(false);
  const second = grants.issue("session-a");
  expect(grants.consume(second, "session-a")).toBe(true);
  expect(grants.consume(second, "session-a")).toBe(false);
  const late = grants.issue("session-a");
  clock = 1000;
  expect(grants.consume(late, "session-a")).toBe(false);
});

test("missing or malformed grants and sessions are refused", () => {
  const grants = createStepUpGrants();
  const grant = grants.issue("session-a");
  expect(grants.consume(undefined, "session-a")).toBe(false);
  expect(grants.consume(42, "session-a")).toBe(false);
  expect(grants.consume(grant, null)).toBe(false);
  expect(grants.consume("made-up", "session-a")).toBe(false);
});
