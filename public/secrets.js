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

  // renderRequests (optional) draws the pending requests from sessions at the top
  // (secret-request.js's renderSettingsList, whose Open opens a request by id).
  window.createSecretsUI = ({ $, api, openSheet, showToast, agoStr, escapeHtml, renderRequests = null }) => {
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

    async function load({ quiet = false } = {}) {
      try {
        const data = await api("/api/secrets");
        renderSecrets(data.secrets);
        renderSources(data.sources);
      } catch (e) {
        if (quiet) console.warn("Settings search: secrets didn't load:", e.message);
        else showToast(e.message);
      }
    }

    // Hidden when there are none, or when they can't be read: the stored secrets still work.
    async function loadRequests() {
      if (!renderRequests) return;
      let requests = [];
      try { requests = (await api("/api/secret-requests")).requests || []; } catch {}
      renderRequests($("secret-requests"), requests);
    }

    /* ---------- import ---------- */
    // Parsed entries (with values) live only in this closure, never in the DOM, and are
    // dropped after a save, a cancel, or reopening the sheet.
    const SI = window.SecretImport;
    let importFile = null;   // { name, text } from the file picker
    let parsed = null;       // SecretImport.parse result
    let rows = [];
    let importBusy = false;
    const STATUS_LABEL = { new: "New", replace: "Replace", unchanged: "Unchanged", invalid: "Invalid" };

    function resetImport({ keepInput = false } = {}) {
      parsed = null;
      rows = [];
      const preview = $("secret-import-preview");
      preview.hidden = true;
      preview.innerHTML = "";
      if (keepInput) return;
      importFile = null;
      $("input-secret-import").value = "";
      $("input-secret-import-file").value = "";
      $("secret-import-file").hidden = true;
      $("select-secret-import-format").value = "auto";
    }

    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

    function renderPreview() {
      const wrap = $("secret-import-preview");
      const c = SI.counts(rows);
      wrap.innerHTML = "";
      wrap.hidden = false;
      const summary = document.createElement("p");
      summary.className = "hint secret-import-summary";
      summary.setAttribute("role", "status");
      summary.textContent = [c.new && `${c.new} new`, c.replace && `${c.replace} already stored`, c.unchanged && `${c.unchanged} unchanged`, c.invalid && `${c.invalid} invalid`]
        .filter(Boolean).join(" · ") || "Nothing to import.";
      wrap.appendChild(summary);

      const table = document.createElement("table");
      table.className = "secret-import-table";
      table.innerHTML = '<thead><tr><th scope="col">Name</th><th scope="col">Value</th><th scope="col">Status</th></tr></thead>';
      const body = document.createElement("tbody");
      for (const row of rows) {
        const tr = document.createElement("tr");
        tr.className = `si-${row.status}`;
        const name = document.createElement("td");
        name.className = "si-name";
        name.textContent = row.name || (row.line ? `Line ${row.line}` : "—");
        const size = document.createElement("td");
        size.className = "si-size";
        size.textContent = row.index >= 0 ? plural(row.length, "character", "characters") : "";
        const status = document.createElement("td");
        status.className = "si-status";
        if (row.status === "replace") {
          const label = document.createElement("label");
          const box = document.createElement("input");
          box.type = "checkbox";
          box.className = "si-replace-box";
          box.dataset.name = row.name;
          box.addEventListener("change", updateSave);
          label.append(box, " Replace stored value");
          status.appendChild(label);
        } else {
          status.textContent = STATUS_LABEL[row.status];
        }
        if (row.reason) {
          const reason = document.createElement("div");
          reason.className = "si-reason";
          reason.textContent = row.line && row.name ? `Line ${row.line}: ${row.reason}` : row.reason;
          status.appendChild(reason);
        }
        if (row.suggestion) {
          const use = document.createElement("button");
          use.type = "button";
          use.className = "proj-act si-use";
          use.textContent = `Use ${row.suggestion}`;
          use.addEventListener("click", () => {
            parsed.entries[row.index].name = row.suggestion;
            SI.annotate(parsed.entries);
            preview();
          });
          status.appendChild(use);
        }
        tr.append(name, size, status);
        body.appendChild(tr);
      }
      table.appendChild(body);
      wrap.appendChild(table);

      if (c.invalid) {
        const label = document.createElement("label");
        label.className = "si-leave-out";
        const box = document.createElement("input");
        box.type = "checkbox";
        box.id = "check-secret-import-leave-out";
        box.addEventListener("change", updateSave);
        label.append(box, ` Leave out the ${plural(c.invalid, "invalid entry", "invalid entries")} and save the rest`);
        wrap.appendChild(label);
      }
      const save = document.createElement("button");
      save.id = "btn-secret-import-save";
      save.type = "button";
      save.className = "btn btn-primary btn-big";
      save.addEventListener("click", saveImport);
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn btn-ghost btn-big";
      cancel.textContent = "Cancel import";
      cancel.addEventListener("click", () => resetImport());
      wrap.append(save, cancel);
      updateSave();
    }

    const tickedReplacements = () => [...$("secret-import-preview").querySelectorAll("input.si-replace-box")].filter(box => box.checked).map(box => box.dataset.name);

    function updateSave() {
      const save = $("btn-secret-import-save");
      if (!save) return;
      const c = SI.counts(rows);
      const writes = c.new + tickedReplacements().length;
      const leaveOut = $("check-secret-import-leave-out");
      save.textContent = writes ? `Save ${plural(writes, "secret", "secrets")}` : "Nothing to save";
      save.disabled = importBusy || !writes || (c.invalid > 0 && !(leaveOut && leaveOut.checked));
    }

    async function preview() {
      if (!parsed) return;
      const entries = parsed.entries.map(e => ({ name: e.name, value: e.value }));
      try {
        const server = entries.length ? (await api("/api/secrets/import/preview", { method: "POST", body: JSON.stringify({ entries }) })).entries : [];
        rows = SI.previewRows(parsed, server);
        renderPreview();
      } catch (e) { showToast(e.message); }
    }

    async function saveImport() {
      if (importBusy || !parsed) return;
      const request = SI.importBody(parsed, rows, tickedReplacements());
      importBusy = true;
      updateSave();
      try {
        const result = await api("/api/secrets/import", { method: "POST", body: JSON.stringify({ entries: request.entries, replace: request.replace }) });
        resetImport();
        showToast(result.saved.length ? `${plural(result.saved.length, "secret", "secrets")} saved for every session` : "Nothing changed");
        await load();
      } catch (e) {
        if (e.code === "invalid_entries" && e.entries) {
          // Show the server's reasons on the rows that were sent; nothing was saved.
          request.indices.forEach((index, i) => {
            const server = e.entries[i];
            const row = rows.find(r => r.index === index);
            if (row && server) { row.status = server.status; row.reason = server.reason; }
          });
          renderPreview();
        }
        showToast(e.message);
      } finally { importBusy = false; updateSave(); }
    }

    $("form-secret-import").addEventListener("submit", (ev) => {
      ev.preventDefault();
      const typed = $("input-secret-import").value;
      const text = typed.trim() ? typed : importFile ? importFile.text : "";
      if (!text.trim()) { showToast("Paste a .env file or JSON, or choose a file."); return; }
      parsed = SI.parse(text, $("select-secret-import-format").value);
      if (!parsed.entries.length && !parsed.problems.length) { resetImport({ keepInput: true }); showToast("No secrets found in that text."); return; }
      preview();
    });
    $("input-secret-import").addEventListener("input", () => {
      resetImport({ keepInput: true });
      if (importFile && $("input-secret-import").value) { importFile = null; $("input-secret-import-file").value = ""; $("secret-import-file").hidden = true; }
    });
    $("select-secret-import-format").addEventListener("change", () => resetImport({ keepInput: true }));
    $("input-secret-import-file").addEventListener("change", () => {
      const file = $("input-secret-import-file").files[0];
      resetImport({ keepInput: true });
      if (!file) return;
      if (file.size > SI.MAX_FILE_BYTES) { $("input-secret-import-file").value = ""; showToast("That file is over 512 KB. Choose a .env or JSON file of secrets."); return; }
      const reader = new FileReader();
      reader.onload = () => {
        // The file's text stays in memory; it is not copied into the field, so its values are not shown.
        importFile = { name: file.name, text: String(reader.result || "") };
        $("input-secret-import").value = "";
        const note = $("secret-import-file");
        note.textContent = `${file.name} loaded (${Math.max(1, Math.round(file.size / 1024))} KB). Review it to see its names.`;
        note.hidden = false;
      };
      reader.onerror = () => showToast("That file could not be read.");
      reader.readAsText(file);
    });

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
        resetImport();
        showKind();
        load();
        loadRequests();
        openSheet("sheet-secrets");
      },
      reloadRequests: loadRequests,
      /** Renders the saved names (never values) without opening the sheet, for settings search. */
      preload: () => load({ quiet: true }),
    };
  };
})();
