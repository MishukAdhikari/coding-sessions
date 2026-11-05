/* Coding Sessions — Secrets (Settings › Secrets). Write-only: the server never returns a value. */
(() => {
  const KINDS = {
    bitwarden: { name: "Bitwarden", credential: "Machine account access token" },
    infisical: { name: "Infisical", credential: "Machine identity client secret" },
    vault: { name: "Vault", credential: "Vault token" },
  };
  const NAME_RE = /^[A-Z][A-Z0-9_]{0,63}$/;

  /** One line describing where a source reads from, from its non-secret config. */
  function where(source) {
    const c = source.config || {};
    if (source.kind === "bitwarden") return c.projectId ? `project ${c.projectId}` : "all projects the token can read";
    if (source.kind === "infisical") return `${c.environment} · ${c.secretPath} · ${c.projectId}`;
    return `${c.address ? new URL(c.address).host : ""} · ${c.mount}/${c.path}`;
  }

  window.createSecretsUI = ({ $, api, openSheet, showToast, agoStr, escapeHtml }) => {
    let busy = false;
    let removeArmed = null; // a remove needs a second tap; a secret cannot be recovered

    const kind = () => $("select-secret-source").value;
    function showKind() {
      document.querySelectorAll("#form-secret-source .secret-fields").forEach(el => { el.hidden = el.dataset.kind !== kind(); });
      $("input-source-credential").placeholder = KINDS[kind()].credential;
    }

    function removeButton(key, label, onRemove) {
      const button = document.createElement("button");
      button.className = "proj-del";
      button.type = "button";
      button.textContent = "Remove";
      button.setAttribute("aria-label", `Remove ${label}`);
      button.addEventListener("click", async () => {
        if (removeArmed !== key) {
          removeArmed = key;
          button.textContent = "Confirm";
          setTimeout(() => { if (removeArmed === key) { removeArmed = null; button.textContent = "Remove"; } }, 4000);
          return;
        }
        removeArmed = null;
        try { await onRemove(); await load(); } catch (e) { showToast(e.message); }
      });
      return button;
    }

    function renderSecrets(secrets) {
      const wrap = $("secret-list");
      wrap.innerHTML = "";
      if (!secrets.length) {
        wrap.innerHTML = '<p class="hint" style="text-align:left;margin:2px 2px 10px">No secrets yet. Add one below.</p>';
        return;
      }
      for (const s of secrets) {
        const row = document.createElement("div");
        row.className = "proj-row";
        row.innerHTML = `<span>${escapeHtml(s.name)}<div class="pick-path">updated ${escapeHtml(agoStr(s.updatedAt))}</div></span>`;
        const actions = document.createElement("div");
        actions.className = "row-actions";
        const replace = document.createElement("button");
        replace.className = "proj-act";
        replace.type = "button";
        replace.textContent = "Replace";
        replace.setAttribute("aria-label", `Replace ${s.name}`);
        replace.addEventListener("click", () => {
          $("input-secret-name").value = s.name;
          $("input-secret-value").value = "";
          $("input-secret-value").focus();
        });
        actions.append(replace, removeButton(`secret:${s.name}`, s.name,
          () => api(`/api/secrets/${encodeURIComponent(s.name)}`, { method: "DELETE" })));
        row.appendChild(actions);
        wrap.appendChild(row);
      }
    }

    function renderSources(sources) {
      const wrap = $("secret-source-list");
      wrap.innerHTML = "";
      for (const source of sources) {
        const row = document.createElement("div");
        row.className = "proj-row";
        const names = source.names.length
          ? `${source.names.length} ${source.names.length === 1 ? "secret" : "secrets"}: ${source.names.slice(0, 6).join(", ")}${source.names.length > 6 ? "…" : ""}`
          : "no usable secrets";
        const synced = source.lastSyncAt ? `synced ${agoStr(source.lastSyncAt)}` : "never synced";
        row.innerHTML = `<span>${escapeHtml(source.label)}<div class="pick-path">${escapeHtml(KINDS[source.kind].name)} · ${escapeHtml(where(source))}</div>` +
          `<div class="pick-path">${escapeHtml(names)} · ${escapeHtml(synced)}</div>` +
          (source.lastError ? `<div class="pick-path row-error">${escapeHtml(source.lastError)}</div>` : "") + "</span>";
        const actions = document.createElement("div");
        actions.className = "row-actions";
        const sync = document.createElement("button");
        sync.className = "proj-act";
        sync.type = "button";
        sync.textContent = "Sync";
        sync.setAttribute("aria-label", `Sync ${source.label} now`);
        sync.addEventListener("click", async () => {
          sync.disabled = true;
          try { await api(`/api/secret-sources/${source.id}/sync`, { method: "POST" }); showToast(`${source.label} synced`); }
          catch (e) { showToast(e.message); }
          await load();
        });
        actions.append(sync, removeButton(`source:${source.id}`, source.label,
          () => api(`/api/secret-sources/${source.id}`, { method: "DELETE" })));
        row.appendChild(actions);
        wrap.appendChild(row);
      }
    }

    async function load() {
      try {
        const data = await api("/api/secrets");
        renderSecrets(data.secrets);
        renderSources(data.sources);
      } catch (e) { showToast(e.message); }
    }

    $("select-secret-source").addEventListener("change", showKind);

    $("form-secret").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      const name = $("input-secret-name").value.trim().toUpperCase();
      if (!NAME_RE.test(name)) { showToast("Name it like an env var, e.g. OPENAI_API_KEY."); return; }
      try {
        await api(`/api/secrets/${encodeURIComponent(name)}`, { method: "PUT", body: JSON.stringify({ value: $("input-secret-value").value }) });
        $("input-secret-name").value = "";
        $("input-secret-value").value = "";
        showToast(`${name} saved for new sessions`);
        await load();
      } catch (e) { showToast(e.message); }
    });

    $("form-secret-source").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (busy) return;
      const config = {};
      document.querySelectorAll(`#form-secret-source .secret-fields[data-kind="${kind()}"] input[name]`).forEach(input => {
        if (input.value.trim()) config[input.name] = input.value.trim();
      });
      busy = true;
      const button = $("btn-source-add");
      button.disabled = true;
      button.textContent = "Testing…";
      try {
        const { source } = await api("/api/secret-sources", {
          method: "POST",
          body: JSON.stringify({ kind: kind(), label: $("input-source-label").value.trim(), config, credential: $("input-source-credential").value }),
        });
        $("form-secret-source").reset();
        showKind();
        showToast(`${source.label} connected: ${source.names.length} ${source.names.length === 1 ? "secret" : "secrets"}`);
        await load();
      } catch (e) { showToast(e.message); }
      finally { busy = false; button.disabled = false; button.textContent = "Connect and test"; }
    });

    return {
      open() {
        removeArmed = null;
        $("form-secret").reset();
        showKind();
        load();
        openSheet("sheet-secrets");
      },
    };
  };
})();
