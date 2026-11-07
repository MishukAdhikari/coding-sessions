import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import type { SessionProvider } from "./session-provider";

/**
 * Resume after boot (CS_RESUME_AFTER_BOOT=1). A reboot, or a Boat sandbox waking, keeps the
 * disk but kills every screen, so the sessions that were running come back only when someone
 * resumes them. This pass does that once, right after the server starts, with nobody watching.
 *
 * A row is resumed only when the reboot is what ended it: its screen vanished (the user did
 * not end it), it was launched before this boot, and it was archived during this boot. The
 * server was down when the reboot killed it, so the archive is always written after the boot;
 * an agent that exited by itself while the machine was up was archived before it.
 */

/** The boot time from the `btime` line of /proc/stat, in milliseconds. */
export function parseBootTime(procStat: string): number | null {
  const match = /^btime\s+(\d+)\s*$/m.exec(procStat);
  const seconds = match ? Number(match[1]) : 0;
  return seconds > 0 ? seconds * 1000 : null;
}

/** Linux only; anywhere /proc/stat cannot be read the boot time is unknown. */
export function readBootTime(read: () => string = () => readFileSync("/proc/stat", "utf8")): number | null {
  try { return parseBootTime(read()); } catch { return null; }
}

export interface BootResumeDeps {
  database: Database;
  bootTime: number | null;
  /** Moves launches whose screens the reboot removed into the archive. */
  listSessions: () => Promise<unknown>;
  resumeArchived: (id: number, provider: SessionProvider) => Promise<{ ok: true } | { ok: false; error: string }>;
  log: (line: string) => void;
  /** Runs the later check that lets a resumed Codex launch settle (default: in a minute). */
  schedule?: (fn: () => void) => void;
}

const FOLLOW_UP_MS = 60_000;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runBootResume(deps: BootResumeDeps): Promise<{ resumed: string[]; skipped: string[] }> {
  const resumed: string[] = [];
  const skipped: string[] = [];
  const { database, bootTime, log } = deps;
  if (bootTime === null) {
    log("boot resume: skipped, the boot time is unknown on this system");
    return { resumed, skipped };
  }
  try { await deps.listSessions(); }
  catch (error) { log(`boot resume: could not check sessions first: ${errorText(error)}`); }

  const rows = database.query(
    "SELECT id, name, provider FROM archive WHERE end_reason = 'vanished' AND boot_resume_at IS NULL " +
    "AND started_at IS NOT NULL AND started_at < ? AND ended_at >= ? ORDER BY started_at, id",
  ).all(bootTime, bootTime) as Array<{ id: number; name: string; provider: SessionProvider }>;

  // One at a time, oldest first: two rows with the same name cannot race for it, and the
  // mark goes on before the attempt so a crash or a failure is never retried.
  for (const row of rows) {
    database.query("UPDATE archive SET boot_resume_at = ? WHERE id = ?").run(Date.now(), row.id);
    let result: { ok: true } | { ok: false; error: string };
    try { result = await deps.resumeArchived(row.id, row.provider); }
    catch (error) { result = { ok: false, error: errorText(error) }; }
    if (result.ok) {
      resumed.push(row.name);
      log(`boot resume: resumed “${row.name}” (${row.provider})`);
    } else {
      skipped.push(row.name);
      log(`boot resume: skipped “${row.name}”: ${result.error}`);
    }
  }
  if (rows.length === 0) log("boot resume: nothing to resume");

  // A resumed Codex launch leaves its archive row and waits for its start hook until
  // listSessions next looks; with nobody watching, look once more after it has started.
  if (resumed.length > 0) {
    const schedule = deps.schedule ?? (fn => { setTimeout(fn, FOLLOW_UP_MS).unref?.(); });
    schedule(() => {
      void deps.listSessions().catch(error => log(`boot resume: follow-up check failed: ${errorText(error)}`));
    });
  }
  return { resumed, skipped };
}
