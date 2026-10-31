/* xCloud Sessions — outbound MCP connectors (Settings › External MCP connectors) */
(() => {
  const STATES = {
    connected: ["positive", "Connected", "The last test reached the service with this token."],
    not_checked: ["neutral", "Not checked", "Test the connection to confirm the token works."],
    needs_credential: ["warning", "Needs token", "Save an access token to connect."],
    auth_failed: ["warning", "Needs sign-in", "The service rejected the token. Replace it."],
    forbidden: ["warning", "No permission", "The token works but its account may not use this service."],
    unavailable: ["warning", "Unavailable", "The service could not be reached or answered unexpectedly. The token was not judged."],
    disabled: ["neutral", "Disabled", "No session can use this connector until you enable it."],
  };
  const PROVIDERS = [["claude", "Claude"], ["codex", "Codex"], ["command-code", "Command Code"]];
  const OUTCOMES = { ok: "ok", tool_error: "tool error", denied: "denied", invalid: "invalid arguments", revoked: "revoked", rate_limited: "busy",
    auth: "token rejected", forbidden: "no permission", unavailable: "unavailable", timeout: "timed out", cancelled: "cancelled", protocol: "bad response", too_large: "too large", upstream_error: "service error" };
  const icons = {
    positive: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    neutral: '<circle cx="12" cy="12" r="8"/>',
    warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.01"/>',
  };

  window.createConnectorsUI = ({ $, api, openSheet, showToast, agoStr, escapeHtml }) => {
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
      text.innerHTML = `${label}${detail ? `<span class="pick-path connector-row-detail">${detail}</span>` : ""}`;
      row.append(input, text);
      return row;
    };

    function lock(locked) {
      for (const el of $("sheet-connectors").querySelectorAll("#connector-detail input, #connector-detail button, #connector-presets button")) {
        if (locked) { el.dataset.wasDisabled = el.disabled ? "1" : ""; el.disabled = true; }
        else { el.disabled = el.dataset.wasDisabled === "1"; delete el.dataset.wasDisabled; }
      }
    }

    async function mutate(action) {
      if (busy) return;
      busy = true;
      const mine = ++generation;
      lock(true);
      let failed = null;
      try { const { connector } = await action(); if (connector && mine === generation) current = connector; }
      catch (error) { failed = error; }
      busy = false;
      lock(false);
      if (failed) { showToast(failed.message); await load(); return; }
      if (mine === generation) { render(); loadAudit(); }
    }

    function renderState(view) {
      const [tone, label, detail] = STATES[view.state] ?? STATES.not_checked;
      const el = $("connector-state");
      el.dataset.tone = tone;
      el.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[tone]}</svg>`;
      el.append(document.createTextNode(label));
      $("connector-state-detail").textContent = detail;
    }

    function render() {
      const view = current;
      $("connectors-empty").hidden = !!view;
      $("connector-detail").hidden = !view;
      if (!view) return;
      $("connector-name").textContent = view.label;
      $("connector-host").textContent = view.host;
      renderState(view);
      // Only what the service itself reported; never inferred from the token.
      $("connector-account").textContent = view.identity
        ? `${view.identity.account}${view.identity.role ? ` · ${view.identity.role}` : ""} (reported by ${view.host})`
        : "Not reported";
      $("connector-credential").textContent = view.credential.set ? `Saved ${when(view.credential.set_at)}` : "Not set";
      $("connector-checked").textContent = view.checked_at ? `${when(view.checked_at)}${view.last_ok_at ? ` · last OK ${when(view.last_ok_at)}` : ""}` : "Never";
      const grantable = view.tools.filter(tool => tool.grantable);
      $("connector-tool-count").textContent = `${view.granted_tools.length} of ${grantable.length} granted${view.discovered_count ? ` · ${view.discovered_count} offered` : ""}`;
      $("connector-token-label").textContent = view.credential.set ? "Replace access token" : "Access token";
      $("btn-connector-token").textContent = view.credential.set ? "Replace token" : "Save token";
      $("btn-connector-check").disabled = !view.credential.set || !view.enabled;

      const tools = $("connector-tools");
      tools.replaceChildren();
      for (const tool of grantable) {
        const offered = tool.discovered || !view.discovered_count;
        const detail = tool.discovered ? escapeHtml(tool.title || (tool.description || "").split(/[.\n]/)[0] || "") : view.discovered_count ? "Not offered to this account" : "Test the connection to load details";
        tools.append(checkbox(`<code>${escapeHtml(tool.name)}</code>`, tool.granted, (checked) => {
          const next = new Set(view.granted_tools);
          checked ? next.add(tool.name) : next.delete(tool.name);
          mutate(() => post(`/api/connectors/${view.id}/tools`, { tools: [...next] }));
        }, { disabled: !offered && !tool.granted, detail }));
      }
      const other = view.tools.filter(tool => !tool.grantable && tool.discovered).length;
      $("connector-tools-other").textContent = other
        ? `${other} other ${other === 1 ? "tool is" : "tools are"} offered by the service but outside this release’s supported read-only tools, so ${other === 1 ? "it" : "they"} cannot be granted.`
        : "";

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
      $("btn-connector-remove").textContent = "Disconnect…";
    }

    async function loadAudit() {
      const wrap = $("connector-audit");
      if (!current) return;
      try {
        const { audit } = await api(`/api/connectors/${current.id}`);
        wrap.replaceChildren();
        if (!audit.length) { wrap.innerHTML = '<p class="hint connector-empty-hint">No calls yet.</p>'; return; }
        for (const entry of audit.slice(0, 10)) {
          const row = document.createElement("div");
          row.className = "proj-row connector-audit-row";
          row.innerHTML = `<div><code>${escapeHtml(entry.tool)}</code><div class="pick-path">${escapeHtml(entry.session_name || "unknown session")} · ${agoStr(entry.at)}</div></div><span class="connector-outcome" data-outcome="${escapeHtml(entry.outcome)}">${escapeHtml(OUTCOMES[entry.outcome] ?? entry.outcome)}</span>`;
          wrap.append(row);
        }
      } catch { wrap.innerHTML = '<p class="hint connector-empty-hint">Recent calls are unavailable.</p>'; }
    }

    async function load() {
      const mine = ++generation;
      let data;
      try { data = await api("/api/connectors"); } catch (error) { showToast(error.message); return; }
      if (mine !== generation) return;
      current = data.connectors[0] ?? null;
      const presets = $("connector-presets");
      presets.replaceChildren();
      for (const preset of data.presets.filter(p => !p.added)) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "btn btn-primary btn-big";
        button.textContent = `Add ${preset.label}`;
        button.addEventListener("click", () => mutate(() => api("/api/connectors", { method: "POST", body: JSON.stringify({ preset: preset.id }) })));
        presets.append(button);
      }
      render();
      loadAudit();
    }

    $("form-connector-token").addEventListener("submit", (event) => {
      event.preventDefault();
      const input = $("input-connector-token");
      const token = input.value.trim();
      if (!token || !current) return;
      mutate(async () => {
        const saved = await post(`/api/connectors/${current.id}/credential`, { token });
        input.value = "";
        showToast("Token saved. Testing…");
        return post(`/api/connectors/${saved.connector.id}/check`);
      });
    });
    $("btn-connector-check").addEventListener("click", () => {
      if (!current) return;
      $("connector-state").textContent = "Checking…";
      mutate(() => post(`/api/connectors/${current.id}/check`));
    });
    $("btn-connector-recommended").addEventListener("click", () => {
      if (!current) return;
      const tools = current.tools.filter(tool => tool.recommended && (tool.discovered || !current.discovered_count)).map(tool => tool.name);
      mutate(() => post(`/api/connectors/${current.id}/tools`, { tools: [...new Set([...current.granted_tools, ...tools])] }));
    });
    $("btn-connector-enabled").addEventListener("click", () => {
      if (current) mutate(() => post(`/api/connectors/${current.id}/enabled`, { enabled: !current.enabled }));
    });
    $("btn-connector-remove").addEventListener("click", async () => {
      if (!current) return;
      if (!removeArmed) { removeArmed = true; $("btn-connector-remove").textContent = "Confirm disconnect"; return; }
      try { await api(`/api/connectors/${current.id}`, { method: "DELETE" }); showToast("Connector removed"); }
      catch (error) { showToast(error.message); }
      await load();
    });

    // The token field never keeps a value once the sheet closes (Escape, Close, Back or the scrim).
    new MutationObserver(() => { if ($("sheet-connectors").hidden) $("input-connector-token").value = ""; })
      .observe($("sheet-connectors"), { attributes: true, attributeFilter: ["hidden"] });

    return {
      open() {
        current = null; render(); $("connectors-empty").hidden = true;
        $("input-connector-token").value = "";
        load(); openSheet("sheet-connectors");
      },
    };
  };
})();
