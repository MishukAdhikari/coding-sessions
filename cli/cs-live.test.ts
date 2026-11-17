import { expect, test } from "bun:test";
import { boardGroup, boardSummary, firstSentences, liveBackoffMs, liveSocketUrl, newLiveRenderState, parseHandoffArgs, parseServerArgs, plainText, prLabels, renderBoard, renderLiveFrame, RUN, wrapIndented, type BoardItem } from "./cs-lib";

test("cs --live and cs live pick the live subcommand", () => {
  expect(parseServerArgs(["--live"])).toEqual({ sub: "live", args: [], server: undefined });
  expect(parseServerArgs(["--live", "fix", "--json"])).toEqual({ sub: "live", args: ["fix", "--json"], server: undefined });
  expect(parseServerArgs(["live", "fix"])).toMatchObject({ sub: "live", args: ["fix"] });
  expect(parseServerArgs(["-S", "lab", "--live", "fix"])).toMatchObject({ sub: "live", args: ["fix"], server: "lab" });
  expect(parseServerArgs(["--server=lab", "--live"])).toMatchObject({ sub: "live", server: "lab" });
});

test("--live after --server stays a run flag; handoff takes --live", () => {
  expect(parseServerArgs(["--server", "--live", "fix it"])).toEqual({ sub: RUN, args: ["--server", "--live", "fix it"], server: undefined });
  const h = parseHandoffArgs(["fix", "--live", "carry on"]);
  expect(h).toMatchObject({ name: "fix", live: true, instruction: "carry on" });
  expect(h.error).toBeUndefined();
});

test("the renderer prints one compact line per frame and never repeats itself", () => {
  const st = newLiveRenderState();
  const r = (f: any) => renderLiveFrame(f, st);
  expect(r({ type: "hello", name: "fix", provider: "claude", mode: "terminal" })).toContain("live: fix (claude)");
  expect(r({ type: "hello", name: "fix", provider: "claude", mode: "terminal" })).toBeNull();
  expect(r({ type: "state", activity: "running" })).toBe("◇ running");
  expect(r({ type: "state", activity: "running" })).toBeNull();
  expect(r({ type: "tool", text: "Bash npm test" })).toBe("  ⚙ Bash npm test");
  expect(r({ type: "message", role: "assistant", text: "a\nb" })).toBe("◆ a\n  b");
  expect(r({ type: "message", role: "user", text: "go" })).toBe("› go");
  const ask = { type: "ask", text: "permission: rm", options: ["Allow", "Reject"], answer: "answer in the app" };
  expect(r(ask)).toBe("? permission: rm\n  options: Allow | Reject\n  → answer in the app");
  expect(r(ask)).toBeNull();
  const pr = { type: "pr", url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7 };
  expect(r(pr)).toBe("⇢ PR o/r#7  https://github.com/o/r/pull/7");
  expect(r(pr)).toBeNull();
  expect(r({ type: "end", activity: "ended" })).toBe("■ session ended");
  expect(r({ type: "message", role: "assistant", text: Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n") })!.split("\n")).toHaveLength(13);
});

test("colour only when asked", () => {
  expect(renderLiveFrame({ type: "tool", text: "x" }, newLiveRenderState(), true)).toContain("\x1b[");
});

test("socket URL and reconnect backoff", () => {
  expect(liveSocketUrl("https://s.example.com/", "m:cs-fix", null)).toBe("wss://s.example.com/api/sessions/m%3Acs-fix/live");
  expect(liveSocketUrl("http://127.0.0.1:9121", "m:cs-fix", 42)).toBe("ws://127.0.0.1:9121/api/sessions/m%3Acs-fix/live?after=42");
  expect([0, 1, 2, 3, 4, 9].map(liveBackoffMs)).toEqual([1000, 2000, 4000, 8000, 15000, 15000]);
});

/* ---------- cs live --all ---------- */

test("cs live --all, cs live -A and cs --live --all reach the board", () => {
  expect(parseServerArgs(["live", "--all"])).toMatchObject({ sub: "live", args: ["--all"] });
  expect(parseServerArgs(["live", "-A"])).toMatchObject({ sub: "live", args: ["-A"] });
  expect(parseServerArgs(["--live", "--all"])).toMatchObject({ sub: "live", args: ["--all"] });
});

test("sessions group into needs you, cooking and idle", () => {
  expect(boardGroup("waiting")).toBe("needs");
  expect(boardGroup("finished", true)).toBe("needs");
  expect(boardGroup("running")).toBe("cooking");
  expect(boardGroup("starting")).toBe("cooking");
  for (const a of ["finished", "ready", "connected"]) expect(boardGroup(a)).toBe("idle");
});

test("agent text becomes one plain line", () => {
  expect(plainText("## Done\n\n- **Fixed** the `login` test\n- see [the PR](https://example.com/pr/1)")).toBe("Done Fixed the login test see the PR");
  expect(plainText("Summary:\n| Task | PR |\n|---|---|\n| one | #1 |\nAll merged.")).toBe("Summary: All merged.");
  expect(plainText("Before\n```ts\nconst x = 1;\n```\nafter")).toBe("Before after");
});

test("the first two sentences, cut on a word with a real ellipsis", () => {
  expect(firstSentences("One. Two! Three?")).toBe("One. Two!");
  expect(firstSentences("The fix is up at https://example.com/pull/7 (not merged). Next step. Third.")).toBe("The fix is up at https://example.com/pull/7 (not merged). Next step.");
  expect(firstSentences("Version 1.2.3 shipped today. Done.")).toBe("Version 1.2.3 shipped today. Done.");
  const long = firstSentences("word ".repeat(80), 2, 50);
  expect(long.length).toBeLessThanOrEqual(50);
  expect(long.endsWith("…")).toBe(true);
  expect(long).not.toContain("...");
});

test("a summary is the question, else the last reply, else the last tool, else nothing yet", () => {
  const frames = [
    { type: "message", role: "user", text: "fix it" },
    { type: "tool", text: "Bash bun test" },
    { type: "message", role: "assistant", text: "**Found it.** The cookie expires early. I am fixing that now." },
    { type: "ask", text: "permission: Write config.json" },
  ];
  expect(boardSummary(frames, "waiting")).toEqual({ kind: "ask", text: "permission: Write config.json" });
  expect(boardSummary(frames, "running")).toEqual({ kind: "message", text: "Found it. The cookie expires early." });
  expect(boardSummary(frames.slice(0, 2), "running")).toEqual({ kind: "tool", text: "working: Bash bun test" });
  expect(boardSummary([], "waiting").text).toBe("the agent is waiting for your answer");
  expect(boardSummary([], "connected")).toEqual({ kind: "none", text: "no messages yet" });
});

test("a row shows its newest PR and how many more", () => {
  expect(prLabels([{ repo: "you/app", number: 42 }], true)).toEqual(["#42"]);
  expect(prLabels([{ repo: "you/app", number: 42 }, { repo: "you/app", number: 7 }], false)).toEqual(["app#42", "+1"]);
  expect(prLabels([], true)).toEqual([]);
});

test("summaries wrap at the width, indented under their row", () => {
  const out = wrapIndented("alpha beta gamma delta epsilon", 16, "  ");
  expect(out.split("\n")).toEqual(["  alpha beta", "  gamma delta", "  epsilon"]);
});

test("the board lists groups in order with a footer and one line per unreachable server", () => {
  const item = (name: string, activity: string, kind: BoardItem["summary"]["kind"], text: string): BoardItem =>
    ({ server: "lab", name, activity, uptimeSec: 3720, prs: name === "b" ? ["#7"] : [], summary: { kind, text } });
  const board = renderBoard([
    item("c", "finished", "message", "All done."),
    item("a", "waiting", "ask", "permission: Write config.json"),
    item("b", "running", "tool", "working: Bash bun test"),
    item("d", "connected", "none", "no messages yet"),
  ], [{ server: "home", error: "no answer in 15 s" }]);
  const lines = board.split("\n");
  expect(lines.indexOf("Needs you")).toBeLessThan(lines.indexOf("Cooking"));
  expect(lines.indexOf("Cooking")).toBeLessThan(lines.indexOf("Idle"));
  expect(board).toContain("● b  lab · 1h 2m · #7");
  expect(board).toContain("× home  unreachable: no answer in 15 s");
  expect(lines.at(-1)).toBe("Needs you 1 · Cooking 1 · Idle 2 · 1 unreachable");
  expect(board).not.toMatch(/\x1b/);
  expect(renderBoard([], [])).toContain("Nothing running.");
});
