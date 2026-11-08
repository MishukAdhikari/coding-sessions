/* Launch mode — the "Terminal / Chat (ACP)" choice in the Start a session sheet.
 *
 * Chat is offered per agent, from GET /api/acp/agents (which agents have a verified
 * ACP command installed on this server, and why not when they don't), and only for
 * project launches: fresh workspaces stay terminal sessions. When Chat becomes
 * unavailable while chosen, the choice falls back to Terminal and the note says why.
 *
 * app.js owns the sheet; it calls refresh() when the sheet opens, update() when the
 * agent or project changes, and reads value() for the launch body.
 */
(function (root) {
  "use strict";

  const WORKSPACE_REASON = "Chat is available for shared-folder projects. A fresh workspace starts in the terminal.";
  const CHECKING_REASON = "Checking whether this agent can run as a chat…";
  const FAILED_REASON = "Couldn't check which agents can run as a chat. Terminal is available.";
  const UNSUPPORTED_REASON = "This agent can't run as a chat.";

  /* Whether Chat can be chosen, and the reason shown when it can't. */
  function availability(agents, { provider, workspace, failed } = {}) {
    if (!provider) return { enabled: false, reason: "" };
    if (workspace) return { enabled: false, reason: WORKSPACE_REASON };
    if (failed && !agents) return { enabled: false, reason: FAILED_REASON };
    if (!agents) return { enabled: false, reason: CHECKING_REASON };
    const agent = agents.find((a) => a && a.provider === provider);
    if (!agent) return { enabled: false, reason: UNSUPPORTED_REASON };
    if (agent.available) return { enabled: true, reason: "" };
    return { enabled: false, reason: typeof agent.reason === "string" && agent.reason ? agent.reason : UNSUPPORTED_REASON };
  }

  function create(doc, { load, onChange } = {}) {
    const terminal = doc.getElementById("launch-mode-terminal");
    const chat = doc.getElementById("launch-mode-acp");
    const note = doc.getElementById("launch-mode-note");
    let agents = null; // the last list the server gave; kept across opens so the sheet doesn't flash
    let failed = false;
    let request = 0;
    let context = { provider: null, workspace: false };

    function update(next = {}) {
      context = { ...context, ...next };
      const state = availability(agents, { ...context, failed });
      chat.disabled = !state.enabled;
      if (!state.enabled && chat.checked) {
        chat.checked = false;
        terminal.checked = true;
      }
      note.textContent = state.reason;
      note.hidden = !state.reason;
      return state;
    }

    function refresh() {
      const mine = ++request;
      failed = false;
      update();
      return Promise.resolve()
        .then(() => load())
        .then((data) => {
          if (mine !== request) return;
          agents = Array.isArray(data?.agents) ? data.agents : [];
          update();
        })
        .catch(() => {
          if (mine !== request) return;
          failed = true;
          update();
        });
    }

    function reset() {
      chat.checked = false;
      terminal.checked = true;
      update();
    }

    const value = () => (chat.checked && !chat.disabled ? "acp" : "terminal");

    terminal.addEventListener("change", () => onChange?.(value()));
    chat.addEventListener("change", () => onChange?.(value()));

    return { refresh, update, reset, value };
  }

  root.LaunchMode = { create, availability, WORKSPACE_REASON };
})(typeof window !== "undefined" ? window : globalThis);
