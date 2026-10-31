import type { SessionInfo } from "./sessions";
import { capabilitiesFor } from "./session-provider";

export type SessionActivity = "starting" | "running" | "waiting" | "finished" | "ready" | "connected" | "ended" | "failed";

/** Turn completion is separate from process exit: a finished agent stays open. */
export function sessionActivity(s: SessionInfo): SessionActivity {
  if (s.phase === "failed") return "failed";
  if (s.status === "ended") return "ended";
  if (s.provider === "codex" && s.phase === "awaiting_session_start" && s.startupWaitingForTrust) return "waiting";
  if (s.status === "starting") return "starting";
  if (!capabilitiesFor(s.provider).semanticStatus || s.telemetryUnknown) return "connected";
  if (s.asking) return "waiting";
  if (s.busy) return "running";
  if (s.waiting) return s.provider === "codex" && !s.turnComplete ? "ready" : "finished";
  return "connected";
}
