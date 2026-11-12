import { expect, test } from "bun:test";
import { liveBackoffMs, liveSocketUrl, newLiveRenderState, parseHandoffArgs, parseServerArgs, renderLiveFrame, RUN } from "./cs-lib";

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
