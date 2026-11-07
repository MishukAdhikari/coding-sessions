import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { applyDatabaseSchema } from "./db-schema";
import { parseBootTime, readBootTime, runBootResume, type BootResumeDeps } from "./boot-resume";

const BOOT = 1_000_000;

function archive(database: Database, name: string, startedAt: number | null, endedAt: number, endReason: string | null, provider = "claude"): number {
  return Number(database.query(
    "INSERT INTO archive (name, project_path, started_at, ended_at, provider, end_reason) VALUES (?, '/srv/demo', ?, ?, ?, ?)",
  ).run(name, startedAt, endedAt, provider, endReason).lastInsertRowid);
}

function harness(resume: BootResumeDeps["resumeArchived"] = async () => ({ ok: true })) {
  const database = new Database(":memory:");
  applyDatabaseSchema(database);
  const lines: string[] = [];
  const calls: Array<{ id: number; provider: string }> = [];
  let listed = 0;
  const deps: BootResumeDeps = {
    database,
    bootTime: BOOT,
    listSessions: async () => { listed++; },
    resumeArchived: async (id, provider) => { calls.push({ id, provider }); return resume(id, provider); },
    log: line => lines.push(line),
  };
  return { database, deps, lines, calls, listed: () => listed };
}

test("boot time is read from the btime line of /proc/stat, in milliseconds", () => {
  expect(parseBootTime("cpu  1 2 3\nintr 5\nbtime 1762500000\nprocesses 9\n")).toBe(1_762_500_000_000);
  expect(parseBootTime("cpu  1 2 3\n")).toBeNull();
  expect(parseBootTime("btime soon\n")).toBeNull();
  expect(parseBootTime("btime 0\n")).toBeNull();
  expect(readBootTime(() => "btime 42\n")).toBe(42_000);
  expect(readBootTime(() => { throw new Error("no /proc here"); })).toBeNull();
});

test("only sessions the reboot killed are resumed, each with its own provider", async () => {
  const h = harness();
  const killed = archive(h.database, "killed", BOOT - 500, BOOT + 10, "vanished", "codex");
  archive(h.database, "after-boot", BOOT + 5, BOOT + 20, "vanished");
  archive(h.database, "earlier-uptime", BOOT - 900, BOOT - 100, "vanished");
  archive(h.database, "user-ended", BOOT - 500, BOOT + 10, "ended");
  archive(h.database, "legacy", BOOT - 500, BOOT + 10, null);
  archive(h.database, "unknown-start", null, BOOT + 10, "vanished");

  expect(await runBootResume(h.deps)).toEqual({ resumed: ["killed"], skipped: [] });
  expect(h.listed()).toBe(1);
  expect(h.calls).toEqual([{ id: killed, provider: "codex" }]);
  expect(h.lines).toContain("boot resume: started “killed” (codex), resumed once Codex confirms the conversation");
});

test("each row is tried once: a failed resume is logged, kept in history and not retried", async () => {
  const h = harness(async () => ({ ok: false, error: "Its folder is gone — nothing to resume into." }));
  const id = archive(h.database, "gone", BOOT - 500, BOOT + 10, "vanished");

  expect(await runBootResume(h.deps)).toEqual({ resumed: [], skipped: ["gone"] });
  expect(h.lines).toContain("boot resume: skipped “gone”: Its folder is gone — nothing to resume into.");
  const row = h.database.query("SELECT boot_resume_at FROM archive WHERE id = ?").get(id) as { boot_resume_at: number | null };
  expect(row.boot_resume_at).not.toBeNull();

  expect(await runBootResume(h.deps)).toEqual({ resumed: [], skipped: [] });
  expect(h.calls).toHaveLength(1);
});

test("resumes run oldest first, and a second row with a taken name is skipped", async () => {
  const running = new Set<string>();
  const h = harness();
  h.deps.resumeArchived = async (id, provider) => {
    h.calls.push({ id, provider });
    const { name } = h.database.query("SELECT name FROM archive WHERE id = ?").get(id) as { name: string };
    if (running.has(name)) return { ok: false, error: `A session named “${name}” is already running.` };
    running.add(name);
    return { ok: true };
  };
  const newer = archive(h.database, "demo", BOOT - 100, BOOT + 10, "vanished");
  const older = archive(h.database, "demo", BOOT - 900, BOOT + 10, "vanished");

  expect(await runBootResume(h.deps)).toEqual({ resumed: ["demo"], skipped: ["demo"] });
  expect(h.calls.map(call => call.id)).toEqual([older, newer]);
});

test("errors never escape the pass", async () => {
  const h = harness(async () => { throw new Error("spawn exploded"); });
  h.deps.listSessions = async () => { throw new Error("mux unavailable"); };
  archive(h.database, "demo", BOOT - 500, BOOT + 10, "vanished");

  expect(await runBootResume(h.deps)).toEqual({ resumed: [], skipped: ["demo"] });
  expect(h.lines).toContain("boot resume: could not check sessions first: mux unavailable");
  expect(h.lines).toContain("boot resume: skipped “demo”: spawn exploded");
});

test("without a boot time nothing is resumed", async () => {
  const h = harness();
  archive(h.database, "demo", BOOT - 500, BOOT + 10, "vanished");
  h.deps.bootTime = null;

  expect(await runBootResume(h.deps)).toEqual({ resumed: [], skipped: [] });
  expect(h.calls).toEqual([]);
  expect(h.listed()).toBe(0);
  expect(h.lines).toEqual(["boot resume: skipped, the boot time is unknown on this system"]);
});
