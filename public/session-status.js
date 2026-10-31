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
