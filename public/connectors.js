/* xCloud Sessions — outbound MCP connectors (Settings › External MCP connectors) */
(() => {
  const STATES = {
    connected: ["positive", "Connected", "The last test reached the server and listed its tools."],
    not_checked: ["neutral", "Not checked", "Test the connection to load the server’s tools."],
    needs_url: ["warning", "Needs URL", "Enter the server URL to use this connector. Any saved token is removed when you do."],
    auth_failed: ["warning", "Needs token", "The server refused the request. Add or replace the token."],
    forbidden: ["warning", "Access refused", "The server refused access. Check the token and its permissions."],
    blocked: ["warning", "Refused", "This server cannot be reached safely."],
    unavailable: ["warning", "Unavailable", "The server could not be reached or answered unexpectedly."],
    disabled: ["neutral", "Disabled", "No session can use this connector until you enable it."],
  };
  const PROVIDERS = [["claude", "Claude"], ["codex", "Codex"], ["command-code", "Command Code"]];
  const OUTCOMES = { ok: "ok", tool_error: "tool error", denied: "denied", invalid: "invalid arguments", revoked: "revoked", rate_limited: "busy", blocked: "refused",
    auth: "token rejected", forbidden: "no permission", unavailable: "unavailable", timeout: "timed out", cancelled: "cancelled", protocol: "bad response", too_large: "too large", upstream_error: "server error" };
  const icons = {
    positive: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    neutral: '<circle cx="12" cy="12" r="8"/>',
    warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.01"/>',
  };
  const statusParts = (state) => {
    const [tone, label] = STATES[state] ?? STATES.not_checked;
    return { tone, label, icon: `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[tone]}</svg>` };
  };
  /** The server's own annotations, worded as claims. */
  const hintText = (hints) => {
    if (hints.readOnly === true) return "Server says: read-only";
    if (hints.destructive === true) return "Server says: may delete or overwrite";
    if (hints.readOnly === false) return "Server says: may change things";
    return "No hints from the server";
  };

  window.createConnectorsUI = ({ $, api, openSheet, showToast, agoStr, escapeHtml }) => {
    let connectors = [];
    let current = null;
    let busy = false;
    let removeArmed = false;
    let generation = 0; // a response applies only if nothing newer started after it

    const post = (path, body = {}) => api(path, { method: "POST", body: JSON.stringify(body) });
    const when = (ms) => ms ? agoStr(ms) : "never";
    const checkbox = (label, checked, onChange, { disabled = false, detail = "" } = {}) => {
      const row = document.createElement("label");
      row.className = "ws-row";
      const input = document.createElement("input");
      input.type = "checkbox"; input.checked = checked; input.disabled = disabled;
      input.addEventListener("change", () => {
        // Controls are disabled while a change is saving; never show a toggle that was not sent.
        if (busy) { input.checked = !input.checked; return; }
        onChange(input.checked, input);
      });
      const text = document.createElement("span");
      text.className = "connector-row-text";
      text.innerHTML = `${label}${detail ? `<span class="connector-row-detail">${detail}</span>` : ""}`;
      row.append(input, text);
      return row;
    };

    function lock(locked) {
      for (const el of document.querySelectorAll("#sheet-connector input, #sheet-connector button:not([data-close]):not(.sheet-back):not(.sheet-close), #form-connector-add input, #form-connector-add button")) {
        if (locked) { el.dataset.wasDisabled = el.disabled ? "1" : ""; el.disabled = true; }
        // Restore only what this lock changed; controls rebuilt meanwhile keep their own state.
        else if (el.dataset.wasDisabled !== undefined) { el.disabled = el.dataset.wasDisabled === "1"; delete el.dataset.wasDisabled; }
      }
    }

    async function mutate(action) {
      if (busy) return null;
      busy = true;
      const mine = ++generation;
      lock(true);
      let failed = null;
      let result = null;
      try { result = await action(); if (result?.connector && mine === generation) current = result.connector; }
      catch (error) { failed = error; }
      busy = false;
      lock(false);
      // Navigation (open, Back, Close, another connector) bumps the generation: a late response
      // still happened on the server, but its result is not shown or acted on.
      if (mine !== generation) return null;
      if (failed) { showToast(failed.message); await load(); return null; }
      // UI state changes only here, after the guard; actions only talk to the server.
      if (result?.removed) current = null;
      renderDetail(); loadAudit();
      return result;
    }

    function renderList() {
      const wrap = $("connector-list");
      wrap.replaceChildren();
      for (const view of connectors) {
        const { tone, label, icon } = statusParts(view.state);
        const button = document.createElement("button");
        button.type = "button";
        button.className = "row-btn connector-row";
        const granted = view.granted_tools.length;
        button.innerHTML = `<span class="connector-row-name">${escapeHtml(view.name)}</span><span class="connection-status" data-tone="${tone}">${icon}${escapeHtml(label)}</span><span class="connection-detail">${escapeHtml(view.host ?? "No URL")} · ${granted} ${granted === 1 ? "tool" : "tools"} granted</span>`;
        button.addEventListener("click", () => openDetail(view));
        wrap.append(button);
      }
    }

    function renderDetail() {
      const view = current;
      if (!view) return;
      $("connector-name").textContent = view.name;
      $("connector-host").textContent = view.url ?? "No URL";
      const { tone, label, icon } = statusParts(view.state);
      const state = $("connector-state");
      state.dataset.tone = tone;
      state.innerHTML = icon;
      state.append(document.createTextNode(label));
      $("connector-state-detail").textContent = view.check_detail || (STATES[view.state] ?? STATES.not_checked)[2];
      $("connector-server").textContent = view.server ? `${view.server.name}${view.server.version ? ` ${view.server.version}` : ""}` : "Not reported";
      $("connector-credential").textContent = view.credential.set ? `Saved ${when(view.credential.set_at)}` : "None";
      $("connector-namespace").textContent = `${view.namespace}__`;
      $("connector-checked").textContent = view.checked_at ? `${when(view.checked_at)}${view.last_ok_at ? ` · last OK ${when(view.last_ok_at)}` : ""}` : "Never";
      $("connector-tool-count").textContent = `${view.granted_tools.length} granted of ${view.discovered_count} offered`;
      $("btn-connector-check").disabled = !view.enabled || !view.url;
      $("connector-token-label").textContent = view.credential.set ? "Replace bearer token" : "Bearer token";
      $("btn-connector-token").textContent = view.credential.set ? "Replace token" : "Save token";
      $("btn-connector-token-remove").hidden = !view.credential.set;
      if (document.activeElement !== $("input-connector-rename")) $("input-connector-rename").value = view.name;
      if (document.activeElement !== $("input-connector-edit-url")) $("input-connector-edit-url").value = view.url ?? "";

      const tools = $("connector-tools");
      tools.replaceChildren();
      if (!view.tools.length) tools.innerHTML = '<p class="hint connector-empty-hint">No tools loaded yet. Test the connection to list them.</p>';
      for (const tool of view.tools) {
        const parts = [];
        if (tool.exposed && tool.exposed !== `${view.namespace}__${tool.name}`) parts.push(`Agents see <code>${escapeHtml(tool.exposed)}</code>`);
        if (!tool.exposed) parts.push("Cannot be granted: its agent-facing name collides with another tool’s");
        if (!tool.offered) parts.push("Granted earlier but not offered by the server now; calls are refused");
        const summary = (tool.title || (tool.description || "").split(/\n/)[0] || "").slice(0, 160);
        if (summary) parts.push(escapeHtml(summary));
        parts.push(`<span class="connector-hint">${escapeHtml(hintText(tool.hints))}</span>`);
        tools.append(checkbox(`<code>${escapeHtml(tool.name)}</code>`, tool.granted, (checked) => {
          const next = new Set(view.granted_tools);
          checked ? next.add(tool.name) : next.delete(tool.name);
          mutate(() => post(`/api/connectors/${view.id}/tools`, { tools: [...next] }));
        }, { disabled: !tool.exposed && !tool.granted, detail: parts.join("<br>") }));
      }

      const providers = $("connector-providers");
      providers.replaceChildren();
      for (const [id, label] of PROVIDERS) {
        providers.append(checkbox(label, view.default_providers.includes(id), (checked) => {
          const next = new Set(view.default_providers);
          checked ? next.add(id) : next.delete(id);
          mutate(() => post(`/api/connectors/${view.id}/providers`, { providers: [...next] }));
        }));
      }

      const launches = $("connector-launches");
      launches.replaceChildren();
      if (!view.launches.length) {
        launches.innerHTML = '<p class="hint connector-empty-hint">No running session was started with connector access. Sessions started before a connector was enabled get it when you resume them.</p>';
      }
      for (const launch of view.launches) {
        const agent = PROVIDERS.find(([id]) => id === launch.agent)?.[1] ?? launch.agent;
        launches.append(checkbox(escapeHtml(launch.name), launch.granted, (checked) => {
          mutate(() => post(`/api/connectors/${view.id}/launch`, { launch_id: launch.launch_id, granted: checked }));
        }, { detail: `<span class="chip chip-provider-${escapeHtml(launch.agent)}">${escapeHtml(agent)}</span>` }));
      }

      $("btn-connector-enabled").textContent = view.enabled ? "Disable connector" : "Enable connector";
      removeArmed = false;
      $("btn-connector-remove").textContent = "Remove connector…";
    }

    async function loadAudit() {
      const wrap = $("connector-audit");
      if (!current) return;
      const id = current.id;
      try {
        const { audit } = await api(`/api/connectors/${id}`);
        if (current?.id !== id) return;
        wrap.replaceChildren();
        if (!audit.length) { wrap.innerHTML = '<p class="hint connector-empty-hint">No calls yet.</p>'; return; }
        for (const entry of audit.slice(0, 10)) {
          const row = document.createElement("div");
          row.className = "proj-row connector-audit-row";
          row.innerHTML = `<div><code>${escapeHtml(entry.tool)}</code><div class="pick-path">${escapeHtml(entry.session_name || "unknown session")} · ${agoStr(entry.at)}</div></div><span class="connector-outcome" data-outcome="${escapeHtml(entry.outcome)}">${escapeHtml(OUTCOMES[entry.outcome] ?? entry.outcome)}</span>`;
          wrap.append(row);
        }
      } catch { if (current?.id === id) wrap.innerHTML = '<p class="hint connector-empty-hint">Recent calls are unavailable.</p>'; }
    }

    /** Returns whether its result was applied (nothing newer started meanwhile). */
    async function load() {
      const mine = ++generation;
      let data;
      try { data = await api("/api/connectors"); } catch (error) { if (mine === generation) showToast(error.message); return false; }
      if (mine !== generation) return false;
      connectors = data.connectors;
      if (current) current = connectors.find(view => view.id === current.id) ?? null;
      renderList();
      if (current) { renderDetail(); loadAudit(); }
      return true;
    }

    function openDetail(view) {
      generation++;
      current = view;
      $("input-connector-token").value = "";
      renderDetail();
      loadAudit();
      openSheet("sheet-connector");
    }

    $("form-connector-add").addEventListener("submit", async (event) => {
      event.preventDefault();
      const body = { name: $("input-connector-name").value, url: $("input-connector-url").value.trim() };
      const token = $("input-connector-new-token").value.trim();
      if (token) body.token = token;
      const result = await mutate(async () => {
        const created = await api("/api/connectors", { method: "POST", body: JSON.stringify(body) });
        return post(`/api/connectors/${created.connector.id}/check`);
      });
      if (!result) return;
      for (const id of ["input-connector-name", "input-connector-url", "input-connector-new-token"]) $(id).value = "";
      // Open the new connector only if the list is still showing and nothing navigated meanwhile.
      if (await load() && !$("sheet-connectors").hidden) openDetail(result.connector);
    });
    $("form-connector-token").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("input-connector-token");
      const token = input.value.trim();
      if (!token || !current) return;
      const id = current.id;
      mutate(async () => {
        await post(`/api/connectors/${id}/credential`, { token });
        return post(`/api/connectors/${id}/check`);
      }).then(result => { if (result) input.value = ""; });
    });
    $("btn-connector-token-remove").addEventListener("click", () => {
      if (current) mutate(() => post(`/api/connectors/${current.id}/credential`, { token: null }));
    });
    $("form-connector-edit").addEventListener("submit", (event) => {
      event.preventDefault();
      if (!current) return;
      const before = current;
      const name = $("input-connector-rename").value;
      const url = $("input-connector-edit-url").value.trim();
      const urlChanged = url !== (before.url ?? "");
      mutate(async () => {
        let result = name !== before.name ? await post(`/api/connectors/${before.id}/name`, { name }) : { connector: before };
        if (urlChanged) result = await post(`/api/connectors/${before.id}/url`, { url });
        return result;
      }).then(result => { if (result && urlChanged) showToast("URL changed. The token and tool grants were removed."); });
    });
    $("btn-connector-check").addEventListener("click", () => {
      if (current) mutate(() => post(`/api/connectors/${current.id}/check`));
    });
    $("btn-connector-enabled").addEventListener("click", () => {
      if (current) mutate(() => post(`/api/connectors/${current.id}/enabled`, { enabled: !current.enabled }));
    });
    $("btn-connector-remove").addEventListener("click", async () => {
      if (!current || busy) return;
      if (!removeArmed) { removeArmed = true; $("btn-connector-remove").textContent = "Confirm remove"; return; }
      const id = current.id;
      const done = await mutate(async () => { await api(`/api/connectors/${id}`, { method: "DELETE" }); return { removed: true }; });
      if (!done) return;
      showToast("Connector removed");
      document.querySelector("#sheet-connector .sheet-back")?.click();
    });

    // Token fields never keep a value once their sheet closes (Escape, Close, Back or the scrim).
    // Leaving a sheet also invalidates responses still in flight for what it showed.
    for (const [sheet, inputs] of [["sheet-connector", ["input-connector-token"]], ["sheet-connectors", ["input-connector-new-token"]]]) {
      new MutationObserver(() => {
        if (!$(sheet).hidden) return;
        for (const id of inputs) $(id).value = "";
        generation++;
        if (sheet === "sheet-connector" && !$("sheet-connectors").hidden) load();
      }).observe($(sheet), { attributes: true, attributeFilter: ["hidden"] });
    }

    return {
      open() {
        generation++;
        current = null;
        $("input-connector-new-token").value = "";
        $("connector-list").replaceChildren();
        load();
        openSheet("sheet-connectors");
      },
    };
  };
})();
