/**
 * The bridge's state, in the session list's terms. Setting the existing SessionInfo
 * fields is enough: sessionActivity, the MCP session state and the activity signal
 * then treat a pending permission as "waiting on you" with no ACP-specific branch.
 */
import type { AcpState } from "./event-log";

export interface AcpSessionFields {
  status: "running" | "starting" | "ended";
  phase: string | null;
  errorMessage: string | null;
  busy: boolean;
  waiting: boolean;
  asking: boolean;
}

/** Pure. `phase`/`errorMessage` fall back to the launch row's when the bridge reports no failure. */
export function acpSessionFields(state: AcpState | null, row: { phase: string | null; error_message: string | null }): AcpSessionFields {
  const base = { status: "running" as const, phase: row.phase, errorMessage: row.error_message, busy: false, waiting: false, asking: false };
  switch (state?.state) {
    case undefined:
    case "starting": return { ...base, status: "starting" };
    case "working": return { ...base, busy: true };
    case "waiting": return { ...base, waiting: true, asking: true };
    case "idle": return { ...base, waiting: true };
    case "failed": return { ...base, phase: "failed", errorMessage: state.error ?? "The agent could not start a chat session." };
    case "exited": return { ...base, status: "ended" };
  }
}
