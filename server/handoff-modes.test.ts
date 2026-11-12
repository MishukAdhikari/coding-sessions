import { expect, test } from "bun:test";
import {
  COMPACT_FROM_TOKENS, HANDOFF_CLIENT_WAIT_MS, HANDOFF_POLL_MS, HANDOFF_STEP_TIMEOUT_MS, LEAN_ABOVE_TOKENS, SEARCH_MAX_BYTES, SEARCH_MAX_RESULTS, chooseHandoffMode, estimateTranscriptTokens,
  fmtTokens, isHandoffMode, leanFirstPrompt, searchTranscript, transcriptMessages,
} from "./handoff-modes";

const line = (o: object) => JSON.stringify(o);
const user = (content: unknown) => line({ type: "user", message: { role: "user", content } });
const assistant = (content: unknown) => line({ type: "assistant", message: { role: "assistant", content } });

test("auto picks full under 50k, compact to 300k, lean above; an explicit mode wins", () => {
  expect(chooseHandoffMode(0)).toBe("full");
  expect(chooseHandoffMode(COMPACT_FROM_TOKENS - 1)).toBe("full");
  expect(chooseHandoffMode(COMPACT_FROM_TOKENS)).toBe("compact");
  expect(chooseHandoffMode(180_000, "auto")).toBe("compact");
  expect(chooseHandoffMode(LEAN_ABOVE_TOKENS)).toBe("compact");
  expect(chooseHandoffMode(LEAN_ABOVE_TOKENS + 1)).toBe("lean");
  expect(chooseHandoffMode(10, "lean")).toBe("lean");
  expect(chooseHandoffMode(900_000, "full")).toBe("full");
  expect(isHandoffMode("compact")).toBe(true);
  expect(isHandoffMode("tiny")).toBe(false);
});

test("the estimate counts message text (chars/4), not signatures, metadata or history before /compact", () => {
  const text = "x".repeat(4000);
  const jsonl = [
    line({ type: "api-request-blob", data: "y".repeat(100_000) }),
    user(text),
    assistant([{ type: "thinking", thinking: "", signature: "z".repeat(50_000) }, { type: "text", text }]),
    assistant([{ type: "tool_use", name: "Bash", input: { command: "ls" } }]),
    user([{ type: "tool_result", content: [{ type: "text", text: "a.txt" }] }]),
    "not json",
  ].join("\n");
  const tokens = estimateTranscriptTokens(jsonl);
  expect(tokens).toBeGreaterThanOrEqual(2000);
  expect(tokens).toBeLessThan(2020);
  const compacted = jsonl + "\n" + line({ type: "system", subtype: "compact_boundary" }) + "\n" + user("summary: " + "s".repeat(396));
  expect(estimateTranscriptTokens(compacted)).toBe(102);
  // The whole history is still there for search.
  expect(transcriptMessages(compacted, { sinceCompact: false })).toHaveLength(5);
  expect(fmtTokens(180_400)).toBe("~180k tokens");
  expect(fmtTokens(950)).toBe("~950 tokens");
});

test("the lean first prompt points at HANDOFF.md and search_transcript, then the instruction", () => {
  const p = leanFirstPrompt("add tests");
  expect(p).toContain("HANDOFF.md");
  expect(p).toContain("search_transcript");
  expect(p.endsWith("Next instruction: add tests")).toBe(true);
  expect(leanFirstPrompt(null)).toContain("next step");
});

test("search finds phrases or all words, case-insensitively, across the whole history", () => {
  const jsonl = [
    user("The codeword is PELICAN-42, keep it."),
    assistant([{ type: "text", text: "Noted." }]),
    line({ type: "system", subtype: "compact_boundary" }),
    user("deploy failed with ECONNRESET on port 8443"),
  ].join("\n");
  expect(searchTranscript(jsonl, "pelican-42").results).toEqual([{ message: 0, role: "user", snippet: "The codeword is PELICAN-42, keep it." }]);
  expect(searchTranscript(jsonl, "8443 econnreset").results.map((r) => r.message)).toEqual([2]);
  expect(searchTranscript(jsonl, "nothing here").matches).toBe(0);
  expect(searchTranscript(jsonl, "   ").results).toEqual([]);
});

test("search is bounded: result count, snippet size and total bytes", () => {
  const many = Array.from({ length: 100 }, (_, i) => user(`${"a".repeat(2000)} needle ${i} ${"b".repeat(2000)}`)).join("\n");
  const def = searchTranscript(many, "needle");
  expect(def.results).toHaveLength(5);
  expect(def.matches).toBe(100);
  expect(def.truncated).toBe(true);
  for (const r of def.results) expect(r.snippet.length).toBeLessThan(700);
  const max = searchTranscript(many, "needle", { limit: 999 });
  expect(max.results.length).toBeLessThanOrEqual(SEARCH_MAX_RESULTS);
  const bytes = max.results.reduce((n, r) => n + Buffer.byteLength(r.snippet), 0);
  expect(bytes).toBeLessThanOrEqual(SEARCH_MAX_BYTES);
  // A huge query is cut, not echoed into a huge snippet.
  expect(searchTranscript(many, "a".repeat(5000)).results[0]!.snippet.length).toBeLessThan(1100);
});

test("both claude -p steps of a failing compact handoff finish before the client stops waiting", () => {
  // compact fails → HANDOFF.md fails → full resume: the client must still hear about it.
  expect(2 * HANDOFF_STEP_TIMEOUT_MS + 60_000).toBeLessThanOrEqual(HANDOFF_CLIENT_WAIT_MS);
  expect(Number.isInteger(HANDOFF_CLIENT_WAIT_MS / HANDOFF_POLL_MS)).toBe(true);
});
