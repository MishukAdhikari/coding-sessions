/**
 * "Restart with new secrets": end a session and resume the same conversation, so the agent
 * and everything it started come back with the current environment. Running processes in
 * the session (dev servers, watchers, the agent itself) stop and the agent restarts.
 *
 * Nothing is ended that could not come back: the blocker check runs first, the resume uses
 * the exact archive row the end created, and a failure after ending says so plainly.
 */
import type { SessionProvider } from "./session-provider";

export interface RestartDependencies {
  /** Why this session could not come back after ending, or null. */
  blocker(id: string): string | null;
  provider(id: string): SessionProvider | null;
  end(id: string): Promise<{ ok: boolean; error?: string; archiveId?: number | null }>;
  /** Whether the session's terminal holder is gone, so its name is free to resume into. */
  gone(id: string): Promise<boolean>;
  resume(archiveId: number, provider: SessionProvider): Promise<{ ok: true } | { ok: false; error: string }>;
  sleep(ms: number): Promise<void>;
}

export type RestartResult =
  | { ok: true; session_id: string; archive_id: number }
  | { ok: false; error: string; ended: boolean; archive_id?: number };

const GONE_WAIT_MS = 5000;
const GONE_POLL_MS = 250;

export async function restartSession(id: string, deps: RestartDependencies): Promise<RestartResult> {
  const blocked = deps.blocker(id);
  if (blocked) return { ok: false, error: blocked, ended: false };
  const provider = deps.provider(id);
  if (!provider) return { ok: false, error: "That session is not running.", ended: false };
  const ended = await deps.end(id);
  if (!ended.ok) return { ok: false, error: ended.error ?? "The session could not be ended.", ended: false };
  if (typeof ended.archiveId !== "number") return { ok: false, error: "The session ended but left nothing to resume.", ended: true };
  const archiveId = ended.archiveId;
  for (let waited = 0; !(await deps.gone(id)) && waited < GONE_WAIT_MS; waited += GONE_POLL_MS) await deps.sleep(GONE_POLL_MS);
  const resumed = await deps.resume(archiveId, provider);
  if (!resumed.ok) {
    return { ok: false, ended: true, archive_id: archiveId,
      error: `The session ended but did not come back: ${resumed.error} Resume it from History (archive ${archiveId}).` };
  }
  return { ok: true, session_id: id, archive_id: archiveId };
}
