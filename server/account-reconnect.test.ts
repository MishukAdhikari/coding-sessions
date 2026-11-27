import { expect, test } from "bun:test";
import { accountIdentity, createAccountReconnect, type AccountAgent, type ReconnectSession } from "./account-reconnect";

function harness() {
  let clock = 1_000;
  const ids: Record<AccountAgent, string | null> = { claude: "a@x||oauth", codex: "c@x||chatgpt", "command-code": null };
  let sessions: ReconnectSession[] = [];
  const restarted: string[] = [];
  const logs: string[] = [];
  const r = createAccountReconnect({
    identity: async agent => ids[agent],
    sessions: async () => sessions,
    restart: async id => {
      restarted.push(id);
      // A restart is a new launch of the same session.
      sessions = sessions.map(s => s.id === id ? { ...s, startedAt: clock } : s);
      return { ok: true };
    },
    log: line => logs.push(line),
    now: () => clock,
  });
  return {
    r, ids, restarted, logs,
    set: (list: ReconnectSession[]) => { sessions = list; },
    advance: (ms: number) => { clock += ms; },
    get sessions() { return sessions; },
  };
}

test("an account switch restarts that agent's older sessions; idle now, busy after their turn", async () => {
  const h = harness();
  h.set([
    { id: "m:cs-a", provider: "claude", startedAt: 0, busy: false },
    { id: "m:cs-b", provider: "claude", startedAt: 0, busy: true },
    { id: "m:cs-c", provider: "codex", startedAt: 0, busy: false },
  ]);
  await h.r.tick(); // baseline
  expect(h.restarted).toEqual([]);
  h.advance(10_000);
  h.ids.claude = "b@y||oauth";
  await h.r.tick();
  expect(h.restarted).toEqual(["m:cs-a"]);
  expect(h.r.pending()).toEqual(["m:cs-b"]);
  // Still busy: waits.
  h.advance(10_000);
  await h.r.tick();
  expect(h.restarted).toEqual(["m:cs-a"]);
  // Turn ended: restarts once.
  h.set(h.sessions.map(s => s.id === "m:cs-b" ? { ...s, busy: false } : s));
  await h.r.tick();
  await h.r.tick();
  expect(h.restarted).toEqual(["m:cs-a", "m:cs-b"]);
  expect(h.r.pending()).toEqual([]);
});

test("same account again, sign-out, first sight and sessions started after the change do not restart", async () => {
  const h = harness();
  h.set([{ id: "m:cs-a", provider: "claude", startedAt: 0, busy: false }]);
  await h.r.tick();
  h.ids.claude = null; // signed out mid-switch
  await h.r.tick();
  h.ids.claude = "a@x||oauth"; // back to the same account
  await h.r.tick();
  expect(h.restarted).toEqual([]);
  // A session launched after the change already runs under the new account.
  h.advance(5_000);
  h.set([{ id: "m:cs-new", provider: "claude", startedAt: 999_999, busy: false }]);
  h.ids.claude = "b@y||oauth";
  await h.r.tick();
  expect(h.restarted).toEqual([]);
});

test("a session that ends while waiting is dropped; terminal-only sessions are never touched", async () => {
  const h = harness();
  h.set([
    { id: "m:cs-a", provider: "codex", startedAt: 0, busy: true },
    { id: "t:raw", provider: "codex", startedAt: 0, busy: false },
  ]);
  await h.r.tick();
  h.advance(1);
  h.ids.codex = "d@x||chatgpt";
  await h.r.tick();
  expect(h.r.pending()).toEqual(["m:cs-a"]);
  h.set([]);
  await h.r.tick();
  expect(h.r.pending()).toEqual([]);
  expect(h.restarted).toEqual([]);
});

test("a replaced Command Code key reconnects without an identity change", async () => {
  const h = harness();
  h.set([{ id: "m:cs-cc", provider: "command-code", startedAt: 0, busy: false }]);
  h.advance(1);
  await h.r.changed("command-code");
  expect(h.restarted).toEqual(["m:cs-cc"]);
});

test("accountIdentity: signed in only, from email, organization and method", () => {
  expect(accountIdentity({ loggedIn: false, email: "a@x" })).toBeNull();
  expect(accountIdentity({ loggedIn: null, email: null })).toBeNull();
  expect(accountIdentity({ loggedIn: true, email: null, organization: null, authMethod: null })).toBeNull();
  expect(accountIdentity({ loggedIn: true, email: "a@x", organization: "Org", authMethod: "oauth" })).toBe("a@x|Org|oauth");
});
