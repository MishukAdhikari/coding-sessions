import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { handleTranscriptRoute, type TranscriptRouteDependencies } from "./transcript-route";

const dir = mkdtempSync(join(tmpdir(), "cs-transcript-route-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const LAUNCH = "019fb1b3-f208-73f2-ba13-0665f58ae4a0";
const SESSION = "019fb1b3-f208-73f2-8a13-0665f58ae4a9"; // v7, created 2026-07-30
const RID = "9c884e0f-ad2f-4c6f-ab73-e8c25fdc0799";

function harness() {
  const root = mkdtempSync(join(dir, "r-"));
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const sent: Array<[string, string]> = [];
  const deps: TranscriptRouteDependencies = {
    database,
    roots: { codexHome: join(root, "codex"), claudeProjects: join(root, "claude") },
    sendText: async (id, text) => { sent.push([id, text]); return { ok: true, value: true }; },
    now: () => NOW,
  };
  return { root, database, deps, sent };
}

function codexSession(h: ReturnType<typeof harness>, turnState: string, updatedAt = NOW) {
  h.database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES ('cs-cx', 'cx', '/srv/p', 0, 'codex', ?)").run(LAUNCH);
  h.database.query("INSERT INTO codex_launch_state (launch_id, screen, session_id, turn_state, canonical_cwd, updated_at) VALUES (?, 'cs-cx', ?, ?, '/srv/p', ?)")
    .run(LAUNCH, SESSION, turnState, updatedAt);
  const d = new Date(parseInt(SESSION.replace(/-/g, "").slice(0, 12), 16));
  const folder = join(h.deps.roots.codexHome, "sessions", String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `rollout-2026-07-30T12-00-00-${SESSION}.jsonl`), [
    JSON.stringify({ type: "session_meta", payload: { id: SESSION } }),
    JSON.stringify({ timestamp: "2026-07-30T12:00:01Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "hi codex" }] } }),
  ].join("\n") + "\n");
}

function claudeSession(h: ReturnType<typeof harness>, lines: unknown[]) {
  h.database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, resume_id) VALUES ('cs-cl', 'cl', '/srv/p', 0, 'claude', ?)").run(RID);
  const folder = join(h.deps.roots.claudeProjects, "-srv-p");
  mkdirSync(folder, { recursive: true });
  const text = lines.map(l => JSON.stringify(l)).join("\n") + "\n";
  writeFileSync(join(folder, `${RID}.jsonl`), text);
  return text.length;
}

const get = (id: string, query = "") => new Request(`http://x/api/sessions/${encodeURIComponent(id)}/transcript${query}`);
const post = (id: string, body: unknown) => new Request(`http://x/api/sessions/${encodeURIComponent(id)}/message`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

test("other paths are not this route's", async () => {
  const h = harness();
  expect(await handleTranscriptRoute(new Request("http://x/api/sessions"), h.deps)).toBeNull();
  expect(await handleTranscriptRoute(new Request("http://x/api/sessions/m:cs-a/ws-state"), h.deps)).toBeNull();
  expect(await handleTranscriptRoute(new Request("http://x/api/sessions/m:cs-a/transcript", { method: "DELETE" }), h.deps)).toBeNull();
});

test("an unknown session is a 404 that names no path", async () => {
  const h = harness();
  for (const id of ["m:cs-none", "e:42", "m:../../etc"]) {
    const res = (await handleTranscriptRoute(get(id), h.deps))!;
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).not.toContain("/");
    expect(body).not.toContain(h.root);
  }
});

test("a Codex session returns its messages, a cursor and its turn state, uncached", async () => {
  const h = harness();
  codexSession(h, "asking");
  const res = (await handleTranscriptRoute(get("m:cs-cx"), h.deps))!;
  expect(res.status).toBe(200);
  expect(res.headers.get("cache-control")).toContain("no-store");
  const body = await res.json() as any;
  expect(body.provider).toBe("codex");
  expect(body.state).toBe("asking");
  expect(body.messages.map((m: any) => [m.role, m.text])).toEqual([["user", "hi codex"]]);
  expect(body.cursor).toBeGreaterThan(0);
  expect(JSON.stringify(body)).not.toContain(h.root);
});

test("Codex turn state that has gone stale reads as unknown", async () => {
  const h = harness();
  codexSession(h, "asking", NOW - 60 * 60_000);
  expect(((await (await handleTranscriptRoute(get("m:cs-cx"), h.deps))!.json()) as any).state).toBe("unknown");
});

test("a bad cursor is ignored rather than trusted", async () => {
  const h = harness();
  codexSession(h, "waiting");
  for (const q of ["?after=abc", "?after=-5", "?after=1e3", "?after=99999999999999999999"]) {
    const body = await (await handleTranscriptRoute(get("m:cs-cx", q), h.deps))!.json() as any;
    expect(body.messages.length).toBe(1);
    expect(body.state).toBe("waiting");
  }
});

test("a Claude session blocked on a question stays 'asking' on polls with nothing new", async () => {
  const h = harness();
  const size = claudeSession(h, [
    { type: "user", message: { role: "user", content: "plan it" } },
    { type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [{ type: "tool_use", name: "AskUserQuestion", input: { question: "Which?" } }] } },
  ]);
  const first = await (await handleTranscriptRoute(get("m:cs-cl"), h.deps))!.json() as any;
  expect(first.state).toBe("asking");
  expect(first.cursor).toBe(size);
  const poll = await (await handleTranscriptRoute(get("m:cs-cl", `?after=${size}`), h.deps))!.json() as any;
  expect(poll.messages).toEqual([]);
  expect(poll.state).toBe("asking");
});

test("a session with no transcript yet is an empty chat", async () => {
  const h = harness();
  h.database.query("INSERT INTO launches (screen, name, project_path, created_at, provider) VALUES ('cs-fresh', 'f', '/srv/p', 0, 'claude')").run();
  const body = await (await handleTranscriptRoute(get("m:cs-fresh"), h.deps))!.json() as any;
  expect(body).toMatchObject({ provider: "claude", messages: [], cursor: 0, state: "unknown" });
});

test("a reply is typed into the session once", async () => {
  const h = harness();
  codexSession(h, "waiting");
  const res = (await handleTranscriptRoute(post("m:cs-cx", { text: "go ahead\nand test" }), h.deps))!;
  expect(res.status).toBe(200);
  expect(h.sent).toEqual([["m:cs-cx", "go ahead\nand test"]]);
});

test("empty, oversized or non-text replies are refused without typing anything", async () => {
  const h = harness();
  codexSession(h, "waiting");
  for (const body of [{ text: "" }, { text: "   " }, { text: "x".repeat(16 * 1024 + 1) }, { text: 5 }, {}]) {
    const res = (await handleTranscriptRoute(post("m:cs-cx", body), h.deps))!;
    expect(res.status).toBe(422);
  }
  expect(h.sent).toEqual([]);
});

test("a reply to a session without a chat view is refused", async () => {
  const h = harness();
  h.database.query("INSERT INTO launches (screen, name, project_path, created_at, provider) VALUES ('cs-cc', 'cc', '/srv/p', 0, 'command-code')").run();
  expect((await handleTranscriptRoute(post("m:cs-cc", { text: "hi" }), h.deps))!.status).toBe(422);
  expect((await handleTranscriptRoute(post("m:cs-gone", { text: "hi" }), h.deps))!.status).toBe(404);
  expect(h.sent).toEqual([]);
});

test("a failed send is reported", async () => {
  const h = harness();
  codexSession(h, "waiting");
  h.deps.sendText = async () => ({ ok: false, error: "That session has ended." });
  const res = (await handleTranscriptRoute(post("m:cs-cx", { text: "hi" }), h.deps))!;
  expect(res.status).toBe(422);
  expect(await res.json()).toEqual({ error: "That session has ended." });
});
