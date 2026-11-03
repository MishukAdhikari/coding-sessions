import { expect, test } from "bun:test";
import { createAccountHistory } from "./account-history";

test("history remains unknown until a confirmed login and never follows a different identity", () => {
  const data = new Map<string, string>();
  let time = "2026-10-30T00:00:00Z";
  const history = createAccountHistory({ get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value); } }, () => time);
  expect(history.since("codex", "old@example.test")).toBeNull();
  history.record("codex", "one@example.test");
  expect(history.since("codex", "one@example.test")).toBe(time);
  time = "2026-10-31T00:00:00Z";
  expect(history.since("codex", "one@example.test")).toBe("2026-10-30T00:00:00Z");
  expect(history.since("codex", "two@example.test")).toBeNull();
  expect(history.since("codex", "one@example.test")).toBeNull();
  data.set("account_login_codex", JSON.stringify({ since: "invalid", identity: null }));
  expect(history.since("codex", null)).toBeNull();
  data.set("account_login_codex", "invalid JSON");
  expect(history.since("codex", null)).toBeNull();
});


test("account changes before first status cannot claim a previous login timestamp", () => {
  const data = new Map<string, string>();
  const history = createAccountHistory({ get: key => data.get(key) ?? null, set: (key, value) => { data.set(key, value); } });
  history.record("codex", "first@example.test");
  expect(history.since("codex", "second@example.test")).toBeNull();
  history.record("command-code", null);
  expect(history.since("command-code", null)).toBeNull();
  expect(history.since("command-code", "later@example.test")).toBeNull();
  data.set("account_login_codex", JSON.stringify({ since: new Date().toISOString(), identity: null }));
  expect(history.since("codex", "later@example.test")).toBeNull();
});
