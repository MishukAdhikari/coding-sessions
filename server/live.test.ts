import { describe, expect, test } from "bun:test";
import { acpFrames, createLiveHub, LiveFeed, redact, transcriptFrames, type LiveSessionView, type ReadSource } from "./live";
import type { AcpEvent } from "./acp/event-log";

const session = (over: Partial<LiveSessionView> = {}): LiveSessionView => ({
  id: "m:cs-fix", name: "fix", provider: "claude", mode: "terminal", activity: "running", asking: false, prs: [], ...over,
});

describe("redact", () => {
  test("stored values and token shapes are replaced", () => {
    const out = redact("key=supersecretvalue gh=ghp_abcdefghijklmnopqrstuvwxyz0123 a=sk-ant-api03-abcdefghijk Authorization: Bearer abcdefghijklmnop1234", ["supersecretvalue"]);
    expect(out).not.toContain("supersecretvalue");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("sk-ant-");
    expect(out).not.toContain("abcdefghijklmnop1234");
    expect(out.match(/\[redacted\]/g)?.length).toBe(4);
  });
  test("short stored values are left alone", () => {
    expect(redact("on and on", ["on"])).toBe("on and on");
  });
});

describe("frames", () => {
  test("transcript messages become message and tool frames", () => {
    const f = transcriptFrames([
      { id: "1:0", role: "assistant", text: "Looking.", at: "t" },
      { id: "2:0", role: "tool", text: "Bash npm test", at: null },
    ]);
    expect(f).toEqual([
      { type: "message", role: "assistant", text: "Looking.", at: "t" },
      { type: "tool", text: "Bash npm test", at: null },
    ]);
  });

  test("ACP chunks join; tool calls, diffs, permissions and notices map", () => {
    const ev = (kind: string, rest: object, seq = 0): AcpEvent => ({ seq, at: "t", kind: kind as AcpEvent["kind"], ...rest });
    const f = acpFrames([
      ev("user", { text: "fix it" }),
      ev("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "On " } } }),
      ev("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "it." } } }),
      ev("update", { update: { sessionUpdate: "tool_call", title: "Edit a.ts", content: [{ type: "diff", path: "a.ts", oldText: "x", newText: "y\nz" }] } }),
      ev("permission", { requestId: "perm-1", toolCall: { title: "Run rm" }, options: [{ optionId: "a", name: "Allow" }, { optionId: "r", name: "Reject" }] }),
      ev("permission_resolved", { requestId: "perm-1", optionId: "a", auto: false }),
      ev("notice", { level: "warning", text: "slow" }),
    ]);
    expect(f.map((x) => x.type)).toEqual(["message", "message", "tool", "ask", "notice", "notice"]);
    expect(f[1]).toMatchObject({ role: "assistant", text: "On it." });
    expect(f[2]).toMatchObject({ text: "Edit a.ts (a.ts +2 -1)" });
    expect(f[3]).toMatchObject({ options: ["Allow", "Reject"] });
  });
});

describe("LiveFeed", () => {
  const source = (frames: number) => {
    let size = frames;
    const read: ReadSource = (_id, after) => {
      const start = after ?? 0;
      const out = Array.from({ length: size - start }, (_, i) => ({ type: "tool" as const, text: `t${start + i}`, at: null }));
      return { frames: out, cursor: size, reset: false };
    };
    return { read, grow: (n: number) => { size += n; } };
  };

  test("attach shows hello, state and a bounded backlog, then only news", () => {
    const src = source(30);
    const feed = new LiveFeed("m:cs-fix", null, 5);
    const first = feed.step(session(), src.read, []);
    expect(first.frames.map((f) => f.type)).toEqual(["hello", "state", "tool", "tool", "tool", "tool", "tool"]);
    expect(first.frames.at(-1)).toMatchObject({ text: "t29" });
    expect(first.cursor).toBe(30);
    expect(feed.step(session(), src.read, []).frames).toEqual([]);
    src.grow(1);
    expect(feed.step(session(), src.read, []).frames).toEqual([{ type: "tool", text: "t30", at: null }]);
  });

  test("a resumed cursor skips hello's backlog trimming and old frames", () => {
    const src = source(10);
    const feed = new LiveFeed("m:cs-fix", 8);
    expect(feed.step(session(), src.read, []).frames.filter((f) => f.type === "tool")).toHaveLength(2);
  });

  test("asking, PR links and the end appear once; secrets never leave", () => {
    const src = source(0);
    const feed = new LiveFeed("m:cs-fix");
    feed.step(session(), src.read, []);
    const pr = { url: "https://github.com/o/r/pull/7", repo: "o/r", number: 7 };
    const b = feed.step(session({ activity: "waiting", asking: true, prs: [pr] }), src.read, []);
    expect(b.frames.map((f) => f.type)).toEqual(["state", "ask", "pr"]);
    expect(b.frames[1]).toMatchObject({ answer: expect.stringContaining("cs mirror fix") });
    expect(feed.step(session({ activity: "waiting", asking: true, prs: [pr] }), src.read, []).frames).toEqual([]);
    const end = feed.step(session({ activity: "ended", prs: [pr] }), src.read, []);
    expect(end.frames.map((f) => f.type)).toEqual(["state", "end"]);
    expect(end.ended).toBe(true);

    const leak: ReadSource = () => ({ frames: [{ type: "message", role: "assistant", text: "token is hunter2hunter2", at: null }], cursor: 1, reset: false });
    const f2 = new LiveFeed("m:cs-fix").step(session(), leak, ["hunter2hunter2"]);
    expect(JSON.stringify(f2)).not.toContain("hunter2hunter2");
  });

  test("a session that disappears ends the feed", () => {
    const feed = new LiveFeed("m:cs-gone");
    expect(feed.step(null, source(0).read, []).frames).toEqual([{ type: "end", activity: "ended", reason: "no such live session" }]);
  });

  test("ACP sessions do not get the terminal ask hint", () => {
    const b = new LiveFeed("m:cs-fix").step(session({ mode: "acp", asking: true, activity: "waiting" }), source(0).read, []);
    expect(b.frames.some((f) => f.type === "ask")).toBe(false);
  });
});

describe("hub", () => {
  test("once() answers a single batch for polling", async () => {
    const hub = createLiveHub({ sessions: async () => [session()], read: () => ({ frames: [], cursor: 3, reset: false }), secrets: async () => [] });
    const b = await hub.once("m:cs-fix", 3);
    expect(b.cursor).toBe(3);
    expect(b.frames.map((f) => f.type)).toEqual(["hello", "state"]);
  });

  test("open sockets get pushed batches and close when the session ends", async () => {
    let activity = "running";
    const hub = createLiveHub({ sessions: async () => [session({ activity })], read: (_id, a) => ({ frames: [], cursor: a ?? 0, reset: false }), secrets: async () => [], intervalMs: 10 });
    const sent: string[] = [];
    let closed = false;
    const ws = { data: { live: { id: "m:cs-fix", after: null } }, send: (s: string) => { sent.push(s); }, close: () => { closed = true; } };
    hub.open(ws as any);
    await Bun.sleep(30);
    activity = "ended";
    await Bun.sleep(40);
    expect(sent.map((s) => JSON.parse(s).frames.map((f: any) => f.type)).flat()).toEqual(["hello", "state", "state", "end"]);
    expect(closed).toBe(true);
    expect(hub.size).toBe(0);
  });
});
