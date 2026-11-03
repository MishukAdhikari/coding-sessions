import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { Communicator } from "./communicator";

const databases: Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });
function fixture(path = ":memory:") {
  const db = new Database(path); databases.push(db); applyDatabaseSchema(db);
  let now = 1_000_000;
  const live = new Set(["a", "b", "c"]);
  const communicator = new Communicator(db, {
    isLive: async identity => live.has(identity.launch_id),
    now: () => now,
    sleep: async milliseconds => { now += milliseconds; },
  });
  const add = (id: string, screen = `cs-${id}`, agent = "claude") => {
    db.query("INSERT INTO launches (screen,name,project_path,created_at,launch_id,provider) VALUES (?,?,?,?,?,?)")
      .run(screen, id, `/srv/${id}`, now, id, agent);
    return communicator.prepare(id);
  };
  const a = add("a"), b = add("b", "cs-b", "codex"), c = add("c", "cs-c", "command-code");
  return { db, communicator, live, a, b, c, add, advance: (ms: number) => { now += ms; } };
}
const payload = (recipient_id = "b", idempotency_key = "question-1") => ({ recipient_id, text: "Review this change", idempotency_key });

test("attributed message/reply exchange keeps unrelated sessions out", async () => {
  const { communicator: m, a, b, c } = fixture();
  expect((await m.peers(a.token)).map(p => p.launch_id)).toEqual(["b", "c"]);
  const sent = await m.send(a.token, payload());
  expect(sent.state).toBe("queued"); expect(sent.sender).toEqual(a.identity);
  expect((await m.read(c.token)).messages).toEqual([]);
  const inbox = await m.read(b.token);
  expect(inbox.messages.map(message => message.id)).toEqual([sent.id]);
  expect(inbox.messages[0]?.state).toBe("received");
  expect((await m.read(b.token)).messages).toEqual([]);
  expect((await m.read(a.token, { direction: "sent" })).messages[0]?.state).toBe("received");
  const reply = await m.send(b.token, { text: "Reviewed", idempotency_key: "reply-1", reply_to: sent.id });
  expect(reply.recipient).toEqual(a.identity); expect(reply.reply_to).toBe(sent.id);
  expect((await m.read(a.token)).messages[0]?.sender).toEqual(b.identity);
  await expect(m.send(c.token, { text: "spoof", idempotency_key: "x", reply_to: sent.id })).rejects.toThrow();
});

test("idempotency returns the same durable record and rejects conflicting reuse", async () => {
  const { communicator: m, a, db } = fixture();
  const first = await m.send(a.token, payload());
  expect((await m.send(a.token, payload())).id).toBe(first.id);
  const parallel = await Promise.all([m.send(a.token, payload("b", "parallel")), m.send(a.token, payload("b", "parallel"))]);
  expect(parallel[0].id).toBe(parallel[1].id);
  await expect(m.send(a.token, { ...payload(), text: "changed" })).rejects.toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM communicator_messages").get()).toEqual({ n: 2 });
});

test("invalid messages and impersonation cannot insert records", async () => {
  const { communicator: m, a, db } = fixture();
  for (const input of [payload("a"), payload("missing"), { ...payload(), sender: "c" },
    { ...payload(), text: "" }, { ...payload(), text: "🙂".repeat(4097) },
    { ...payload(), idempotency_key: "" }, { ...payload(), reply_to: "missing" }]) {
    await expect(m.send(a.token, input)).rejects.toThrow();
  }
  expect(db.query("SELECT COUNT(*) AS n FROM communicator_messages").get()).toEqual({ n: 0 });
});

test("current live launch is required; early discovery is allowed without holder", async () => {
  const { communicator: m, a, b, live, db } = fixture();
  live.delete("a");
  expect(await m.identity(a.token, false)).toEqual(a.identity);
  await expect(m.identity(a.token)).rejects.toThrow();
  await expect(m.send(a.token, payload("b", "after-replacement"))).rejects.toThrow();
  live.add("a"); live.delete("b");
  await expect(m.send(a.token, payload())).rejects.toThrow();
  db.query("UPDATE launches SET phase='failed' WHERE launch_id='a'").run();
  await expect(m.identity(a.token, false)).rejects.toThrow();
  await expect(m.identity("not-a-token")).rejects.toThrow();
  m.revoke("b"); await expect(m.identity(b.token, false)).rejects.toThrow();
});

test("same-name replacement never inherits credentials or previous mailbox", async () => {
  const { communicator: m, a, b, db, add, live } = fixture();
  await m.send(a.token, payload());
  db.query("DELETE FROM launches WHERE launch_id='b'").run();
  const replacement = add("new-b", "cs-b", "codex"); live.add("new-b");
  await expect(m.identity(b.token)).rejects.toThrow();
  expect((await m.read(replacement.token)).messages).toEqual([]);
  await expect(m.send(a.token, payload("b", "after-replacement"))).rejects.toThrow();
});

test("pagination only marks returned incoming messages received", async () => {
  const { communicator: m, a, b } = fixture();
  for (let i = 0; i < 3; i++) await m.send(a.token, payload("b", `page-${i}`));
  const first = await m.read(b.token, { limit: 2 });
  expect(first.messages).toHaveLength(2); expect(first.has_more).toBe(true);
  const rest = await m.read(b.token, { after: first.next_cursor, limit: 2 });
  expect(rest.messages).toHaveLength(1); expect(rest.has_more).toBe(false);
  expect((await m.read(b.token, { unread_only: false })).messages).toHaveLength(3);
  for (const opts of [{ limit: 101 }, { limit: 0 }, { after: -1 }, { direction: "other" }]) {
    await expect(m.read(b.token, opts)).rejects.toThrow();
  }
});

test("bounded waits query durable inbox and revalidate revoked access", async () => {
  const { communicator: m, a, b } = fixture();
  const empty = await m.wait(b.token, { timeout_seconds: 1 });
  expect(empty.timed_out).toBe(true); expect(empty.messages).toEqual([]);
  await m.send(a.token, payload());
  expect((await m.wait(b.token, { timeout_seconds: 1 })).messages).toHaveLength(1);
  await expect(m.wait(b.token, { timeout_seconds: 26 })).rejects.toThrow();
  m.revoke("b"); await expect(m.wait(b.token, { timeout_seconds: 1 })).rejects.toThrow();
});

test("launch invalidation during live checks cannot enqueue a stale sender's message", async () => {
  const { db, a } = fixture();
  const m = new Communicator(db, { isLive: async identity => {
    if (identity.launch_id === "b") db.query("DELETE FROM launches WHERE launch_id='a'").run();
    return true;
  } });
  await expect(m.send(a.token, payload())).rejects.toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM communicator_messages").get()).toEqual({ n: 0 });
});

test("a cancelled wait leaves unread messages available", async () => {
  const { communicator: m, a, b } = fixture();
  await m.send(a.token, payload());
  const controller = new AbortController(); controller.abort();
  await expect(m.wait(b.token, {}, controller.signal)).rejects.toThrow("cancelled");
  expect((await m.read(b.token)).messages).toHaveLength(1);
});

test("cancelling during a holder lookup does not consume the waiting inbox", async () => {
  const { communicator: m, a, b, db } = fixture();
  await m.send(a.token, payload());
  const controller = new AbortController();
  const waiting = new Communicator(db, { isLive: async () => { controller.abort(); return true; } });
  await expect(waiting.wait(b.token, {}, controller.signal)).rejects.toThrow("cancelled");
  expect((await m.read(b.token)).messages).toHaveLength(1);
});

test("per-source rate limit does not reject an idempotent retry", async () => {
  const { communicator: m, a, advance } = fixture();
  for (let i = 0; i < 60; i++) await m.send(a.token, payload("b", `rate-${i}`));
  await expect(m.send(a.token, payload("b", "too-many"))).rejects.toThrow();
  expect((await m.send(a.token, payload("b", "rate-0"))).text).toBe(payload().text);
  advance(60_001); expect((await m.send(a.token, payload("b", "later"))).state).toBe("queued");
});

test("pruning drops old messages and dead credentials, preserves live credentials", async () => {
  const { communicator: m, a, b, live, advance, db } = fixture();
  await m.send(a.token, payload()); live.delete("b");
  advance(31 * 86400_000); await m.prune();
  expect((await m.identity(a.token)).launch_id).toBe("a");
  await expect(m.identity(b.token, false)).rejects.toThrow();
  expect(db.query("SELECT COUNT(*) AS n FROM communicator_messages").get()).toEqual({ n: 0 });
});

test("reopening SQLite preserves active credentials and queued messages without raw tokens", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cs-mailbox-"));
  try {
    const path = join(dir, "mail.db");
    const { communicator: m, a, b, db } = fixture(path);
    await m.send(a.token, payload());
    const rows = JSON.stringify(db.query("SELECT * FROM communicator_credentials").all());
    expect(rows).not.toContain(a.token); expect(rows).not.toContain(b.token);
    databases.splice(databases.indexOf(db), 1); db.close();
    const reopened = new Database(path); databases.push(reopened); applyDatabaseSchema(reopened);
    const m2 = new Communicator(reopened, { isLive: async () => true });
    expect((await m2.read(b.token)).messages[0]?.sender.launch_id).toBe("a");
  } finally { for (const db of databases.splice(0)) db.close(); rmSync(dir, { recursive: true }); }
});

test("an idle 25-second wait bounds expensive holder inventories", async () => {
  const { db, a } = fixture();
  let time = 1_000_000;
  let inventories = 0;
  const communicator = new Communicator(db, {
    isLive: async () => { inventories++; return true; },
    now: () => time,
    sleep: async milliseconds => { time += milliseconds; },
  });
  expect((await communicator.wait(a.token, { timeout_seconds: 25 })).timed_out).toBe(true);
  expect(inventories).toBeLessThanOrEqual(26);
});
