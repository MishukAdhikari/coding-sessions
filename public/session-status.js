/* Labels describe the current turn; Ended is reserved for a closed session. */
(() => {
  const states = {
    running: { label: "Running", detail: "The agent is working on its current turn." },
    waiting: { label: "Waiting for input", detail: "Open the session to answer a question or approval request." },
    finished: { label: "Finished", detail: "The agent finished its turn. The session is still open for your next message." },
    ready: { label: "Ready", detail: "The agent is connected and ready for a prompt." },
    connected: { label: "Connected", detail: "The session is open, but its current activity is unavailable." },
    starting: { label: "Starting", detail: "Preparing the workspace and connecting the agent." },
    ended: { label: "Ended", detail: "The session has closed." },
    failed: { label: "Launch failed", detail: "Open the session for details." },
  };
  window.sessionStatus = session => {
    if (session.provider === "codex" && session.phase === "awaiting_session_start" && session.status !== "ended" && session.startupWaitingForTrust) {
      return { state: "waiting", label: "Folder trust required", detail: "Open the terminal to review this folder. Codex has not reported readiness yet." };
    }
    const state = session.phase === "failed" ? "failed"
      : session.status === "ended" ? "ended"
      : session.status === "starting" ? "starting"
      : Object.hasOwn(states, session.activity) ? session.activity : "connected";
    return { state, ...states[state] };
  };
  // A starting session's terminal can attach once its holder exists, but for the
  // first moments there is nothing useful behind it yet. Past this it is a slow or
  // stuck launch, and the terminal is how to see why.
  const SETTLE_SEC = 30;

  /* Whether the session sheet offers its terminal or chat: "hidden", "pending"
     (shown, disabled, wait a few seconds) or "ready". caps: the provider's
     webTerminal and chatView capabilities. */
  window.sessionActionState = (session, kind, caps = {}) => {
    const managed = typeof session.id === "string" && session.id.startsWith("m:");
    if (!managed || session.status === "ended" || session.phase === "failed") return "hidden";
    if (session.status !== "starting" && session.status !== "running") return "hidden";
    const acp = session.mode === "acp";
    if (kind === "terminal" && !caps.webTerminal) return "hidden";
    if (kind === "chat" && !acp && !caps.chatView) return "hidden";
    if (session.status === "running") return "ready";
    // Starting from here on.
    if (kind === "chat" && !acp) return "hidden"; // a transcript appears once the agent runs
    if (kind === "terminal" && session.startupWaitingForTrust === true) return "ready";
    const age = Number(session.uptimeSec);
    return Number.isFinite(age) && age >= SETTLE_SEC ? "ready" : "pending";
  };
  window.sessionActivitySummary = sessions => {
    const counts = new Map();
    for (const session of sessions) {
      const { state } = window.sessionStatus(session);
      counts.set(state, (counts.get(state) || 0) + 1);
    }
    return ["running", "waiting", "finished", "ready", "starting", "connected", "failed"]
      .filter(state => counts.has(state))
      .map(state => `${counts.get(state)} ${state === "waiting" ? "waiting for input" : state}`)
      .join(" · ") || "No active sessions";
  };
})();
