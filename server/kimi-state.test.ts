import { expect, test } from "bun:test";
import { findKimiWire, kimiTurnState, type KimiFsDependencies } from "./kimi-state";

/* Record shapes from Kimi Code 2.5's own wire snapshots
   (packages/agent-core-v2/test/agent/loop/loop.test.ts), values shortened. */
const wire = (o: Record<string, unknown>) => JSON.stringify({ ...o, time: 1794200000000 });
const metadata = JSON.stringify({ type: "metadata", protocol_version: "1.5", created_at: 1794200000000, min_protocol_version: "1.5" });
const setup = wire({ type: "tools.set_active_tools", agentId: "main", names: [] });
const prompt = wire({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text: "Hello" }], origin: { kind: "user" }, promptId: "msg-1", turnId: 0 });
const started = wire({ type: "agent.turn.started", turnId: 0, queueItemId: "msg-1", kind: "event" });
const stepBegin = wire({ type: "context.append_loop_event", agentId: "main", event: { type: "step.begin", uuid: "u1", turnId: "0", step: 1 } });
const llm = wire({ type: "llm.request", agentId: "main", kind: "loop", provider: "openai", model: "mock-model", messageCount: 1, turnStep: "0.1" });
const usage = wire({ type: "usage.record", agentId: "main", model: "mock-model", usage: { inputOther: 3, output: 10 }, usageScope: "turn" });
const unknownInTurn = wire({ type: "token_counting.measured", agentId: "main", length: 2, tokens: 13 });
const approval = wire({
  type: "interaction.request", agentId: "main", id: "approval-1", kind: "approval", toolCallId: "call_lookup",
  request: { id: "approval-1", sessionId: "s", agentId: "main", turnId: 0, toolCallId: "call_lookup", toolName: "Lookup", action: "Approve Lookup" },
});
const approved = wire({ type: "interaction.resolved", agentId: "main", id: "approval-1", response: { decision: "approved", selectedLabel: "approve" } });
const question = wire({ type: "interaction.request", agentId: "main", id: "question-1", kind: "question", toolCallId: "call_q", request: { turnId: 0, questions: [] } });
const agentEnded = (outcome = "done") => wire({ type: "agent.turn.ended", turnId: 0, outcome, kind: "event" });
const turnEnded = (reason = "completed") => wire({ type: "turn.ended", agentId: "main", turnId: 0, reason });

const turnSoFar = [metadata, setup, prompt, started, stepBegin, llm];

test("a turn in progress is busy, even when its last line is a record this reader does not know", () => {
  expect(kimiTurnState([metadata, setup, prompt].join("\n"))).toBe("busy");
  expect(kimiTurnState(turnSoFar.join("\n"))).toBe("busy");
  expect(kimiTurnState([...turnSoFar, usage, unknownInTurn].join("\n"))).toBe("busy");
});

test("a finished turn is done, whatever the reason it ended", () => {
  expect(kimiTurnState([...turnSoFar, usage, agentEnded(), turnEnded()].join("\n"))).toBe("done");
  expect(kimiTurnState([...turnSoFar, agentEnded("aborted"), turnEnded("cancelled")].join("\n"))).toBe("done");
  expect(kimiTurnState([...turnSoFar, agentEnded("failed"), turnEnded("failed")].join("\n"))).toBe("done");
  expect(kimiTurnState([...turnSoFar, agentEnded()].join("\n"))).toBe("done");
});

test("an approval or question with no answer yet is asking", () => {
  expect(kimiTurnState([...turnSoFar, approval].join("\n"))).toBe("asking");
  expect(kimiTurnState([...turnSoFar, question, unknownInTurn].join("\n"))).toBe("asking");
});

test("an answered approval goes back to working, then done when the turn ends", () => {
  expect(kimiTurnState([...turnSoFar, approval, approved].join("\n"))).toBe("busy");
  expect(kimiTurnState([...turnSoFar, approval, approved, agentEnded(), turnEnded()].join("\n"))).toBe("done");
});

test("a new prompt after a finished turn is busy again", () => {
  expect(kimiTurnState([...turnSoFar, agentEnded(), turnEnded(), prompt].join("\n"))).toBe("busy");
});

test("a session with only metadata and setup, or nothing, is unknown; a truncated first line is skipped", () => {
  expect(kimiTurnState([metadata, setup].join("\n"))).toBe("unknown");
  expect(kimiTurnState("")).toBe("unknown");
  expect(kimiTurnState(['ype":"turn.prompt","agentId"', turnEnded()].join("\n"))).toBe("done");
});

/* ---------- finding the launch's session ---------- */

const HOME = "/home/me/.kimi-code";
const lock = (pid: number, startedAt: number, host = "box") =>
  JSON.stringify({ version: 1, token: `${pid}:aaaa`, pid, hostname: host, startedAt, clientIdentity: "kimi_code_cli" });
const indexLine = (sessionId: string, sessionDir: string) => JSON.stringify({ sessionId, sessionDir, workDir: "/srv/demo" });

function fakeFs(files: Record<string, string>): KimiFsDependencies {
  return {
    home: HOME,
    host: "box",
    listFiles: (dir) => Object.keys(files).filter((p) => p.startsWith(dir + "/") && !p.slice(dir.length + 1).includes("/")).map((p) => p.slice(dir.length + 1)),
    readText: (path) => files[path] ?? null,
  };
}

const sessionDir = (id: string) => `${HOME}/sessions/wd_demo_0123456789ab/${id}`;
const files = {
  [`${HOME}/locks/sessions/session_a.lock`]: lock(100, 1000),
  [`${HOME}/locks/sessions/session_b.lock`]: lock(200, 2000),
  [`${HOME}/session_index.jsonl`]: [indexLine("session_a", sessionDir("session_a")), indexLine("session_b", sessionDir("session_b"))].join("\n"),
};

test("the session is the one whose lock this launch's process holds", () => {
  expect(findKimiWire(new Set([100]), fakeFs(files))).toBe(`${sessionDir("session_a")}/agents/main/wire.jsonl`);
  expect(findKimiWire(new Set([200, 201]), fakeFs(files))).toBe(`${sessionDir("session_b")}/agents/main/wire.jsonl`);
});

test("no lock for this launch means no session yet, never another launch's", () => {
  expect(findKimiWire(new Set([300]), fakeFs(files))).toBeNull();
  expect(findKimiWire(new Set([100]), fakeFs({}))).toBeNull();
});

test("a lock held on another machine sharing the folder is ignored", () => {
  const shared = { ...files, [`${HOME}/locks/sessions/session_a.lock`]: lock(100, 1000, "other-box") };
  expect(findKimiWire(new Set([100]), fakeFs(shared))).toBeNull();
});

test("the newest of several locks held by the launch wins", () => {
  expect(findKimiWire(new Set([100, 200]), fakeFs(files))).toBe(`${sessionDir("session_b")}/agents/main/wire.jsonl`);
});

test("a session the index later marks deleted, or a malformed lock, gives no path", () => {
  const deleted = { ...files, [`${HOME}/session_index.jsonl`]: [indexLine("session_a", sessionDir("session_a")), JSON.stringify({ sessionId: "session_a", deleted: true })].join("\n") };
  expect(findKimiWire(new Set([100]), fakeFs(deleted))).toBeNull();
  const broken = { ...files, [`${HOME}/locks/sessions/session_a.lock`]: "{not json" };
  expect(findKimiWire(new Set([100]), fakeFs(broken))).toBeNull();
});
