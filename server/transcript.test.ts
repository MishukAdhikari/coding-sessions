import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyDatabaseSchema } from "./db-schema";
import { parseTranscriptLine, readTranscriptWindow, resolveTranscript, type TranscriptRoots } from "./transcript";

/* Fixture lines are shaped after real files: Codex CLI 0.146-0.167 rollouts under
   ~/.codex/sessions, and Claude Code transcripts under ~/.claude/projects. */

const codexLine = (payload: Record<string, unknown>, timestamp = "2026-11-06T16:33:14.524Z") =>
  JSON.stringify({ timestamp, type: "response_item", payload });
const codexUser = (...texts: string[]) =>
  codexLine({ type: "message", role: "user", content: texts.map(text => ({ type: "input_text", text })) });
const codexAssistant = (text: string, phase = "final_answer") =>
  codexLine({ type: "message", role: "assistant", phase, content: [{ type: "output_text", text }] });
const claudeLine = (o: Record<string, unknown>) =>
  JSON.stringify({ timestamp: "2026-11-05T08:50:13.361Z", isSidechain: false, ...o });

const dir = mkdtempSync(join(tmpdir(), "cs-transcript-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function file(name: string, lines: string[], trailingNewline = true): string {
  const path = join(dir, name);
  writeFileSync(path, lines.join("\n") + (trailingNewline ? "\n" : ""));
  return path;
}

test("Codex: shows prompts, replies and tool calls, hides injected context", () => {
  const lines = [
    JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: "x", cwd: "/p" } }),
    codexLine({ type: "message", role: "developer", content: [{ type: "input_text", text: "<permissions instructions>" }] }),
    codexUser("# AGENTS.md instructions for /p\n\n<INSTRUCTIONS>\nbe nice\n</INSTRUCTIONS>", "<environment_context>\n  <cwd>/p</cwd>\n</environment_context>"),
    codexUser("now access the production database"),
    codexLine({ type: "reasoning", summary: [], encrypted_content: "gAAAA" }),
    codexAssistant("I'll check the connection first.", "commentary"),
    codexLine({ type: "custom_tool_call", name: "exec", call_id: "c1", input: "const r = await tools.exec_command({\"cmd\":\"ls -la\"})" }),
    codexLine({ type: "custom_tool_call_output", call_id: "c1", output: "total 0" }),
    codexLine({ type: "function_call", name: "exec_command", call_id: "c2", arguments: "{\"cmd\":\"git status\"}" }),
    codexLine({ type: "function_call_output", call_id: "c2", output: "clean" }),
    JSON.stringify({ timestamp: "t", type: "event_msg", payload: { type: "token_count" } }),
    codexAssistant("Access verified."),
  ];
  const messages = lines.flatMap((line, i) => parseTranscriptLine("codex", line, i));
  expect(messages.map(m => [m.role, m.text])).toEqual([
    ["user", "now access the production database"],
    ["assistant", "I'll check the connection first."],
    ["tool", "exec ls -la"],
    ["tool", "exec_command git status"],
    ["assistant", "Access verified."],
  ]);
  expect(messages[0]!.at).toBe("2026-11-06T16:33:14.524Z");
});

test("Codex: an image part shows as a placeholder, its wrapper tags do not", () => {
  const line = codexLine({ type: "message", role: "user", content: [
    { type: "input_text", text: "<image name=[Image #1] path=\"/tmp/a.png\">" },
    { type: "input_image", image_url: "data:image/png;base64,AAAA" },
    { type: "input_text", text: "</image>" },
    { type: "input_text", text: "what is this?" },
  ] });
  expect(parseTranscriptLine("codex", line, 0).map(m => m.text)).toEqual(["[image]\n\nwhat is this?"]);
});

test("Claude: user strings and assistant text show; meta, sidechain, results and thinking do not", () => {
  const lines = [
    claudeLine({ type: "user", message: { role: "user", content: "give an announcement" } }),
    claudeLine({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: local command" } }),
    claudeLine({ type: "user", message: { role: "user", content: "<system-reminder>injected context</system-reminder>" } }),
    claudeLine({ type: "assistant", isSidechain: true, message: { role: "assistant", content: [{ type: "text", text: "subagent chatter" }] } }),
    claudeLine({ type: "assistant", message: { role: "assistant", stop_reason: "tool_use", content: [
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "Posting now." },
      { type: "tool_use", id: "t1", name: "Bash", input: { command: "echo hi", description: "say hi" } },
    ] } }),
    claudeLine({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "hi" }] } }),
    claudeLine({ type: "attachment", attachment: {} }),
    claudeLine({ type: "assistant", message: { role: "assistant", stop_reason: "end_turn", content: [{ type: "text", text: "Done." }] } }),
  ];
  const messages = lines.flatMap((line, i) => parseTranscriptLine("claude", line, i * 100));
  expect(messages.map(m => [m.role, m.text])).toEqual([
    ["user", "give an announcement"],
    ["assistant", "Posting now."],
    ["tool", "Bash echo hi"],
    ["assistant", "Done."],
  ]);
  // One line with text and tool_use yields two entries with distinct ids.
  expect(messages[1]!.id).toBe("400:0");
  expect(messages[2]!.id).toBe("400:1");
});

test("malformed lines and unknown record types are skipped", () => {
  expect(parseTranscriptLine("codex", "{not json", 0)).toEqual([]);
  expect(parseTranscriptLine("codex", JSON.stringify({ type: "world_state", full: {} }), 0)).toEqual([]);
  expect(parseTranscriptLine("claude", JSON.stringify({ type: "ai-title", title: "x" }), 0)).toEqual([]);
  expect(parseTranscriptLine("claude", "null", 0)).toEqual([]);
});

test("long text is truncated with an ellipsis", () => {
  const [assistant] = parseTranscriptLine("codex", codexAssistant("a".repeat(20_000)), 0);
  expect(assistant!.text.length).toBeLessThanOrEqual(8000);
  expect(assistant!.text.endsWith("…")).toBe(true);
  const [tool] = parseTranscriptLine("codex", codexLine({ type: "function_call", name: "exec_command", arguments: JSON.stringify({ cmd: "x".repeat(5000) }) }), 0);
  expect(tool!.text.length).toBeLessThanOrEqual(300);
});

test("window: no cursor returns the latest messages and a cursor at the last complete line", () => {
  const lines = Array.from({ length: 300 }, (_, i) => codexAssistant(`reply ${i}`));
  const path = file("many.jsonl", [...lines, codexAssistant("half-written")], false);
  const w = readTranscriptWindow(path, "codex", null);
  expect(w.reset).toBe(false);
  expect(w.messages.length).toBe(200);
  expect(w.messages[0]!.text).toBe("reply 100");
  expect(w.messages.at(-1)!.text).toBe("reply 299");
  // The trailing line has no newline yet, so it is not consumed.
  expect(w.cursor).toBe(lines.join("\n").length + 1);
});

test("window: a cursor returns only lines after it, and nothing when caught up", () => {
  const a = codexUser("first"), b = codexAssistant("second"), c = codexAssistant("third");
  const path = file("cursor.jsonl", [a, b, c]);
  const w = readTranscriptWindow(path, "codex", a.length + 1);
  expect(w.messages.map(m => m.text)).toEqual(["second", "third"]);
  expect(w.cursor).toBe(a.length + b.length + c.length + 3);
  expect(w.messages[0]!.id).toBe(`${a.length + 1}:0`);
  const idle = readTranscriptWindow(path, "codex", w.cursor);
  expect(idle.messages).toEqual([]);
  expect(idle.cursor).toBe(w.cursor);
  expect(idle.reset).toBe(false);
});

test("window: a cursor past the end of the file resets to the latest messages", () => {
  const path = file("short.jsonl", [codexAssistant("only")]);
  const w = readTranscriptWindow(path, "codex", 10_000_000);
  expect(w.reset).toBe(true);
  expect(w.messages.map(m => m.text)).toEqual(["only"]);
});

test("window: a multi-MiB tool output between two replies is skipped, not a reset", () => {
  const before = codexAssistant("before");
  const big = codexLine({ type: "function_call_output", call_id: "c", output: "x".repeat(3 * 1024 * 1024) });
  const after = codexAssistant("after");
  const path = file("big.jsonl", [before, big, after]);
  const forward = readTranscriptWindow(path, "codex", 0);
  expect(forward.reset).toBe(false);
  expect(forward.messages.map(m => m.text)).toEqual(["before", "after"]);
  expect(forward.cursor).toBe(before.length + big.length + after.length + 3);
  const fromBig = readTranscriptWindow(path, "codex", before.length + 1);
  expect(fromBig.messages.map(m => m.text)).toEqual(["after"]);
});

test("window: with no cursor, an oversized last line does not hide earlier messages", () => {
  const path = file("bigtail.jsonl", [
    codexUser("question"),
    codexAssistant("answer"),
    codexLine({ type: "compacted", message: "y".repeat(2 * 1024 * 1024) }),
  ]);
  expect(readTranscriptWindow(path, "codex", null).messages.map(m => m.text)).toEqual(["question", "answer"]);
});

test("window: a missing file reads as an empty chat", () => {
  expect(readTranscriptWindow(join(dir, "nope.jsonl"), "codex", null)).toEqual({ messages: [], cursor: 0, reset: false });
});

/* ---------- resolving a session's own transcript ---------- */

const v7 = (ms: number, tail: string) => {
  const hex = ms.toString(16).padStart(12, "0");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, "0")}`;
};
const day = (ms: number) => {
  const d = new Date(ms);
  return join(String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0"));
};

function setup() {
  const root = mkdtempSync(join(dir, "roots-"));
  const roots: TranscriptRoots = { codexHome: join(root, "codex"), claudeProjects: join(root, "claude") };
  mkdirSync(join(roots.codexHome, "sessions"), { recursive: true });
  mkdirSync(roots.claudeProjects, { recursive: true });
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  return { root, roots, database };
}

function codexLaunch(database: Database, screen: string, launchId: string, sessionId: string | null) {
  database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, launch_id) VALUES (?, ?, '/srv/p', 0, 'codex', ?)")
    .run(screen, screen, launchId);
  if (sessionId) database.query("INSERT INTO codex_launch_state (launch_id, screen, session_id, turn_state, canonical_cwd, updated_at) VALUES (?, ?, ?, 'waiting', '/srv/p', 0)")
    .run(launchId, screen, sessionId);
}

function rollout(roots: TranscriptRoots, created: number, id: string, metaId = id): string {
  const folder = join(roots.codexHome, "sessions", day(created));
  mkdirSync(folder, { recursive: true });
  const path = join(folder, `rollout-2026-01-01T00-00-00-${id}.jsonl`);
  writeFileSync(path, JSON.stringify({ timestamp: "t", type: "session_meta", payload: { id: metaId, cwd: "/srv/p" } }) + "\n" + codexAssistant(`hello from ${id}`) + "\n");
  return path;
}

const LAUNCH_A = "019fb1b3-f208-73f2-ba13-0665f58ae4a0";
const LAUNCH_B = "019fb1b3-f208-73f2-ba13-0665f58ae4a1";

test("Codex: each session resolves only its own rollout, by the id its hook reported", () => {
  const { roots, database } = setup();
  const created = Date.UTC(2026, 6, 30, 12, 0, 0);
  const a = v7(created, "aaaaaaaaaaaaaaaaaa"), b = v7(created + 1000, "bbbbbbbbbbbbbbbbbb");
  const pathA = rollout(roots, created, a), pathB = rollout(roots, created + 1000, b);
  codexLaunch(database, "cs-alpha", LAUNCH_A, a);
  codexLaunch(database, "cs-beta", LAUNCH_B, b);
  expect(resolveTranscript(database, "m:cs-alpha", roots)).toMatchObject({ ok: true, value: { provider: "codex", path: pathA } });
  expect(resolveTranscript(database, "m:cs-beta", roots)).toMatchObject({ ok: true, value: { provider: "codex", path: pathB } });
});

test("Codex: a resumed session's rollout in an old date folder still resolves", () => {
  const { roots, database } = setup();
  const created = Date.UTC(2025, 0, 15, 9, 0, 0); // long before "now"
  const id = v7(created, "cccccccccccccccccc");
  const path = rollout(roots, created, id);
  writeFileSync(path, codexAssistant("appended today") + "\n", { flag: "a" });
  codexLaunch(database, "cs-old", LAUNCH_A, id);
  expect(resolveTranscript(database, "m:cs-old", roots)).toMatchObject({ ok: true, value: { path } });
});

test("Codex: a rollout whose session_meta names another conversation is refused", () => {
  const { roots, database } = setup();
  const created = Date.UTC(2026, 6, 30, 12, 0, 0);
  const id = v7(created, "dddddddddddddddddd");
  rollout(roots, created, id, v7(created, "eeeeeeeeeeeeeeeeee"));
  codexLaunch(database, "cs-mismatch", LAUNCH_A, id);
  expect(resolveTranscript(database, "m:cs-mismatch", roots)).toMatchObject({ ok: true, value: { path: null } });
});

test("Codex: a symlinked rollout that points outside the sessions folder is refused", () => {
  const { root, roots, database } = setup();
  const created = Date.UTC(2026, 6, 30, 12, 0, 0);
  const id = v7(created, "ffffffffffffffffff");
  const outside = join(root, "elsewhere.jsonl");
  writeFileSync(outside, JSON.stringify({ type: "session_meta", payload: { id } }) + "\n");
  const folder = join(roots.codexHome, "sessions", day(created));
  mkdirSync(folder, { recursive: true });
  symlinkSync(outside, join(folder, `rollout-x-${id}.jsonl`));
  codexLaunch(database, "cs-link", LAUNCH_A, id);
  expect(resolveTranscript(database, "m:cs-link", roots)).toMatchObject({ ok: true, value: { path: null } });
});

test("Codex: before its SessionStart hook there is no transcript yet", () => {
  const { roots, database } = setup();
  codexLaunch(database, "cs-new", LAUNCH_A, null);
  expect(resolveTranscript(database, "m:cs-new", roots)).toEqual({ ok: true, value: { provider: "codex", path: null, launchId: LAUNCH_A, screen: "cs-new" } });
});

test("ids that are not this server's managed sessions resolve to nothing", () => {
  const { roots, database } = setup();
  for (const id of ["e:123", "m:../etc/passwd", "m:cs-../x", "cs-alpha", "m:cs-unknown", ""]) {
    expect(resolveTranscript(database, id, roots)).toMatchObject({ ok: false, status: 404 });
  }
});

test("agents without a verified transcript format get no chat", () => {
  const { roots, database } = setup();
  database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, resume_id) VALUES ('cs-cc', 'cc', '/srv/p', 0, 'command-code', 'abc')").run();
  expect(resolveTranscript(database, "m:cs-cc", roots)).toMatchObject({ ok: false, status: 422 });
});

test("Claude: resolves the transcript named by the launch's own resume id", () => {
  const { roots, database } = setup();
  const folder = join(roots.claudeProjects, "-srv-my-project");
  mkdirSync(folder, { recursive: true });
  const rid = "9c884e0f-ad2f-4c6f-ab73-e8c25fdc0799";
  const path = join(folder, `${rid}.jsonl`);
  writeFileSync(path, claudeLine({ type: "user", message: { role: "user", content: "hi" } }) + "\n");
  database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, resume_id) VALUES ('cs-cl', 'cl', '/srv/my.project', 0, 'claude', ?)").run(rid);
  expect(resolveTranscript(database, "m:cs-cl", roots)).toMatchObject({ ok: true, value: { provider: "claude", path } });
});

test("Claude: a resume id that tries to leave the project folder is refused", () => {
  const { roots, database } = setup();
  writeFileSync(join(roots.claudeProjects, "secret.jsonl"), "{}\n");
  database.query("INSERT INTO launches (screen, name, project_path, created_at, provider, resume_id) VALUES ('cs-evil', 'e', '/srv/p', 0, 'claude', '../secret')").run();
  expect(resolveTranscript(database, "m:cs-evil", roots)).toMatchObject({ ok: true, value: { path: null } });
});

test("a Claude Code slash command shows as typed; other injected context stays hidden", () => {
  const cmd = JSON.stringify({ type: "user", message: { role: "user", content: "<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>the retry logic</command-args>" } });
  expect(parseTranscriptLine("claude", cmd, 0).map(m => m.text)).toEqual(["/review the retry logic"]);
  const bare = JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "<command-name>clear</command-name>" }] } });
  expect(parseTranscriptLine("claude", bare, 0).map(m => m.text)).toEqual(["/clear"]);
  const injected = JSON.stringify({ type: "user", message: { content: "<system-reminder>context</system-reminder>" } });
  expect(parseTranscriptLine("claude", injected, 0)).toEqual([]);
});
