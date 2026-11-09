import { expect, test } from "bun:test";
import { restartSession, type RestartDependencies } from "./session-restart";

function deps(over: Partial<RestartDependencies> = {}) {
  const calls: string[] = [];
  let goneAfter = 2;
  const value: RestartDependencies = {
    blocker: () => null,
    provider: () => "claude",
    end: async (id) => { calls.push(`end ${id}`); return { ok: true, archiveId: 41 }; },
    gone: async () => { calls.push("gone?"); return --goneAfter <= 0; },
    resume: async (archiveId, provider) => { calls.push(`resume ${archiveId} ${provider}`); return { ok: true }; },
    sleep: async () => {},
    ...over,
  };
  return { value, calls };
}

test("restart ends the session, waits for its name to be free, then resumes exactly the archive it created", async () => {
  const d = deps();
  expect(await restartSession("m:cs-demo", d.value)).toEqual({ ok: true, session_id: "m:cs-demo", archive_id: 41 });
  expect(d.calls).toEqual(["end m:cs-demo", "gone?", "gone?", "resume 41 claude"]);
});

test("a session that could not come back is refused before anything ends", async () => {
  const d = deps({ blocker: () => "Gemini (preset) has no conversation to resume." });
  expect(await restartSession("m:cs-gem", d.value)).toEqual({ ok: false, error: "Gemini (preset) has no conversation to resume.", ended: false });
  expect(d.calls).toEqual([]);
});

test("a resume failure after ending says the session ended and where to resume it", async () => {
  const d = deps({ provider: () => "codex", resume: async () => ({ ok: false, error: "Its folder is gone." }) });
  const result = await restartSession("m:cs-codex", d.value);
  expect(result).toEqual({ ok: false, ended: true, archive_id: 41, error: "The session ended but did not come back: Its folder is gone. Resume it from History (archive 41)." });
});

test("an end that archived nothing, or failed, never tries to resume", async () => {
  const none = deps({ end: async () => ({ ok: true, archiveId: null }) });
  expect(await restartSession("m:cs-x", none.value)).toMatchObject({ ok: false, ended: true });
  expect(none.calls.some(call => call.startsWith("resume"))).toBe(false);
  const failed = deps({ end: async () => ({ ok: false, error: "Bad session id." }) });
  expect(await restartSession("m:cs-x", failed.value)).toEqual({ ok: false, error: "Bad session id.", ended: false });
});

test("the wait for the old screen is bounded", async () => {
  let slept = 0;
  const d = deps({ gone: async () => false, sleep: async (ms) => { slept += ms; } });
  expect((await restartSession("m:cs-stuck", d.value)).ok).toBe(true);
  expect(slept).toBe(5000);
});
