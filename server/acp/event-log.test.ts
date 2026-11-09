import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_FIELD_CHARS, createEventWriter, readEventWindow, readState, writeState } from "./event-log";

const dirs: string[] = [];
const temp = () => { const d = mkdtempSync(join(tmpdir(), "cs-acp-log-")); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe("event log", () => {
  test("a read after an earlier cursor returns only the newer events", () => {
    const path = join(temp(), "events.jsonl");
    const w = createEventWriter(path);
    w.append("user", { text: "one" });
    const first = readEventWindow(path, null);
    w.append("update", { update: { sessionUpdate: "agent_message_chunk" } });
    w.append("turn_end", { stopReason: "end_turn" });
    w.close();
    const next = readEventWindow(path, first.cursor);
    expect(first.events.map((e) => e.seq)).toEqual([1]);
    expect(next.events.map((e) => e.kind)).toEqual(["update", "turn_end"]);
    expect(next.events.map((e) => e.seq)).toEqual([2, 3]);
    expect(next.cursor).toBe(statSync(path).size);
    expect(next.reset).toBe(false);
  });

  test("the log file is created 0600", () => {
    const path = join(temp(), "events.jsonl");
    createEventWriter(path).close();
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("a cursor past the end (a new launch replaced the log) resets to the start", () => {
    const path = join(temp(), "events.jsonl");
    const w = createEventWriter(path);
    w.append("user", { text: "fresh" });
    w.close();
    const window = readEventWindow(path, 1_000_000);
    expect(window.reset).toBe(true);
    expect(window.events.map((e) => e.text)).toEqual(["fresh"]);
  });

  test("a half-written last line is left for the next read", () => {
    const path = join(temp(), "events.jsonl");
    writeFileSync(path, '{"seq":1,"at":"x","kind":"user","text":"a"}\n{"seq":2,"at":"x","kind":"us');
    const window = readEventWindow(path, null);
    expect(window.events.length).toBe(1);
    expect(window.cursor).toBe(Buffer.byteLength('{"seq":1,"at":"x","kind":"user","text":"a"}\n'));
  });

  test("an oversized text field is cut with a marker and the line stays valid JSON", () => {
    const path = join(temp(), "events.jsonl");
    const w = createEventWriter(path);
    w.append("update", { update: { content: { text: "z".repeat(MAX_FIELD_CHARS + 500) } } });
    w.close();
    const [event] = readEventWindow(path, null).events;
    const text = (event!.update as any).content.text as string;
    expect(text.length).toBeLessThan(MAX_FIELD_CHARS + 100);
    expect(text).toContain("500 more characters not kept");
  });

  test("a missing log reads as empty", () => {
    expect(readEventWindow(join(temp(), "nope.jsonl"), null)).toEqual({ events: [], cursor: 0, reset: false });
  });
});

describe("state file", () => {
  test("round-trips and is written 0600", () => {
    const path = join(temp(), "state.json");
    writeState(path, { state: "waiting", acpSessionId: "s1", loadSession: true, agent: { name: "fake", title: null, version: "1" }, pendingPermissions: 1, error: null });
    const s = readState(path);
    expect(s).toMatchObject({ v: 1, state: "waiting", acpSessionId: "s1", loadSession: true, pendingPermissions: 1 });
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the advertised slash commands round-trip, and junk in them is dropped on read", () => {
    const path = join(temp(), "state.json");
    writeState(path, { state: "idle", acpSessionId: "s1", loadSession: false, agent: null, pendingPermissions: 0, error: null, commands: [{ name: "review", description: "Review", hint: "focus" }] });
    expect(readState(path)?.commands).toEqual([{ name: "review", description: "Review", hint: "focus" }]);
    writeFileSync(path, JSON.stringify({ state: "idle", commands: [{ name: "ok", description: "fine" }, { name: "not ok" }, 42] }));
    expect(readState(path)?.commands).toEqual([{ name: "ok", description: "fine", hint: null }]);
    writeFileSync(path, JSON.stringify({ state: "idle" }));
    expect(readState(path)?.commands).toEqual([]);
  });

  test("an unknown state or junk reads as null", () => {
    const path = join(temp(), "state.json");
    writeFileSync(path, '{"state":"dancing"}');
    expect(readState(path)).toBeNull();
    writeFileSync(path, "garbage");
    expect(readState(path)).toBeNull();
  });
});
