import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrLinkTracker, extractPrLinks, extractTranscriptPrLinks, mergePrLinks } from "./pr-links";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function transcript(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "pr-links-"));
  dirs.push(dir);
  const path = join(dir, "t.jsonl");
  writeFileSync(path, text);
  return path;
}

test("finds PR links in transcript lines, in order of their last mention", () => {
  const text = [
    JSON.stringify({ type: "tool_result", content: "https://github.com/acme/api/pull/12\n" }),
    JSON.stringify({ text: "Opened https://github.com/MishukAdhikari/coding-sessions/pull/40." }),
    '{"escaped":"https:\\/\\/github.com\\/acme\\/web\\/pull\\/7"}',
    "and again https://github.com/acme/api/pull/12/files",
  ].join("\n");
  expect(extractPrLinks(text).map(link => link.url)).toEqual([
    "https://github.com/MishukAdhikari/coding-sessions/pull/40",
    "https://github.com/acme/web/pull/7",
    "https://github.com/acme/api/pull/12",
  ]);
  expect(extractPrLinks(text)[0]).toEqual({ url: "https://github.com/MishukAdhikari/coding-sessions/pull/40", repo: "MishukAdhikari/coding-sessions", number: 40 });
});

test("ignores issues, other hosts and look-alikes", () => {
  const text = "https://github.com/acme/api/issues/3 https://gitlab.com/acme/api/pull/4 http://github.com/acme/api/pull/5 https://github.com.evil.io/acme/api/pull/6";
  expect(extractPrLinks(text)).toEqual([]);
});

test("in a transcript, PRs from tool output and the agent's words count; links in code it writes do not", () => {
  const lines = [
    JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { content: "see https://github.com/acme/test/pull/1" } }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "https://github.com/acme/api/pull/40\n" }] } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call", arguments: "{\"cmd\":\"echo https://github.com/acme/test/pull/2\"}" } }),
    JSON.stringify({ type: "response_item", payload: { type: "function_call_output", output: "https://github.com/acme/web/pull/7" } }),
    JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "Opened https://github.com/acme/api/pull/41" }] } }),
    JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", content: "File created" }] }, toolUseResult: { content: "https://github.com/acme/test/pull/3" } }),
    "not json https://github.com/acme/raw/pull/3",
  ].join("\n");
  expect(extractTranscriptPrLinks(lines).map(l => `${l.repo}#${l.number}`)).toEqual(["acme/api#40", "acme/web#7", "acme/api#41", "acme/raw#3"]);
});

test("merging puts the newest first, keeps the rest and caps the list", () => {
  const link = (n: number) => ({ url: `https://github.com/a/b/pull/${n}`, repo: "a/b", number: n });
  expect(mergePrLinks([link(1), link(2)], [link(3), link(1)], 3).map(l => l.number)).toEqual([1, 3, 2]);
  expect(mergePrLinks([], [link(1), link(2), link(3), link(4)], 3).map(l => l.number)).toEqual([4, 3, 2]);
});

test("the tracker reads only what was written since the last poll, and starts over when the file shrinks", () => {
  const tracker = createPrLinkTracker();
  const path = transcript("nothing yet\n");
  expect(tracker.linksFor(path)).toEqual([]);
  appendFileSync(path, "created https://github.com/acme/api/pull/1\n");
  expect(tracker.linksFor(path).map(l => l.number)).toEqual([1]);
  appendFileSync(path, "x".repeat(10_000) + " https://github.com/acme/api/pull/2\n");
  expect(tracker.linksFor(path).map(l => l.number)).toEqual([2, 1]);
  writeFileSync(path, "fresh https://github.com/acme/api/pull/9\n");
  expect(tracker.linksFor(path).map(l => l.number)).toEqual([9]);
});

test("a first read looks only at the end of a long transcript; a missing file gives none", () => {
  const tracker = createPrLinkTracker({ firstReadBytes: 1024 });
  const path = transcript("old https://github.com/acme/api/pull/1\n" + "x".repeat(4096) + "\nnew https://github.com/acme/api/pull/2\n");
  expect(tracker.linksFor(path).map(l => l.number)).toEqual([2]);
  expect(tracker.linksFor(join(tmpdir(), "no-such-transcript.jsonl"))).toEqual([]);
  expect(tracker.linksFor(null)).toEqual([]);
});

test("an unfinished last line waits for the next poll, so a tool input cut in two is never read as text", () => {
  const tracker = createPrLinkTracker();
  const line = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", input: { content: "https://github.com/acme/test/pull/1" } }] } });
  const path = transcript(line.slice(0, 60));
  expect(tracker.linksFor(path)).toEqual([]);
  appendFileSync(path, line.slice(60) + "\n" + JSON.stringify({ type: "tool_result", content: "https://github.com/acme/api/pull/5" }) + "\n");
  expect(tracker.linksFor(path).map(l => l.number)).toEqual([5]);
});
