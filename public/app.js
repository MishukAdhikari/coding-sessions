/* Coding Sessions — app logic (no framework, no build step) */
(() => {
  const $ = (id) => document.getElementById(id);
  const api = async (path, opts = {}) => {
    const res = await fetch(path, {
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      ...opts,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  };

  let me = null;
  let sessions = [];
  let archived = [];
  let sessionQuery = "";
  let projects = [];
  let selectedProject = null;
  let lastListJson = "";
  let pollTimer = null;
  let refreshVersion = 0;
  let appliedRefreshVersion = 0;
  let sessionSyncLost = false;
  let tab = localStorage.getItem("xs_tab") || "active";
  let capabilities = null;
  let capabilitiesResolved = false;
  let agentAuth = null;
  let cliUpdatePoll = null;

  const LEGACY_CLAUDE_CAPABILITIES = {
    displayName: "Claude",
    webTerminal: true,
    exactResume: true,
    remoteControl: true,
    nativeChatUrl: true,
    chatDeletion: true,
    externalDiscovery: true,
    authentication: "setup-token",
  };

  const isCommandProvider = (provider) => typeof provider === "string" && provider.startsWith("cmd:");
  const BUILTIN_PROVIDERS = ["codex", "command-code"];
  const providerOf = (item) => {
    const p = item?.provider;
    return BUILTIN_PROVIDERS.includes(p) || isCommandProvider(p) ? p : "claude";
  };
  const registeredCommands = () => (Array.isArray(capabilities?.commands) ? capabilities.commands : []);
  const commandFor = (provider) => registeredCommands().find((c) => c.provider === provider) || null;
  const builtinSupported = (provider) => capabilities?.launchProtocol === 2
    && Array.isArray(capabilities.supportedProviders)
    && capabilities.supportedProviders.includes(provider)
    && capabilities.providers?.[provider]?.managedLaunch === true;
  const codexSupported = () => builtinSupported("codex");
  const commandCodeSupported = () => builtinSupported("command-code");
  // A Command gets the lifecycle this app owns and nothing it can't honestly deliver.
  const COMMAND_CAPABILITIES = {
    displayName: "Command", managedLaunch: true, freshWorkspace: true, webTerminal: true,
    semanticStatus: false, exactResume: false, remoteControl: false, nativeChatUrl: false,
    chatDeletion: false, externalDiscovery: false, syncedLaunch: false, authentication: "external",
  };
  const providerCapabilities = (provider) => {
    if (isCommandProvider(provider)) return commandFor(provider) ? COMMAND_CAPABILITIES : null;
    if (provider === "claude") return capabilities?.providers?.claude || LEGACY_CLAUDE_CAPABILITIES;
    return builtinSupported(provider) ? capabilities.providers[provider] : null;
  };
  const FALLBACK_NAMES = { codex: "Codex", "command-code": "Command Code" };
  const providerName = (provider) => commandFor(provider)?.label
    || providerCapabilities(provider)?.displayName
    || FALLBACK_NAMES[provider]
    || (isCommandProvider(provider) ? "Command" : "Claude");
  const providerHas = (provider, capability) => providerCapabilities(provider)?.[capability] === true;
  const providerChipClass = (provider) => `chip-provider-${isCommandProvider(provider) ? "command" : provider}`;
  const codexAuthSupported = () => codexSupported()
    && providerCapabilities("codex")?.authentication === "device-auth";
  const commandCodeAuthSupported = () => commandCodeSupported()
    && providerCapabilities("command-code")?.authentication === "api-key";
  // Whether a key is stored — never the key itself; no route returns one.
  const commandCodeHasToken = () => capabilities?.commandCode?.hasToken === true;

  async function loadCapabilities() {
    try {
      const next = await api("/api/capabilities");
      capabilities = next && typeof next === "object" ? next : null;
    } catch {
      capabilities = null;
    } finally {
      capabilitiesResolved = true;
      updateProviderAvailability();
      agentAuth?.updateAvailability();
    }
  }

  const NOTIFY_KEY = "xs_notify";
  let notifyOn = localStorage.getItem(NOTIFY_KEY) === "1";
  let prevAsking = null; // Set of session ids asking last poll; null until primed (suppresses first-load storm)

  /* ---------- boot ---------- */

  // A one-time link from `coding-sessions setup-link`. It's taken out of the address bar
  // at once, so it isn't kept in history or copied with the URL, and it's only spent
  // when someone presses the button: a link scanner that merely opens it can't use it.
  let setupToken = location.hash.startsWith("#setup=") ? location.hash.slice("#setup=".length) : null;
  if (setupToken) history.replaceState(null, "", location.pathname + location.search);

  // `cs server add` opens #cli-login=CODE. The code alone grants nothing: Allow needs
  // this signed-in browser, so it waits through a sign-in if there is one first.
  const readCliLoginCode = () => {
    const m = location.hash.match(/^#cli-login=([A-Za-z-]{4,12})$/);
    if (location.hash.startsWith("#cli-login=")) history.replaceState(null, "", location.pathname + location.search);
    return m ? m[1].toUpperCase() : null;
  };
  let cliLoginCode = readCliLoginCode();

  // Never a blank page: until the server answers, the offline screen says so and
  // offers a retry, and coming back online or to the app retries on its own.
  let booting = false;
  async function boot() {
    if (booting) return;
    booting = true;
    $("btn-retry").disabled = true;
    try {
      me = await api("/api/me");
    } catch {
      showOffline();
      return;
    } finally {
      booting = false;
      $("btn-retry").disabled = false;
    }
    $("offline").hidden = true;
    me.authed ? enterApp() : showLogin();
    if (setupToken && me.authed) setupToken = null; // already signed in; leave the link unused
  }

  $("btn-setup-link").addEventListener("click", async () => {
    try {
      await api("/api/auth/setup", { method: "POST", body: JSON.stringify({ token: setupToken }) });
      setupToken = null;
      me = await api("/api/me");
      enterApp();
      if (!me.hasPasskey) openSheet("sheet-welcome");
    } catch (e) {
      setupToken = null;
      $("btn-setup-link").hidden = true;
      showLogin();
      loginError(e.message);
    }
  });

  function showOffline() {
    if (!$("login").hidden || !$("app").hidden) return; // already running: the list says "Connection lost · retrying…"
    $("offline").hidden = false;
  }
  $("btn-retry").addEventListener("click", boot);

  /* ---------- login ---------- */

  function showLogin() {
    $("login").hidden = false;
    $("app").hidden = true;
    $("btn-setup-link").hidden = !setupToken;
    const canPasskey = me.hasPasskey && window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn();
    $("btn-passkey").hidden = !canPasskey;
    $("form-password").hidden = canPasskey;
    $("btn-use-password").hidden = !canPasskey;
    startPasskeyAutofill();
  }

  // Passkey autofill: where the browser can offer the saved passkey among the
  // password field's suggestions (iOS's bar above the keyboard, Android's
  // autofill), a passkey request waits quietly behind that field. Unlock stays
  // the explicit way in, and cancels this request when it starts its own.
  async function startPasskeyAutofill() {
    const webauthn = window.SimpleWebAuthnBrowser;
    let supported = false;
    try { supported = await webauthn?.browserSupportsWebAuthnAutofill?.(); } catch {}
    if (!window.NativeShell.passkeyAutofillPlan({ supported, hasPasskey: me?.hasPasskey === true, setupToken })) return;
    let response;
    let challengeId;
    try {
      const started = await api("/api/auth/login/options");
      challengeId = started.challengeId;
      response = await webauthn.startAuthentication({ optionsJSON: started.options, useBrowserAutofill: true });
    } catch {
      return; // cancelled by Unlock or by leaving the page, or never chosen: nothing to say
    }
    try {
      await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ challengeId, response }) });
      enterApp();
    } catch (e) {
      loginError(e.message || "Couldn’t unlock.");
    }
  }

  function loginError(msg) {
    const el = $("login-error");
    el.textContent = msg;
    el.hidden = false;
  }

  $("btn-passkey").addEventListener("click", async () => {
    const startedAt = Date.now();
    window.SimpleWebAuthnBrowser?.WebAuthnAbortService?.cancelCeremony();
    try {
      const { options, challengeId } = await api("/api/auth/login/options");
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      await api("/api/auth/login/verify", { method: "POST", body: JSON.stringify({ challengeId, response }) });
      enterApp();
    } catch (e) {
      // NotAllowedError covers two different events the API refuses to tell apart:
      // the user dismissed the prompt, or this device holds no passkey for this
      // address and no prompt was ever shown. A rejection this fast is the second
      // one — say what to do about it rather than looking broken. A slower one is
      // a real dismissal, and stays quiet.
      if (e.name !== "NotAllowedError") loginError(e.message || "Couldn't unlock.");
      else if (Date.now() - startedAt < 600) {
        loginError("No passkey on this device yet — sign in with your password, then add Face ID / Touch ID from the menu.");
      }
      startPasskeyAutofill(); // the field's suggestions offer it again
    }
  });

  $("btn-use-password").addEventListener("click", () => {
    $("form-password").hidden = false;
    $("btn-use-password").hidden = true;
    $("btn-passkey").hidden = true;
    $("input-password").focus();
  });

  $("form-password").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/auth/password", { method: "POST", body: JSON.stringify({ password: $("input-password").value }) });
      $("input-password").value = "";
      enterApp();
      maybeOfferPasskey();
    } catch (e) {
      loginError(e.message);
    }
  });

  async function maybeOfferPasskey() {
    if (me.hasPasskey || !window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn()) return;
    showToast("Tip: add Face ID in the menu for one-tap sign in");
  }

  async function addPasskey() {
    try {
      const { options, challengeId } = await api("/api/auth/register/options");
      const response = await SimpleWebAuthnBrowser.startRegistration({ optionsJSON: options });
      const label = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : "Mac";
      await api("/api/auth/register/verify", { method: "POST", body: JSON.stringify({ challengeId, response, label }) });
      me.hasPasskey = true;
      showToast("Passkey added — next sign-in is one tap");
    } catch (e) {
      if (e.name !== "NotAllowedError") showToast(e.message || "Couldn't add passkey");
    }
  }

  /* ---------- app ---------- */

  function enterApp() {
    $("login").hidden = true;
    $("app").hidden = false;
    const capabilitiesLoaded = loadCapabilities();
    const params = new URLSearchParams(location.search);
    // Returning from an external MCP sign-in: open that connector (by id only) or the list.
    if (params.get("settings") === "connector" || params.get("settings") === "connectors") {
      const id = params.get("id");
      history.replaceState(null, "", location.pathname);
      // Seed the same sheet stack a click path builds (Settings › connectors › detail), so Back works.
      openSheet("sheet-menu");
      if (params.get("settings") === "connector" && /^[0-9a-f-]{36}$/.test(id ?? "")) connectorsUI.openConnector(id);
      else connectorsUI.open();
    }
    if (params.get("settings") === "agent-auth") {
      const provider = params.get("agent");
      if (["claude", "codex", "command-code"].includes(provider)) {
        capabilitiesLoaded.then(() => agentAuth?.openAccounts(provider));
        history.replaceState(null, "", location.pathname);
      }
    }
    // The home-screen shortcut "Start a session" (manifest.webmanifest).
    if (params.get("action") === "new") {
      history.replaceState(null, "", location.pathname);
      capabilitiesLoaded.then(() => $("btn-new").click());
    }
    if (cliLoginCode) openCliLogin();
    // Back from chat or the terminal on a page iOS had discarded: return to where
    // the list was (saved in its history entry before leaving).
    refresh(true).then(() => {
      const y = Number(history.state?.scrollY);
      if (y > 0) requestAnimationFrame(() => window.scrollTo(0, y));
    });
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 4000);
  }


  async function refresh(force = false) {
    const version = ++refreshVersion;
    let data;
    try {
      data = await api("/api/sessions");
    } catch (e) {
      if (version < appliedRefreshVersion) return;
      appliedRefreshVersion = version;
      if (String(e.message).includes("Unauthorized")) { location.reload(); }
      sessionSyncLost = true;
      renderList();
      return;
    }
    if (version < appliedRefreshVersion) return;
    appliedRefreshVersion = version;
    force ||= sessionSyncLost;
    sessionSyncLost = false;
    sessions = data.sessions || [];
    archived = data.archived || [];
    if (openSheetEl?.id === "sheet-confirm" && confirmSessionId) {
      const current = sessions.find((item) => item.id === confirmSessionId);
      if (current) syncSessionActions(current);
    }
    renderHost(data.host);
    checkAskingTransitions(sessions); // before the early-return, so a flip never gets swallowed
    const json = JSON.stringify([sessions, archived]);
    if (!force && json === lastListJson) return;
    lastListJson = json;
    renderList();
  }

  /* ---------- notifications ---------- */
  /* Local notifications (no server push infra): the poll detects a session flipping
     into the "asking" state and fires one notification via the service worker. */

  const telemetryUnknown = (s) => s.telemetryUnknown === true || s.telemetry_unknown === true;
  const sessionIsBusy = (s) => !sessionSyncLost && window.sessionStatus(s).state === "running";
  const sessionIsAsking = (s) => !sessionSyncLost && window.sessionStatus(s).state === "waiting";

  const notifySupported = () => "Notification" in window;
  const notifyActive = () => notifyOn && notifySupported() && Notification.permission === "granted";

  function checkAskingTransitions(list) {
    const nowAsking = new Set(list.filter(sessionIsAsking).map((s) => s.id));
    // First poll after boot seeds the baseline silently — sessions already asking
    // at startup shouldn't all notify at once.
    if (prevAsking === null) { prevAsking = nowAsking; return; }
    if (notifyActive()) {
      for (const s of list) if (sessionIsAsking(s) && !prevAsking.has(s.id)) notify(s);
    }
    prevAsking = nowAsking;
  }

  function notify(s) {
    const title = `${s.name} needs your answer`;
    const opts = {
      body: s.projectLabel || s.project || `${providerName(providerOf(s))} is waiting on you`,
      tag: `xs-ask-${s.id}`, // dedupe: replaces any prior notification for this session
      icon: "/apple-touch-icon.png",
      badge: "/apple-touch-icon.png",
    };
    const fallback = () => { try { new Notification(title, opts); } catch {} };
    try {
      if (!("serviceWorker" in navigator)) return fallback();
      // serviceWorker.ready never resolves if no SW ever activates (e.g. registration
      // failed) — race a short timeout so a notification can't be silently lost.
      Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, reject) => setTimeout(reject, 3000)),
      ])
        .then((reg) => reg.showNotification(title, opts))
        .catch(fallback);
    } catch { fallback(); }
  }

  // Returns true if notifications ended up on. Requests permission on enable.
  async function setNotify(on) {
    if (on) {
      if (!notifySupported()) { showToast("This browser can't show notifications."); return false; }
      let perm = Notification.permission;
      if (perm === "default") { try { perm = await Notification.requestPermission(); } catch { perm = "denied"; } }
      if (perm !== "granted") { showToast("Allow notifications in your browser settings to turn these on."); return false; }
      notifyOn = true; localStorage.setItem(NOTIFY_KEY, "1");
      return true;
    }
    notifyOn = false; localStorage.setItem(NOTIFY_KEY, "0");
    return true;
  }

  function humanDuration(sec) {
    if (sec == null) return "";
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
    return `${Math.floor(sec / 86400)}d ${Math.floor((sec % 86400) / 3600)}h`;
  }

  function statusLine(s) {
    const status = sessionSyncLost
      ? { state: "stale", label: "Status unavailable", detail: "Connection lost. Retrying automatically." }
      : window.sessionStatus(s);
    const detail = s.phase === "failed" ? s.errorMessage || status.detail : status.detail;
    const icon = status.state === "finished"
      ? '<svg class="status-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 12 2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>'
      : '<span class="s-dot" aria-hidden="true"></span>';
    return `<span class="activity-label" title="${escapeHtml(detail)}">${icon}${status.label}</span>${s.phase === "failed" && s.errorMessage ? `<span class="activity-detail">${escapeHtml(s.errorMessage)}</span>` : ""}`;
  }

  function agoStr(ms) {
    const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
    if (sec < 60) return "just now";
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  function setTab(t) {
    tab = t;
    localStorage.setItem("xs_tab", t);
    renderList();
  }
  document.querySelectorAll(".tab").forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));

  /* ---------- host pressure ---------- */
  /* CPU / RAM / disk of the box the Sessions run on, refreshed by the same poll.
     Disk turns red below the 5G a Fresh Launch needs, so the strip warns before
     the server starts refusing launches. */

  function setMeter(key, pct, text, title, level) {
    const bar = $(`host-${key}-bar`);
    bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    $(`host-${key}`).textContent = text;
    const row = bar.closest(".host-row");
    row.dataset.level = level || (pct >= 90 ? "hot" : pct >= 75 ? "warn" : "ok");
    row.title = title;
  }

  function renderHost(h) {
    const el = $("host");
    if (!h || typeof h.cpu !== "number") { el.hidden = true; return; }
    el.hidden = false;
    setMeter("cpu", h.cpu, `${h.cpu}%`, `CPU ${h.cpu}% busy`);
    setMeter("mem", h.mem, `${h.mem}%`, `RAM ${h.memUsedGb}G of ${h.memTotalGb}G used`);
    setMeter("disk", h.disk, `${h.diskFreeGb}G free`,
      `Disk ${h.diskFreeGb}G free, ${h.disk}% used — a new session needs 5G free`,
      h.diskFreeGb < 5 ? "hot" : h.diskFreeGb < 10 ? "warn" : "ok");
  }

  $("session-search-form").addEventListener("submit", event => event.preventDefault());
  $("session-search").addEventListener("input", event => {
    sessionQuery = event.target.value;
    renderList();
  });
  function clearSessionSearch() {
    sessionQuery = "";
    $("session-search").value = "";
    renderList();
    $("session-search").focus();
  }
  $("clear-session-search").addEventListener("click", clearSessionSearch);
  $("session-search").addEventListener("keydown", event => {
    if (event.key === "Escape" && sessionQuery) {
      event.preventDefault();
      event.stopPropagation();
      clearSessionSearch();
    }
  });

  function renderList() {
    const list = $("list");
    const focusedId = list.contains(document.activeElement) ? document.activeElement.dataset.sessionId : null;
    list.innerHTML = "";
    const running = sessions.filter((s) => s.status === "running").length;
    const summary = sessionSyncLost ? "Connection lost · retrying…" : window.sessionActivitySummary(sessions);
    if ($("summary").textContent !== summary) $("summary").textContent = summary;
    document.body.dataset.state = sessions.some(sessionIsAsking) ? "needs" : sessions.some(sessionIsBusy) ? "working" : running > 0 ? "idle" : "quiet";

    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("selected", b.dataset.tab === tab);
      b.setAttribute("aria-pressed", String(b.dataset.tab === tab));
    });
    $("tabn-active").textContent = sessions.length || "";
    $("tabn-ended").textContent = archived.length || "";

    const showLive = tab !== "ended";
    const showArchived = tab !== "active";

    const matches = item => window.sessionMatches(item, sessionQuery, providerName(providerOf(item)));
    const liveMatches = showLive ? sessions.filter(matches) : [];
    const archivedMatches = showArchived ? archived.filter(matches) : [];
    $("clear-session-search").hidden = !sessionQuery;

    for (const s of liveMatches) {
      const card = document.createElement("button");
      const busy = sessionIsBusy(s);
      const asking = sessionIsAsking(s);
      const waiting = !telemetryUnknown(s) && s.waiting === true;
      const provider = providerOf(s);
      card.className = `card ${s.status}${s.phase === "failed" ? " failed" : ""}${busy ? " active" : ""}${s.status === "running" ? " running" : ""}${(waiting && !busy) ? " waiting" : ""}${(asking && !busy) ? " asking" : ""}${telemetryUnknown(s) ? " telemetry-unknown" : ""}`;
      card.dataset.activity = sessionSyncLost ? "stale" : window.sessionStatus(s).state;
      card.dataset.sessionId = s.id;
      card.innerHTML = `
        <span class="avatar">
          <span class="avatar-halo"></span>
          <span class="avatar-core">${escapeHtml(s.initial || s.name[0].toUpperCase())}</span>
        </span>
        <span class="card-main">
          <span class="card-name">${escapeHtml(s.name)}</span>
          <span class="card-sub">${escapeHtml(middlePath(s.projectLabel || s.project || "—"))}</span>
          <span class="card-status">${statusLine(s)}</span>
          ${prLinksHtml(s.prs)}
        </span>
        <span class="card-side">
          <span class="card-time">${humanDuration(s.uptimeSec)}</span>
          <br><span class="chip ${providerChipClass(provider)}">${escapeHtml(providerName(provider))}</span>
          ${s.model ? `<br><span class="chip chip-model">${escapeHtml(s.model)}</span>` : ""}
          ${s.kind === "external" ? '<br><span class="chip">external</span>' : ""}
        </span>`;
      card.addEventListener("click", (event) => {
        // A PR chip opens the PR, not the session's menu (the card is a button, so the chip can't be a real link).
        const pr = event.target.closest?.(".pr-link");
        if (pr) { event.stopPropagation(); openPrLink(pr.dataset.href); return; }
        confirmEnd(s);
      });
      card.addEventListener("keydown", (event) => {
        const pr = event.target.closest?.(".pr-link");
        if (pr && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); openPrLink(pr.dataset.href); }
      });
      list.appendChild(card);
    }

    for (const a of archivedMatches) {
      const ran = a.startedAt ? humanDuration(Math.floor((a.endedAt - a.startedAt) / 1000)) : "";
      const provider = providerOf(a);
      const card = document.createElement("button");
      card.className = "card ended archived";
      card.dataset.sessionId = `archive:${a.id}`;
      card.innerHTML = `
        <span class="avatar">
          <span class="avatar-core">${escapeHtml(a.initial || a.name[0].toUpperCase())}</span>
        </span>
        <span class="card-main">
          <span class="card-name">${escapeHtml(a.name)}</span>
          <span class="card-sub">${escapeHtml(middlePath(a.project || "—"))}</span>
          <span class="card-status">· Ended ${agoStr(a.endedAt)}${ran && ran !== "just now" ? ` · ran ${ran}` : ""}</span>
        </span>
        <span class="card-side"><span class="chip ${providerChipClass(provider)}">${escapeHtml(providerName(provider))}</span>${a.model ? `<br><span class="chip chip-model">${escapeHtml(a.model)}</span>` : ""}${a.workspacePresent ? '<br><span class="chip">folder kept</span>' : ""}</span>`;
      card.addEventListener("click", () => confirmArchived(a));
      list.appendChild(card);
    }

    if (focusedId) Array.from(list.children).find(card => card.dataset.sessionId === focusedId)?.focus({ preventScroll: true });

    const visible = liveMatches.length + archivedMatches.length;
    const total = (showLive ? sessions.length : 0) + (showArchived ? archived.length : 0);
    const searching = !!sessionQuery.trim();
    const searchStatus = searching ? `${visible} of ${total} sessions in ${tab === "all" ? "All" : tab === "ended" ? "Ended" : "Active"}` : "";
    if ($("search-status").textContent !== searchStatus) $("search-status").textContent = searchStatus;
    list.hidden = visible === 0;
    $("empty").hidden = visible > 0;
    if (visible === 0) {
      if (searching) {
        $("empty-title").textContent = "No matching sessions";
        $("empty-body").textContent = "Try another name, project, or agent, or clear your search."
          + (tab === "all" ? "" : " Choose All to search active and ended sessions.");
        return;
      }
      $("empty-title").textContent = tab === "ended" ? "No history" : "All quiet";
      $("empty-body").innerHTML = tab === "ended"
        ? "Ended sessions land here,<br>ready to resume or remove."
        : "No sessions running. Start one here,<br>then continue in its app or web terminal.";
    }
  }

  // Pull requests the session's agent printed (server/pr-links.ts), newest first.
  const PR_STATES = new Set(["open", "draft", "merged", "closed"]);
  const PR_URL_RE = /^https:\/\/github\.com\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/\d+$/;
  // GitHub's own PR icons (Octicons, MIT, THIRD_PARTY_NOTICES.md), 16x16, one per state.
  const PR_ICON_PATHS = {
    open: "M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z",
    merged: "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z",
    closed: "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 5.5a.75.75 0 0 1 .75.75v3.378a2.251 2.251 0 1 1-1.5 0V7.25a.75.75 0 0 1 .75-.75Zm-2.03-5.273a.75.75 0 0 1 1.06 0l.97.97.97-.97a.748.748 0 0 1 1.265.332.75.75 0 0 1-.205.729l-.97.97.97.97a.751.751 0 0 1-.018 1.042.751.751 0 0 1-1.042.018l-.97-.97-.97.97a.749.749 0 0 1-1.275-.326.749.749 0 0 1 .215-.734l.97-.97-.97-.97a.75.75 0 0 1 0-1.06ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z",
    draft: "M3.25 1A2.25 2.25 0 0 1 4 5.372v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.251 2.251 0 0 1 3.25 1Zm9.5 14a2.25 2.25 0 1 1 0-4.5 2.25 2.25 0 0 1 0 4.5ZM2.5 3.25a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0ZM3.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm9.5 0a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM14 7.5a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Zm0-4.25a1.25 1.25 0 1 1-2.5 0 1.25 1.25 0 0 1 2.5 0Z",
  };
  const prIcon = (state) => `<svg class="pr-icon" viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false"><path fill="currentColor" d="${PR_ICON_PATHS[state] || PR_ICON_PATHS.open}"/></svg>`;
  const prLinksHtml = (prs) => {
    const valid = (Array.isArray(prs) ? prs : []).filter(pr => pr && PR_URL_RE.test(pr.url) && Number.isInteger(pr.number));
    if (!valid.length) return "";
    // `#10071` alone when the card's PRs share a repo; `repo#10071` when they don't, so each stays unambiguous.
    const oneRepo = new Set(valid.map(pr => pr.repo)).size === 1;
    return `<span class="card-prs">${valid.map(pr => {
      // Only a state GitHub confirmed gets a color (server/pr-status.ts); anything else is neutral.
      const state = PR_STATES.has(pr.state) ? pr.state : "unknown";
      const where = `${pr.repo}#${pr.number}`;
      const label = [typeof pr.title === "string" && pr.title ? pr.title : null, state === "unknown" ? null : state, `${where} on GitHub`].filter(Boolean).join(" · ");
      const text = oneRepo ? `#${pr.number}` : `${pr.repo.split("/")[1]}#${pr.number}`;
      return `<span class="pr-link" role="link" tabindex="0" data-state="${state}" data-href="${escapeHtml(pr.url)}" title="${escapeHtml(label)}" aria-label="${escapeHtml(label)}">${prIcon(state)}<span class="pr-num">${escapeHtml(text)}</span></span>`;
    }).join("")}</span>`;
  };
  // Through a real anchor: in the installed app iOS opens it over the app and the
  // app stays mounted underneath, instead of coming back to a blank page.
  const openPrLink = (href) => { if (PR_URL_RE.test(href || "")) window.NativeShell.openExternal(href); };
  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Long paths truncate in the MIDDLE so both the root and the folder name stay visible
  const middlePath = (s, max = 34) =>
    s.length <= max ? s : s.slice(0, Math.ceil((max - 1) / 2)) + "…" + s.slice(s.length - Math.floor((max - 1) / 2));

  /* ---------- sheets ---------- */

  let openSheetEl = null;
  let sheetTrigger = null;
  let sheetHistory = [];
  // Each open sheet level owns one history entry, so the system back gesture (iOS
  // edge swipe, Android back) closes a sheet instead of leaving the app.
  // sheetDepth counts the entries this page pushed; popstate is the one path that
  // steps back through them.
  let sheetDepth = 0;
  let ignoredPops = 0;
  let unwound = Promise.resolve();
  let finishUnwind = null;
  const sheetState = (depth) => ({ ...(history.state && typeof history.state === "object" ? history.state : {}), sheet: depth });
  function pushSheetEntry(replace) {
    unwound.then(() => {
      if (replace) history.replaceState(sheetState(sheetDepth), "");
      else history.pushState(sheetState(++sheetDepth), "");
    });
  }
  function unwindSheetEntries() {
    if (!sheetDepth) return;
    const steps = sheetDepth;
    sheetDepth = 0;
    ignoredPops++;
    unwound = new Promise((resolve) => {
      finishUnwind = resolve;
      setTimeout(resolve, 600); // a traversal the browser drops must not hold later sheets
    });
    history.go(-steps);
  }
  const sheetFocusable = (el) => [...el.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex="0"]')]
    .filter((node) => node.getClientRects().length > 0);
  function openSheet(id, { back = false, returnFocus = null, scrollTop = 0 } = {}) {
    if (openSheetEl?.id === id) return;
    if (!openSheetEl) sheetTrigger = document.activeElement;
    if (!back && openSheetEl && (openSheetEl.id === "sheet-menu" || sheetHistory.length)) {
      sheetHistory.push({ id: openSheetEl.id, focus: document.activeElement, scrollTop: openSheetEl.scrollTop });
    }
    if (!back) pushSheetEntry(!!openSheetEl && !(sheetHistory.length && sheetHistory.at(-1).id === openSheetEl.id));
    closeSheet(false, true);
    openSheetEl = $(id);
    const sheet = openSheetEl;
    const backButton = sheet.querySelector(".sheet-back");
    backButton.hidden = sheetHistory.length === 0;
    if (sheetHistory.length) {
      const parent = $(sheetHistory.at(-1).id);
      const label = parent.id === "sheet-menu" ? "Settings" : parent.querySelector(".sheet-title").textContent;
      backButton.setAttribute("aria-label", `Back to ${label}`);
    }
    document.body.classList.add("sheet-open");
    $("app").inert = true;
    $("scrim").hidden = false;
    openSheetEl.hidden = false;
    if (id === "sheet-menu") globalThis.connectionStatus?.refresh(api);
    if (back && id === "sheet-agent-auth") agentAuth?.refreshAccounts();
    requestAnimationFrame(() => {
      if (openSheetEl !== sheet) return;
      $("scrim").classList.add("show");
      sheet.classList.add("show");
      sheet.scrollTop = scrollTop;
      (returnFocus?.isConnected && sheet.contains(returnFocus) ? returnFocus : sheet).focus({ preventScroll: true });
    });
  }
  function closeSheet(restoreFocus = true, keepHistory = false, fromHistory = false) {
    if (!keepHistory) {
      sheetHistory = [];
      if (!fromHistory) unwindSheetEntries();
    }
    if (!openSheetEl) return;
    const el = openSheetEl;
    if (el.id === "sheet-server-settings") cancelServerConfirm?.();
    if (el.id === "sheet-cli-updates") {
      clearTimeout(cliUpdatePoll);
      cliUpdatePoll = null;
    }
    const closedCodexAuth = el.id === "sheet-codex-auth";
    openSheetEl = null;
    document.body.classList.remove("sheet-open");
    $("app").inert = false;
    if (closedCodexAuth) agentAuth?.dismissCodexAuth();
    if (el.id === "sheet-agent-auth") agentAuth?.dismissAccounts();
    $("scrim").classList.remove("show");
    el.classList.remove("show");
    if (keepHistory) el.hidden = true;
    setTimeout(() => {
      if (openSheetEl === el) return;
      el.hidden = true;
      // Don't tear down the scrim if another sheet reopened in the meantime
      // (e.g. menu → Projects) — otherwise it goes display:none and swallows
      // the outside-click that should dismiss the new sheet.
      if (!openSheetEl) $("scrim").hidden = true;
      if (restoreFocus && !openSheetEl && sheetTrigger?.isConnected) sheetTrigger.focus({ preventScroll: true });
    }, 300);
  }
  function stepBackSheet() {
    const previous = sheetHistory.pop();
    if (previous) openSheet(previous.id, { back: true, returnFocus: previous.focus, scrollTop: previous.scrollTop });
  }
  // The in-sheet Back button goes through history too, so the next system back
  // still closes exactly one level.
  function backSheet() {
    if (sheetDepth > 1) history.back();
    else stepBackSheet();
  }
  window.addEventListener("popstate", (event) => {
    if (ignoredPops > 0) { ignoredPops--; finishUnwind?.(); return; }
    const target = Number(event.state?.sheet) || 0;
    const step = window.NativeShell.historyTarget(sheetDepth, target);
    if (step.action === "close") { sheetDepth = 0; closeSheet(true, false, true); }
    else if (step.action === "back") { sheetDepth = target; for (let i = 0; i < step.steps; i++) stepBackSheet(); }
  });
  document.querySelectorAll(".sheet").forEach(sheet => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sheet-back";
    button.hidden = true;
    button.innerHTML = '<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m12 19-7-7 7-7M5 12h14"/></svg>Back';
    button.addEventListener("click", backSheet);
    sheet.querySelector(".sheet-title").before(button);
  });
  document.addEventListener("keydown", (event) => {
    if (!openSheetEl) return;
    if (event.key === "Escape") { event.preventDefault(); closeSheet(); return; }
    if (event.key !== "Tab") return;
    const items = sheetFocusable(openSheetEl);
    if (!items.length) { event.preventDefault(); openSheetEl.focus(); return; }
    const first = items[0], last = items[items.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === openSheetEl)) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !openSheetEl.contains(document.activeElement))) {
      event.preventDefault(); first.focus();
    }
  });
  $("scrim").addEventListener("click", closeSheet);
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", closeSheet));

  /* ---------- new session ---------- */

  let sessionPrefix = "";
  let launchPending = false;
  let launchDrawerRequest = 0;

  const launchProviderInputs = () => [...document.querySelectorAll('input[name="provider"]')];
  const selectedLaunchProvider = () => document.querySelector('input[name="provider"]:checked')?.value || null;
  // Terminal or Chat (ACP): launch-mode.js decides when Chat can be chosen.
  const launchMode = window.LaunchMode.create(document, { load: () => api("/api/acp/agents"), onChange: () => updateProviderSelection() });
  const launchIsWorkspace = () => !!(chosenRepo || $("input-repo").value.trim() || selectedProject === FRESH_DEFAULT);

  /* Registered Commands join the picker beside the built-ins. They are rebuilt from
     capabilities rather than hardcoded, so registering one in Settings is enough. */
  function renderCommandChoices() {
    const picker = $("provider-picker");
    if (!picker) return;
    for (const stale of picker.querySelectorAll("[data-provider-card^='cmd:']")) stale.remove();
    for (const command of registeredCommands()) {
      const label = document.createElement("label");
      label.className = "provider-pick";
      label.dataset.providerCard = command.provider;
      label.innerHTML = `
        <input type="radio" name="provider" value="${escapeHtml(command.provider)}" required>
        <span class="provider-mark provider-mark-command" aria-hidden="true">${escapeHtml((command.label[0] || "C").toUpperCase())}</span>
        <span class="provider-copy">
          <span class="provider-name">${escapeHtml(command.label)}</span>
          <span class="provider-detail">Trusted server + web terminal</span>
        </span>`;
      label.querySelector("input").addEventListener("change", updateProviderSelection);
      picker.append(label);
    }
  }

  function updateProviderAvailability() {
    renderCommandChoices();
    for (const provider of BUILTIN_PROVIDERS) {
      const input = document.querySelector(`input[name="provider"][value="${provider}"]`);
      if (!input) continue;
      const enabled = builtinSupported(provider);
      input.disabled = !enabled;
      if (!enabled && input.checked) input.checked = false;
    }
    updateProviderSelection();
  }

  function updateProviderSelection() {
    const provider = selectedLaunchProvider();
    for (const card of document.querySelectorAll("[data-provider-card]")) {
      card.classList.toggle("selected", card.dataset.providerCard === provider);
    }

    const otherAgents = BUILTIN_PROVIDERS.some(builtinSupported) || registeredCommands().length > 0;
    const note = $("provider-capability-note");
    if (!capabilitiesResolved) note.textContent = "Checking agent support… Choose an agent to enable Start.";
    else if (!otherAgents) note.textContent = "No other agent is available on this server. Choose Claude to continue.";
    else if (!provider) note.textContent = "Choose an agent to enable Start.";
    else note.textContent = "";

    const isCommand = isCommandProvider(provider);
    const chatLaunch = launchMode.update({ provider, workspace: launchIsWorkspace() }) && launchMode.value() === "acp";
    const supportsRemoteControl = provider === "claude" && providerHas(provider, "remoteControl");
    const hideRemoteControl = chatLaunch || (!!provider && provider !== "claude") || (provider === "claude" && !supportsRemoteControl);
    $("remote-control-row").hidden = hideRemoteControl;
    $("chk-remote-control").disabled = hideRemoteControl;
    const unavailable = isCommand
      ? !commandFor(provider)
      : !!provider && provider !== "claude" && !builtinSupported(provider);
    $("btn-launch").disabled = launchPending || !provider || unavailable;
    updateLaunchHint();
    updateNamePreview();
  }

  for (const input of launchProviderInputs()) input.addEventListener("change", updateProviderSelection);
  const loadPrefix = () =>
    api("/api/settings").then((s) => { sessionPrefix = s.prefix || ""; }).catch(() => {});

  // Smart name input: spaces become dashes, invalid chars drop silently
  function smartNameInput(el) {
    const cleaned = el.value
      .replace(/\s+/g, "-")
      .replace(/[^a-zA-Z0-9_-]/g, "")
      .replace(/-{2,}/g, "-")
      .replace(/^[-_]+/, "");
    if (el.value !== cleaned) {
      const pos = el.selectionStart - (el.value.length - cleaned.length);
      el.value = cleaned;
      el.setSelectionRange(Math.max(0, pos), Math.max(0, pos));
    }
  }

  function updateNamePreview() {
    const name = $("input-name").value.trim();
    const el = $("name-preview");
    const show = !!sessionPrefix && !!name && !name.toLowerCase().startsWith(sessionPrefix.toLowerCase());
    el.hidden = !show;
    if (show) el.textContent = `Session name: “${sessionPrefix}${name}”`;
  }

  $("input-name").addEventListener("input", (ev) => {
    smartNameInput(ev.target);
    updateNamePreview();
  });

  $("btn-new").addEventListener("click", () => {
    selectedProject = defaultRepository() ? FRESH_DEFAULT : null;
    showSharedFolders = !defaultRepository();
    $("input-name").value = "";
    $("input-repo").value = "";
    chosenRepo = null;
    chosenBranch = null;
    branchList = [];
    branchToken++;
    $("branch-row").hidden = true;
    $("branch-results").hidden = true;
    $("repo-results").hidden = true;
    $("repo-note").hidden = true;
    $("name-preview").hidden = true;
    renderPicker();
    $("chk-remote-control").checked = true; // remote control is the default every time
    for (const input of launchProviderInputs()) input.checked = false;
    launchMode.reset();
    updateProviderAvailability();
    openSheet("sheet-new");
    launchMode.refresh();
    const request = ++launchDrawerRequest;
    const current = () => request === launchDrawerRequest && openSheetEl?.id === "sheet-new";
    $("project-load-status").textContent = projects.length ? "Refreshing shared folders…" : "Loading shared folders…";
    api("/api/projects")
      .then(data => {
        if (!current()) return;
        projects = data.projects || [];
        $("project-load-status").textContent = "";
        renderPicker();
      })
      .catch(() => {
        if (!current()) return;
        $("project-load-status").textContent = projects.length
          ? "Could not refresh shared folders. Showing the last loaded folders."
          : "Could not load shared folders. Close and reopen to retry. Fresh workspaces are still available.";
      });
    loadPrefix().then(() => { if (current()) updateNamePreview(); });
    requestAnimationFrame(() => { if (current()) launchProviderInputs().find((input) => !input.disabled)?.focus(); });
    reposLoading = true;
    renderRepoResults();
    api("/api/repos")
      .then(({ repos }) => { if (current()) allRepos = repos || []; })
      .catch(() => { if (current()) allRepos = []; })
      .finally(() => { if (current()) { reposLoading = false; renderRepoResults(); } });
  });

  /* ---------- repo & branch picker ----------
     The old control was <input list=…> over a <datalist>. iOS Safari shows no
     dropdown for that at all, so on a phone it was a bare text box you had to type
     `owner/repo#branch` into from memory. This is a real filtered list, plus a
     branch picker fed by the server and PR-link detection. */

  let allRepos = [];
  let reposLoading = false;
  let chosenRepo = null;      // "owner/repo" once picked
  let chosenBranch = null;    // null → let the server pick its default
  let branchList = [];
  let branchToken = 0;        // guards against a slow lookup overwriting a newer one

  const repoQuery = () => $("input-repo").value.trim();

  function setRepoNote(text, tone) {
    const note = $("repo-note");
    note.hidden = !text;
    note.textContent = text || "";
    note.style.color = tone === "bad" ? "var(--red)" : tone === "good" ? "var(--mint)" : "";
  }

  // GitHub Octicon; license in public/vendor/OCTICONS-LICENSE.txt.
  const githubRepoIcon = "<svg class=\"repo-provider-icon\" aria-hidden=\"true\" fill=\"currentColor\" xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 16 16\"><path d=\"M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656\"/></svg>";

  function renderRepoResults() {
    const box = $("repo-results");
    if (!showSharedFolders || chosenRepo) { box.hidden = true; return; }
    const q = repoQuery().toLowerCase();
    const matches = (q ? allRepos.filter((r) => r.toLowerCase().includes(q)) : allRepos).slice(0, 40);
    box.innerHTML = "";
    if (!matches.length) {
      // "No match" while the list is still arriving is a lie the operator acts on.
      box.innerHTML = reposLoading
        ? '<div class="repo-empty">Loading repos…</div>'
        : q
          ? '<div class="repo-empty">No match. Paste a full owner/repo or a PR link.</div>'
          : '<div class="repo-empty">No repos found. Check GitHub access in the menu.</div>';
      box.hidden = false;
      return;
    }
    for (const repo of matches) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "repo-opt";
      const [owner, ...name] = repo.split("/");
      b.setAttribute("aria-label", repo);
      b.innerHTML = `${githubRepoIcon}<span class="repo-option-copy"><span class="repo-option-name">${escapeHtml(name.join("/") || owner)}</span><span class="repo-option-owner">${escapeHtml(name.length ? owner : "GitHub")}</span></span>`;
      b.addEventListener("click", () => pickRepo(repo));
      box.appendChild(b);
    }
    box.hidden = false;
  }

  // Lucide SVGs; license in public/vendor/LUCIDE-LICENSE.txt.
  const workspaceIcons = {"folder": "<svg aria-hidden=\"true\" class=\"workspace-icon\" xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\" /> </svg> ", "folder-plus": "<svg aria-hidden=\"true\" class=\"workspace-icon\" xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M12 10v6\" /> <path d=\"M9 13h6\" /> <path d=\"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z\" /> </svg> ", "check": "<svg aria-hidden=\"true\" class=\"workspace-icon\" xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M20 6 9 17l-5-5\" /> </svg> ", "git-branch": "<svg aria-hidden=\"true\" class=\"workspace-icon\" xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"M15 6a9 9 0 0 0-9 9V3\" /> <circle cx=\"18\" cy=\"6\" r=\"3\" /> <circle cx=\"6\" cy=\"18\" r=\"3\" /> </svg> ", "chevron-down": "<svg aria-hidden=\"true\" class=\"workspace-icon\" xmlns=\"http://www.w3.org/2000/svg\" width=\"18\" height=\"18\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" > <path d=\"m6 9 6 6 6-6\" /> </svg> "};

  function renderBranchButton(label) {
    const button = $("btn-branch");
    const canChoose = button.dataset.loading !== "1" && branchList.some(name => name !== chosenBranch);
    button.disabled = !canChoose;
    if (canChoose) {
      button.setAttribute("aria-expanded", "false");
      button.setAttribute("aria-haspopup", "listbox");
    } else {
      button.removeAttribute("aria-expanded");
      button.removeAttribute("aria-haspopup");
    }
    $("branch-results").hidden = true;
    button.innerHTML = workspaceIcons["git-branch"] + `<span>${escapeHtml(label)}</span>`
      + (canChoose ? workspaceIcons["chevron-down"] : branchList.length === 1 && button.dataset.loading !== "1" ? '<small>Only branch</small>' : "");
  }

  async function pickRepo(repo, branch) {
    chosenRepo = repo;
    chosenBranch = branch || null;
    // A repo and a project are alternatives, and the repo is what gets submitted —
    // showing both as selected would promise something the launch doesn't do.
    selectedProject = null;
    renderPicker();
    $("input-repo").value = repo;
    $("repo-results").hidden = true;
    $("branch-row").hidden = false;
    $("branch-results").hidden = true;
    const btn = $("btn-branch");
    btn.dataset.loading = "1";
    renderBranchButton(branch ? `${branch} — checking…` : "Loading branches…");
    updateProviderSelection();

    const token = ++branchToken;
    try {
      const data = await api(`/api/repos/branches?repo=${encodeURIComponent(repo)}`);
      if (token !== branchToken) return;
      branchList = data.branches || [];
      if (!chosenBranch) chosenBranch = data.suggested || null;
      btn.dataset.loading = "";
      renderBranchButton(chosenBranch || "Default branch");
      if (branch && !branchList.includes(branch)) {
        setRepoNote(`${branch} isn't in ${repo} — it may come from a fork.`, "bad");
      }
    } catch (e) {
      if (token !== branchToken) return;
      branchList = [];
      btn.dataset.loading = "";
      renderBranchButton(chosenBranch || "Default branch");
      setRepoNote(e.message, "bad");
    }
    updateProviderSelection();
  }

  $("btn-change-repo").addEventListener("click", () => {
    clearRepo();
    renderPicker();
    $("input-repo").focus();
    $("input-repo").select();
  });

  function clearRepo() {
    chosenRepo = null;
    chosenBranch = null;
    branchList = [];
    branchToken++;
    $("branch-row").hidden = true;
    $("branch-results").hidden = true;
    setRepoNote("");
    renderRepoResults();
    updateProviderSelection();
  }

  function renderBranchResults() {
    const box = $("branch-results");
    box.innerHTML = "";
    if (!branchList.length) {
      box.innerHTML = '<div class="repo-empty">No branches to choose from.</div>';
      box.hidden = false;
      return;
    }
    for (const name of branchList) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `repo-opt${name === chosenBranch ? " selected" : ""}`;
      b.setAttribute("role", "option");
      b.setAttribute("aria-selected", String(name === chosenBranch));
      b.textContent = name;
      b.addEventListener("click", () => {
        chosenBranch = name;
        renderBranchButton(name);
        box.hidden = true;
        $("btn-branch").setAttribute("aria-expanded", "false");
        setRepoNote("");
        updateProviderSelection();
      });
      box.appendChild(b);
    }
    box.hidden = false;
  }

  $("btn-branch").addEventListener("click", () => {
    const box = $("branch-results");
    const open = box.hidden;
    if (open) renderBranchResults(); else box.hidden = true;
    $("btn-branch").setAttribute("aria-expanded", String(open));
  });

  /* A pasted PR link is the fastest path to the right branch — resolve it. */
  const PR_RE = /^(?:https?:\/\/(?:www\.)?github\.com\/[^/\s]+\/[^/\s]+\/pull\/\d+|[^/\s]+\/[^/\s#]+#\d+)/;

  async function resolvePullRequest(text) {
    setRepoNote("Looking up that pull request…");
    try {
      const pr = await api(`/api/repos/pull?url=${encodeURIComponent(text)}`);
      await pickRepo(pr.repo, pr.branch);
      setRepoNote(
        `PR #${pr.number}${pr.title ? ` — ${pr.title}` : ""}${pr.crossRepo ? " (from a fork)" : ""}`,
        pr.crossRepo ? "bad" : "good",
      );
    } catch (e) {
      setRepoNote(e.message, "bad");
    }
  }

  $("input-repo").addEventListener("input", () => {
    const text = repoQuery();
    if (chosenRepo && text !== chosenRepo) clearRepo();
    launchMode.update({ workspace: launchIsWorkspace() });
    if (PR_RE.test(text)) { resolvePullRequest(text); return; }
    setRepoNote("");
    renderRepoResults();
  });

  $("input-repo").addEventListener("focus", () => { if (!chosenRepo) renderRepoResults(); });

  const FRESH_DEFAULT = "__fresh_default";
  const defaultRepository = () => typeof capabilities?.defaults?.repository === "string" ? capabilities.defaults.repository : "";
  const unrestrictedAgents = () => capabilities?.agentPermissions === "unrestricted";
  let showSharedFolders = false;

  function renderPicker() {
    const picker = $("project-picker");
    picker.innerHTML = "";
    const options = [
      ...(defaultRepository() ? [{ id: FRESH_DEFAULT, label: "Fresh workspace", path: `${defaultRepository()} · default branch · separate folder` }] : []),
      ...(showSharedFolders ? projects : []),
    ];
    for (const p of options) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `pick${p.id === selectedProject ? " selected" : ""}`;
      const fresh = p.id === FRESH_DEFAULT;
      b.setAttribute("aria-pressed", String(p.id === selectedProject));
      b.innerHTML = `${workspaceIcons[fresh ? "folder-plus" : "folder"]}<span class="pick-copy"><span>${escapeHtml(p.label)}</span><span class="${fresh ? "pick-description" : "pick-path"}" title="${escapeHtml(p.path)}">${escapeHtml(p.path)}</span></span><span class="pick-selected" aria-hidden="true">${p.id === selectedProject ? workspaceIcons.check : ""}</span>`;
      b.addEventListener("click", () => {
        selectedProject = p.id;
        if (chosenRepo || $("input-repo").value) { $("input-repo").value = ""; clearRepo(); }
        renderPicker();
      });
      picker.appendChild(b);
    }
    $("label-repo").hidden = !showSharedFolders;
    $("input-repo").hidden = !showSharedFolders || !!chosenRepo;
    $("repo-selection").hidden = !showSharedFolders || !chosenRepo;
    $("selected-repo-name").textContent = chosenRepo || "";
    if (!showSharedFolders) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "btn-link";
      more.textContent = "Advanced: shared folders & other repos…";
      more.addEventListener("click", () => { showSharedFolders = true; renderPicker(); renderRepoResults(); });
      picker.appendChild(more);
    }
    launchMode.update({ workspace: launchIsWorkspace() });
  }

  // The two modes are reached in completely different ways — say which one the
  // Launch button is about to give you.
  function updateLaunchHint() {
    const provider = selectedLaunchProvider();
    if (provider && launchMode.value() === "acp") {
      $("launch-hint").textContent = `${providerName(provider)} runs as a chat. Open it from its session card to follow its work and answer its requests.`;
    } else if (isCommandProvider(provider)) {
      const label = providerName(provider);
      $("launch-hint").textContent = `${label} runs with its configured permissions. Continue in its web terminal.`;
    } else if (provider === "codex") {
      $("launch-hint").textContent = unrestrictedAgents() ? "Codex runs with approvals and sandbox bypassed. Continue in its web terminal." : "Codex uses its standard approval and sandbox settings. Continue in its web terminal.";
    } else if (provider === "command-code") {
      $("launch-hint").textContent = unrestrictedAgents() ? "Command Code runs with trust and approval prompts bypassed. Continue in its web terminal." : "Command Code keeps its trust and approval prompts. Continue in its web terminal.";
    } else if (provider === "claude") {
      $("launch-hint").textContent = providerHas(provider, "remoteControl") && $("chk-remote-control").checked
        ? "Runs on the server and appears in your Claude app within a minute."
        : "Runs on the server without remote control — continue in its web terminal.";
    } else {
      $("launch-hint").textContent = "Choose an agent to enable Start.";
    }
  }

  $("chk-remote-control").addEventListener("change", updateLaunchHint);

  $("form-new").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    if (launchPending) return;
    const name = $("input-name").value.trim();
    const provider = selectedLaunchProvider();
    if (!provider) { showToast("Choose an agent"); return; }
    if (BUILTIN_PROVIDERS.includes(provider) && !builtinSupported(provider)) {
      showToast(`${providerName(provider)} is unavailable on this server`);
      return;
    }
    // The picker owns the ref: `owner/repo#branch` is assembled here, never typed.
    const typedRepo = chosenRepo
      ? (chosenBranch ? `${chosenRepo}#${chosenBranch}` : chosenRepo)
      : $("input-repo").value.trim();
    const repo = typedRepo || (selectedProject === FRESH_DEFAULT ? defaultRepository() : "");
    if (!repo && selectedProject == null) { showToast("Pick a project or type a repo"); return; }
    const btn = ev.target.querySelector("button[type=submit]");
    launchPending = true;
    btn.disabled = true;
    try {
      const chat = !repo && launchMode.value() === "acp";
      const remoteControl = !chat && providerHas(provider, "remoteControl") && $("chk-remote-control").checked;
      const body = repo ? { name, repo, provider, remoteControl } : { name, projectId: selectedProject, provider, remoteControl, ...(chat ? { mode: "acp" } : {}) };
      await api("/api/sessions", { method: "POST", body: JSON.stringify(body) });
      closeSheet();
      showToast(chat
        ? `“${name}” is starting as a chat — open it from its session card`
        : repo
        ? `Preparing a fresh ${providerName(provider)} workspace for “${name}” — this can take a minute`
        : remoteControl
          ? `“${name}” is starting — open the Claude app to talk to it`
          : `“${name}” is starting in ${providerName(provider)} — open its web terminal to continue`);
      setTimeout(() => refresh(true), 1200);
    } catch (e) {
      showToast(e.message);
    } finally {
      launchPending = false;
      updateProviderSelection();
    }
  });

  /* ---------- end session ---------- */

  let confirmAction = null;

  const shellQuote = (value) => `'${String(value).replace(/'/g, `'"'"'`)}'`;

  // Paste-ready commands run on the server, where each provider keeps its local
  // conversation state. Codex always uses an explicit cwd and exact resume id;
  // Latest-session shortcuts are deliberately never generated because names can be reused.
  function terminalCmd(provider, project, resumeId) {
    if (provider === "command-code") {
      // Its resume takes the conversation id; without one there is nothing exact to reopen.
      const resume = resumeId ? ` --session ${shellQuote(resumeId)}` : "";
      const cmd = `command-code${unrestrictedAgents() ? " --trust --yolo" : ""}${resume}`;
      return project ? `cd ${shellQuote(project)} && ${cmd}` : cmd;
    }
    if (provider === "codex") {
      const cwd = project ? ` -C ${shellQuote(project)}` : "";
      const resume = resumeId ? ` resume ${shellQuote(resumeId)}` : "";
      return `codex${unrestrictedAgents() ? " --dangerously-bypass-approvals-and-sandbox" : ""}${cwd}${resume}`;
    }
    const resume = resumeId ? `claude --resume ${shellQuote(resumeId)}` : "claude --continue";
    const cmd = `${resume}${unrestrictedAgents() ? " --dangerously-skip-permissions" : ""}`;
    return project ? `cd ${shellQuote(project)} && ${cmd}` : cmd;
  }

  // Managed form: detached in a `cs-<name>` session with remote control, so it
  // survives disconnect and reappears in this app / the Claude phone app —
  // exactly how the app's own Resume works. Mirrors resumeArchived() and
  // mux.spawnArgv() server-side, including which holder the server uses.
  function managedClaudeCmd(project, resumeId, name, remoteControl = true) {
    const resume = resumeId ? `claude --resume ${shellQuote(resumeId)}` : "claude --continue";
    const rc = remoteControl ? ` --remote-control ${shellQuote(name)}` : "";
    const inner = `${project ? `cd ${shellQuote(project)} && ` : ""}exec ${resume}${rc}${unrestrictedAgents() ? " --dangerously-skip-permissions" : ""}`;
    const session = shellQuote(`cs-${name.toLowerCase()}`);
    // env -u ZMX_SESSION: pasted into a zmx shell (the app's own server shell is
    // one), attach would switch that terminal instead of starting anything. The
    // redirects keep zmx's restore/reset bytes off the caller's terminal.
    if (me?.mux === "zmx") return `env -u ZMX_SESSION ZMX_DIR="$HOME/.zmx" zmx attach ${session} bash -lc ${shellQuote(inner)} </dev/null >/dev/null 2>&1`;
    return `screen -dmS ${session} bash -lc ${shellQuote(inner)}`;
  }

  async function copyText(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* fall through to the legacy path */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch { return false; }
  }

  // Show/wire the two "copy command" buttons on the confirm sheet:
  //  - terminal: foreground resume in your SSH shell (detached from nothing, not in the app)
  //  - managed:  detached session holder + remote control (persists, shows in the app)
  // managedOk: only offer the background (holder + remote-control) command where
  // relaunching is valid — i.e. NOT for a live session, where it spawns a duplicate
  // claude remote-controlling the same name and clobbers the running one.
  function wireCopyCmd(provider, project, resumeId, name, managedOk, remoteControl = true) {
    const btn = $("btn-copy-cmd");
    const mbtn = $("btn-copy-managed");
    const showTerminal = !!(resumeId || project);
    // An ad-hoc Codex screen has no persisted launch id for hook correlation, so
    // only app-created Codex sessions are presented as managed/background work.
    const showManaged = !!(providerHas(provider, "externalDiscovery") && managedOk && name && (resumeId || project));
    btn.hidden = !showTerminal;
    mbtn.hidden = !showManaged;
    $("copy-cmd-hint").hidden = !(showTerminal || showManaged);
    $("copy-cmd-hint").innerHTML = showManaged
      ? "Both run on the server (SSH in). <b>Terminal</b> opens in your shell and stops on disconnect. <b>Background</b> runs detached and reappears in the app."
      : `Runs on the server (SSH in). Opens ${escapeHtml(providerName(provider))} in your shell and stops on disconnect.`;
    btn.onclick = async () => {
      const ok = await copyText(terminalCmd(provider, project, resumeId));
      showToast(ok ? `Copied ${providerName(provider)} terminal command` : "Couldn’t copy to clipboard");
    };
    mbtn.onclick = async () => {
      const ok = await copyText(managedClaudeCmd(project, resumeId, name, remoteControl));
      showToast(ok ? "Copied — detached + in the app; paste on the server" : "Couldn’t copy to clipboard");
    };
  }

  // Open a live, writable web terminal: in the installed app, in this window (back
  // returns to the list); in a browser, in its own tab. It runs inside a session
  // holder (zmx, or screen for older sessions) on the server and is proxied through this (already-gated) origin — so
  // closing the tab just detaches and whatever's running keeps going in the
  // background. The tab gets term.html, which wraps ttyd's bare xterm.js UI in a
  // title bar, a Close button and a key row (ttyd alone is unusable on a phone).
  // screenOpener pops the tab synchronously BEFORE the async POST so iOS Safari
  // doesn't treat the later navigation as a non-gesture popup and block it. Nothing
  // navigates until the terminal exists, so a failed attach is a toast, not a blank page.
  // A Chat (ACP) session's chat reads the bridge's event log; any other chat reads the transcript.
  function chatUrl(s, provider) {
    const query = new URLSearchParams({ id: s.id, name: s.name });
    if (s.mode === "acp") { query.set("mode", "acp"); query.set("agent", providerName(provider)); }
    return `/chat.html?${query}`;
  }

  async function openWebTerminal(body, okLabel, { chat = false } = {}) {
    const screen = window.NativeShell.screenOpener();
    try {
      const { id, mux } = await api("/api/terminal", { method: "POST", body: JSON.stringify(body) });
      const label = body.kind === "attach" ? body.screen.replace(/^cs-/, "") : "Server shell";
      const url = `/term.html?id=${encodeURIComponent(id)}&name=${encodeURIComponent(label)}&mux=${encodeURIComponent(mux ?? "screen")}${chat ? "&chat=1" : ""}`;
      if (!window.NativeShell.standalone) showToast(okLabel);
      await screen.go(url);
    } catch (e) {
      screen.cancel();
      showToast(e.message || "Couldn’t open the terminal");
    }
  }

  // The sheet's ways into a session: the live web terminal (a writable second seat
  // on its screen) and the chat. While the session is still starting they wait,
  // disabled with a spinner, and the list poll flips them to ready by itself.
  let confirmSessionId = null;
  function syncSessionActions(s) {
    const provider = providerOf(s);
    const caps = { webTerminal: providerHas(provider, "webTerminal"), chatView: providerHas(provider, "chatView") };
    const awaitingTrust = s.startupWaitingForTrust === true && window.sessionStatus(s).state === "waiting";

    const term = $("btn-web-term");
    const termState = window.sessionActionState(s, "terminal", caps);
    term.hidden = termState === "hidden";
    term.disabled = termState === "pending";
    term.classList.toggle("is-busy", termState === "pending");
    term.textContent = termState === "pending" ? "Opening terminal… wait a few seconds"
      : awaitingTrust ? "Review in terminal" : "Open web terminal";
    term.classList.toggle("btn-primary", awaitingTrust);
    term.classList.toggle("btn-ghost", !awaitingTrust);
    const chatState = window.sessionActionState(s, "chat", caps);
    const transcriptChat = s.mode !== "acp" && chatState !== "hidden";
    term.onclick = termState !== "ready" ? null : () => {
      closeSheet();
      openWebTerminal({ kind: "attach", screen: s.id.slice(2) }, "Opening web terminal…", { chat: transcriptChat });
    };

    // The same conversation as a chat: the agent's own transcript, or the ACP bridge's log.
    const chat = $("btn-chat");
    const acpChat = s.mode === "acp";
    chat.hidden = chatState === "hidden";
    chat.disabled = chatState === "pending";
    chat.classList.toggle("is-busy", chatState === "pending");
    chat.textContent = chatState === "pending" ? "Opening chat… wait a few seconds" : "Open chat";
    chat.classList.toggle("btn-primary", acpChat);
    chat.classList.toggle("btn-ghost", !acpChat);
    chat.onclick = chatState !== "ready" ? null : () => {
      closeSheet();
      window.NativeShell.openScreen(chatUrl(s, provider));
    };
  }

  function confirmEnd(s) {
    const provider = providerOf(s);
    const displayName = providerName(provider);
    const awaitingTrust = s.startupWaitingForTrust === true && window.sessionStatus(s).state === "waiting";
    if (awaitingTrust) {
      $("confirm-title").textContent = `Review folder trust for “${s.name}”`;
      $("confirm-body").textContent = "Codex is waiting for you to review this folder in its terminal. Startup continues after your decision; the app has not approved it for you.";
      $("btn-confirm").textContent = "End session";
    } else if (s.phase === "failed") {
      $("confirm-title").textContent = `End failed “${s.name}” launch?`;
      $("confirm-body").textContent = s.errorMessage || `${displayName} could not start. End this attempt and try again.`;
      $("btn-confirm").textContent = "End attempt";
    } else if (s.status === "ended") {
      $("confirm-title").textContent = `Clean up “${s.name}”?`;
      $("confirm-body").textContent = "This session already finished. This just removes the leftover card.";
      $("btn-confirm").textContent = "Clean up";
    } else if (s.status === "starting") {
      $("confirm-title").textContent = `Cancel “${s.name}”?`;
      $("confirm-body").textContent = "The workspace is still being prepared. Cancelling stops the setup.";
      $("btn-confirm").textContent = "Cancel setup";
    } else {
      $("confirm-title").textContent = `End “${s.name}”?`;
      $("confirm-body").textContent = s.kind === "external"
        ? `This ${displayName} session was started outside the app. Ending it closes the process on the server; its saved conversation stays with ${displayName}.`
        : `The ${displayName} process on the server will close. You can resume it later from ended history.`;
      $("btn-confirm").textContent = "End session";
    }
    $("btn-resume").hidden = true;
    const open = $("btn-open-claude");
    const canOpenClaude = providerHas(provider, "nativeChatUrl") && !!s.claudeUrl;
    open.hidden = !canOpenClaude;
    open.textContent = "Open in Claude";
    if (canOpenClaude) open.href = s.claudeUrl;
    else open.removeAttribute("href");

    confirmSessionId = s.id;
    syncSessionActions(s);

    wireCopyCmd(provider, s.project, s.resumeId, s.name, s.status === "ended", s.remoteControl !== false);

    const wsRow = $("ws-row");
    const chk = $("chk-delete-ws");
    wsRow.hidden = !s.workspace;
    chk.checked = false;
    if (s.workspace) {
      $("ws-label").textContent = "Also delete the workspace folder";
      // Smart default: pre-tick only when the workspace is clean and fully pushed
      api(`/api/sessions/${encodeURIComponent(s.id)}/ws-state`).then((st) => {
        if (!st.workspace) { wsRow.hidden = true; return; }
        if (st.dirty || st.unpushed) {
          $("ws-label").innerHTML = 'Also delete the workspace folder <span class="ws-warn">— has ' +
            (st.dirty ? "uncommitted" : "unpushed") + " work!</span>";
        } else {
          chk.checked = true;
          $("ws-label").textContent = "Also delete the workspace folder (clean, all pushed)";
        }
      }).catch(() => {});
    }

    const chatRow = $("chat-row");
    const chkChat = $("chk-delete-chat");
    chatRow.hidden = !(providerHas(provider, "chatDeletion") && s.claudeUrl);
    chkChat.checked = !chatRow.hidden;

    confirmAction = async () => {
      const q = [];
      if (s.workspace && chk.checked) q.push("ws=1");
      if (!chatRow.hidden && chkChat.checked) q.push("chat=1");
      if (s.status === "running") showToast(`Ending “${s.name}”…`);
      await api(`/api/sessions/${encodeURIComponent(s.id)}${q.length ? "?" + q.join("&") : ""}`, { method: "DELETE" });
      showToast(s.status === "ended" ? "Cleaned up" : `Ended “${s.name}”${chkChat.checked && s.claudeUrl ? " — chat deletion queued" : ""}`);
    };
    openSheet("sheet-confirm");
  }

  function confirmArchived(a) {
    const provider = providerOf(a);
    const displayName = providerName(provider);
    $("confirm-title").textContent = `“${a.name}”`;
    $("confirm-body").textContent = a.canResume
      ? `Ended ${agoStr(a.endedAt)}. Resume it with ${displayName} in the same folder, or remove it from history.`
      : `Ended ${agoStr(a.endedAt)}. Its folder or exact conversation is unavailable, so it can't be resumed.`;
    $("btn-confirm").textContent = "Remove from history";

    const resume = $("btn-resume");
    resume.hidden = !a.canResume || !providerHas(provider, "exactResume");
    resume.onclick = async () => {
      closeSheet();
      resume.disabled = true;
      try {
        await api(`/api/archive/${a.id}/resume`, { method: "POST", body: JSON.stringify({ provider }) });
        showToast(`Resuming “${a.name}” with ${displayName}…`);
        setTab("active");
      } catch (e) { showToast(e.message); }
      resume.disabled = false;
      refresh(true);
    };

    const open = $("btn-open-claude");
    const canOpenClaude = providerHas(provider, "nativeChatUrl") && !!a.claudeUrl;
    open.hidden = !canOpenClaude;
    open.textContent = "Open old chat in Claude";
    if (canOpenClaude) open.href = a.claudeUrl;
    else open.removeAttribute("href");
    $("btn-web-term").hidden = true;
    $("btn-chat").hidden = true;
    wireCopyCmd(provider, a.project, a.resumeId, a.name, true, a.remoteControl !== false);

    const wsRow = $("ws-row");
    const chk = $("chk-delete-ws");
    wsRow.hidden = !a.workspacePresent;
    chk.checked = false;
    if (a.workspacePresent) $("ws-label").textContent = "Also delete the leftover workspace folder";

    const chatRow = $("chat-row");
    const chkChat = $("chk-delete-chat");
    chatRow.hidden = !(providerHas(provider, "chatDeletion") && a.claudeUrl);
    chkChat.checked = false;

    confirmAction = async () => {
      const q = [];
      if (a.workspacePresent && chk.checked) q.push("ws=1");
      if (!chatRow.hidden && chkChat.checked) q.push("chat=1");
      await api(`/api/archive/${a.id}${q.length ? "?" + q.join("&") : ""}`, { method: "DELETE" });
      showToast(chkChat.checked && a.claudeUrl ? "Removed — chat deletion queued" : "Removed from history");
    };
    openSheet("sheet-confirm");
  }

  $("btn-confirm").addEventListener("click", async () => {
    const action = confirmAction;
    confirmAction = null;
    closeSheet();
    if (!action) return;
    try { await action(); } catch (e) { showToast(e.message); }
    refresh(true);
  });

  /* ---------- menu ---------- */

  let cliUpdateBusy = false;
  let cliUpdateState = null;
  const updateTime = (value) => value ? new Date(value).toLocaleString() : "—";

  function renderCliUpdates() {
    const state = cliUpdateState;
    $("chk-cli-updates").disabled = cliUpdateBusy || !state?.available || state.controllable === false;
    if (!cliUpdateBusy) $("chk-cli-updates").checked = !!state?.enabled;
    $("btn-cli-update-now").disabled = cliUpdateBusy || !state?.available || state.controllable === false || state?.running;
    $("btn-cli-update-now").textContent = state?.running ? "Updating…" : "Update now";
    if (!state) return;
    $("cli-update-versions").replaceChildren();
    const presets = [["gemini", "Gemini CLI"], ["kimi", "Kimi Code"], ["qwen", "Qwen Code"], ["opencode", "opencode"]];
    for (const [id, name] of [["codex", "Codex"], ["claude", "Claude Code"], ["command-code", "Command Code"], ...presets.filter(([id]) => state.versions[id])]) {
      const label = document.createElement("dt");
      label.textContent = name;
      const version = document.createElement("dd");
      version.textContent = state.versions[id] || "Unavailable";
      $("cli-update-versions").append(label, version);
    }
    $("cli-update-status").textContent = !state.available ? "Automatic updates are not set up on this server."
      : state.running ? "Updating the CLIs. You can close this panel while the update runs."
      : state.result === "failed" ? (state.controllable === false ? "The last update failed. Ask the server administrator to retry." : "The last update failed. You can retry with Update now.")
      : state.result === "success" ? "Last update completed successfully."
      : "Ready for the first update.";
    if (state.available && state.controllable === false) $("cli-update-status").textContent += " Update controls are managed by the server administrator.";
    $("cli-update-next").textContent = !state.available ? "" : state.enabled ? `Next update: ${updateTime(state.nextRun)}` : "Automatic updates paused.";
    $("cli-update-last").textContent = state.lastStarted ? `Last started: ${updateTime(state.lastStarted)}` : "";
  }

  async function loadCliUpdates() {
    clearTimeout(cliUpdatePoll);
    try {
      const state = await api("/api/cli-updates");
      if (openSheetEl?.id !== "sheet-cli-updates") return;
      cliUpdateState = state;
      renderCliUpdates();
    } catch (e) {
      if (openSheetEl?.id !== "sheet-cli-updates") return;
      cliUpdateState = null;
      renderCliUpdates();
      $("cli-update-status").textContent = e.message;
    }
    if (openSheetEl?.id === "sheet-cli-updates") cliUpdatePoll = setTimeout(loadCliUpdates, 5000);
  }

  async function controlCliUpdates(action) {
    if (cliUpdateBusy || !cliUpdateState?.available || cliUpdateState.controllable === false) return;
    cliUpdateBusy = true;
    renderCliUpdates();
    try {
      await api("/api/cli-updates", { method: "POST", body: JSON.stringify({ action }) });
      showToast(action === "run" ? "Update requested" : action === "enable" ? "Daily updates enabled" : "Daily updates paused");
      await loadCliUpdates();
    } catch (e) {
      showToast(e.message);
    } finally {
      cliUpdateBusy = false;
      renderCliUpdates();
    }
  }

  $("btn-cli-updates").addEventListener("click", () => {
    openSheet("sheet-cli-updates");
    cliUpdateState = null;
    $("cli-update-status").textContent = "Checking…";
    $("cli-update-next").textContent = "";
    $("cli-update-last").textContent = "";
    renderCliUpdates();
    loadCliUpdates();
  });
  $("chk-cli-updates").addEventListener("change", (ev) => controlCliUpdates(ev.target.checked ? "enable" : "disable"));
  $("btn-cli-update-now").addEventListener("click", () => controlCliUpdates("run"));

  let appUpdateBusy = false;
  let appUpdateState = null;
  const APP_UPDATE_RESULTS = {
    success: "Last check installed an update.",
    "up-to-date": "Up to date.",
    "needs-admin": "A new release needs the server administrator to rerun the installer.",
    failed: "The last update did not install; the current version was kept.",
  };

  function renderAppUpdates() {
    const state = appUpdateState;
    $("chk-app-updates").disabled = appUpdateBusy || !state?.available;
    if (!appUpdateBusy) $("chk-app-updates").checked = !!state?.enabled;
    if (!state) return;
    $("app-update-details").replaceChildren();
    for (const [name, value] of [["Running", state.version || "Unknown"], ["Follows", state.channel === "main" ? "main branch" : "tagged releases"]]) {
      const label = document.createElement("dt");
      label.textContent = name;
      const detail = document.createElement("dd");
      detail.textContent = value;
      $("app-update-details").append(label, detail);
    }
    $("app-update-status").textContent = !state.available
      ? "Not available on this server. Automatic updates need an install made with deploy/install-ubuntu."
      : state.last ? `${state.last.message || APP_UPDATE_RESULTS[state.last.result] || ""} Checked ${updateTime(state.last.finished)}.`
      : state.enabled ? "On. The first check runs within a day." : "Off.";
  }

  async function loadAppUpdates() {
    try {
      appUpdateState = await api("/api/app-updates");
    } catch (e) {
      appUpdateState = null;
      $("app-update-status").textContent = e.message;
    }
    renderAppUpdates();
    return appUpdateState;
  }

  $("btn-app-updates").addEventListener("click", () => {
    openSheet("sheet-app-updates");
    appUpdateState = null;
    $("app-update-status").textContent = "Checking…";
    renderAppUpdates();
    loadAppUpdates();
  });
  $("chk-app-updates").addEventListener("change", async (ev) => {
    if (appUpdateBusy || !appUpdateState?.available) return;
    appUpdateBusy = true;
    renderAppUpdates();
    try {
      await api("/api/app-updates", { method: "POST", body: JSON.stringify({ enabled: ev.target.checked }) });
      showToast(ev.target.checked ? "Automatic app updates on" : "Automatic app updates off");
    } catch (e) {
      showToast(e.message);
    } finally {
      appUpdateBusy = false;
      await loadAppUpdates();
    }
  });

  // Settings → Server settings: values that otherwise live only in the server's configuration.
  const SERVER_SETTINGS = [
    { name: "defaultRepo", label: "Default repository", type: "text", placeholder: "owner/repository",
      hint: "Preselected when you start a session from a GitHub repository." },
    { name: "githubOwners", label: "GitHub owners", type: "text", placeholder: "my-org, my-user",
      hint: "Comma-separated accounts and organizations whose repositories are listed." },
    { name: "claudeAiEmail", label: "Claude.ai sign-in email", type: "email", placeholder: "you@example.com",
      hint: "The account the Claude.ai browser signs in with." },
    { name: "terminalMouse", label: "Terminal mouse", options: [["on", "On"], ["off", "Off"]],
      hint: "Off keeps mouse clicks and scrolling out of agent terminals." },
    { name: "updateChannel", label: "App update channel", options: [["releases", "Tagged releases"], ["main", "main branch"]], confirm: true,
      hint: "What automatic app updates install. Changing this asks you to confirm it's you." },
    { name: "agentPermissions", label: "Agent permissions", options: [["standard", "Standard: agents ask first"], ["unrestricted", "Unrestricted: no permission prompts"]], confirm: true,
      hint: "Changing this asks you to confirm it's you. Applies to sessions started afterwards; running sessions keep the mode they started with." },
  ];
  let serverSettingsState = null;
  let cancelServerConfirm = null;

  const SERVER_SOURCE = { settings: "Changed here", server: "From the server's configuration", default: "Built-in default" };

  function serverSettingDisplay(def, value) {
    if (def.options) return def.options.find(([v]) => v === value)?.[1] || value;
    return value || "not set";
  }

  function renderServerSettings() {
    const list = $("server-settings-list");
    list.replaceChildren();
    const state = serverSettingsState;
    if (!state) return;
    for (const def of SERVER_SETTINGS) {
      const setting = state.settings[def.name];
      if (!setting) continue;
      const unavailable = def.name === "updateChannel" && !state.channelAvailable;
      const block = document.createElement("div");
      block.className = "server-setting";
      const id = `server-setting-${def.name}`;
      const label = document.createElement("label");
      label.className = "label";
      label.htmlFor = id;
      label.textContent = def.label;
      let control;
      if (def.options) {
        control = document.createElement("select");
        for (const [value, text] of def.options) control.add(new Option(text, value));
      } else {
        control = document.createElement("input");
        control.type = def.type;
        control.placeholder = def.placeholder;
        control.autocomplete = "off";
        control.autocapitalize = "off";
        control.spellcheck = false;
      }
      control.id = id;
      control.className = "field";
      control.value = setting.value;
      control.disabled = unavailable;
      control.addEventListener("change", () => saveServerSetting(def, block, { value: control.value.trim() }));
      const hint = document.createElement("p");
      hint.className = "hint";
      hint.textContent = unavailable ? "Not available on this server. App updates need an install made with deploy/install-ubuntu." : def.hint;
      const source = document.createElement("p");
      source.className = "server-setting-source";
      source.append(SERVER_SOURCE[setting.source] || "");
      if (setting.source === "settings") {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "text-link";
        reset.textContent = `Reset to server default (${serverSettingDisplay(def, setting.serverValue)})`;
        reset.addEventListener("click", () => saveServerSetting(def, block, { reset: true }));
        source.append(reset);
      }
      block.append(label, control, hint, source);
      if (def.confirm && state.stepUp === "password") {
        const confirm = document.createElement("form");
        confirm.className = "server-setting-confirm";
        confirm.hidden = true;
        confirm.innerHTML = `<label class="sr-only" for="server-settings-password-${def.name}">Admin password</label>`
          + `<input id="server-settings-password-${def.name}" class="field" type="password" autocomplete="current-password" placeholder="Admin password" required>`
          + '<button class="btn btn-primary" type="submit">Confirm change</button>'
          + '<button class="btn btn-ghost" type="button" data-cancel>Cancel</button>';
        block.append(confirm);
      }
      list.append(block);
    }
  }

  async function loadServerSettings() {
    try {
      serverSettingsState = await api("/api/server-settings");
      $("server-settings-status").textContent = "";
    } catch (e) {
      serverSettingsState = null;
      $("server-settings-status").textContent = e.message;
    }
    renderServerSettings();
  }

  // Sensitive settings need a fresh check: the passkey when one exists, else the admin password.
  // Resolves to null when the person cancels or closes the sheet.
  async function serverSettingsGrant(block) {
    if (serverSettingsState.stepUp === "passkey") {
      const { options, challengeId } = await api("/api/server-settings/step-up/options");
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      return (await api("/api/server-settings/step-up", { method: "POST", body: JSON.stringify({ challengeId, response }) })).grant;
    }
    const form = block.querySelector(".server-setting-confirm");
    form.hidden = false;
    const input = form.querySelector("input");
    input.value = "";
    input.focus();
    const password = await new Promise((resolve) => {
      cancelServerConfirm = () => resolve(null);
      form.querySelector("[data-cancel]").onclick = cancelServerConfirm;
      form.onsubmit = (ev) => { ev.preventDefault(); resolve(input.value); };
    });
    cancelServerConfirm = null;
    if (password === null) return null;
    return (await api("/api/server-settings/step-up", { method: "POST", body: JSON.stringify({ password }) })).grant;
  }

  async function saveServerSetting(def, block, change) {
    block.querySelectorAll("input, select, button").forEach((el) => { if (!el.closest(".server-setting-confirm")) el.disabled = true; });
    try {
      const body = { name: def.name, ...change };
      if (def.confirm) {
        body.grant = await serverSettingsGrant(block);
        if (!body.grant) throw Object.assign(new Error("Cancelled"), { name: "NotAllowedError" });
      }
      const { setting } = await api("/api/server-settings", { method: "POST", body: JSON.stringify(body) });
      showToast(`${def.label}: ${serverSettingDisplay(def, setting.value)}`);
    } catch (e) {
      if (e.name !== "NotAllowedError") showToast(e.message);
    }
    await Promise.all([loadServerSettings(), loadCapabilities()]);
    window.connectionStatus?.refresh(api);
  }

  $("btn-server-settings").addEventListener("click", () => {
    openSheet("sheet-server-settings");
    serverSettingsState = null;
    $("server-settings-status").textContent = "Checking…";
    renderServerSettings();
    loadServerSettings();
  });

  $("btn-menu").addEventListener("click", () => {
    openSheet("sheet-menu");
    loadPrefix().then(() => { $("input-prefix").value = sessionPrefix; });
    const chk = $("chk-notify");
    chk.checked = notifyActive();
    chk.disabled = !notifySupported();
  });

  $("chk-notify").addEventListener("change", async (ev) => {
    const ok = await setNotify(ev.target.checked);
    ev.target.checked = ok && notifyOn; // revert on denied/unsupported
    if (ok && notifyOn) showToast("You'll be nudged when a session needs your answer.");
  });

  $("input-prefix").addEventListener("input", (ev) => smartNameInput(ev.target));
  $("input-prefix").addEventListener("change", async (ev) => {
    const prefix = ev.target.value.trim();
    if (prefix === sessionPrefix) return;
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ prefix }) });
      sessionPrefix = prefix;
      showToast(prefix ? `New sessions will start with “${prefix}”` : "Prefix removed");
    } catch (e) {
      showToast(e.message);
    }
  });
  $("btn-add-passkey").addEventListener("click", () => { closeSheet(); addPasskey(); });
  $("btn-welcome-passkey").addEventListener("click", () => { closeSheet(); addPasskey(); });
  $("btn-logout").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" }).catch(() => {});
    location.reload();
  });

  $("btn-clear-archive").addEventListener("click", () => {
    if (!archived.length) { closeSheet(); showToast("History is already empty"); return; }
    $("btn-open-claude").hidden = true;
    $("btn-copy-cmd").hidden = true;
    $("btn-copy-managed").hidden = true;
    $("copy-cmd-hint").hidden = true;
    $("btn-resume").hidden = true;
    $("ws-row").hidden = true;
    $("chat-row").hidden = true;
    $("confirm-title").textContent = `Clear ${archived.length} ended session${archived.length === 1 ? "" : "s"}?`;
    $("confirm-body").textContent = "Removes them from this list only — saved agent conversations and kept workspace folders stay untouched.";
    $("btn-confirm").textContent = "Clear history";
    confirmAction = async () => {
      const { cleared } = await api("/api/archive/clear", { method: "POST" });
      showToast(`Cleared ${cleared} from history`);
    };
    openSheet("sheet-confirm");
  });

  $("btn-end-all").addEventListener("click", () => {
    const running = sessions.filter((s) => s.status === "running" || s.status === "starting").length;
    if (!sessions.length) { closeSheet(); showToast("Nothing to end"); return; }
    $("btn-open-claude").hidden = true;
    $("btn-copy-cmd").hidden = true;
    $("btn-copy-managed").hidden = true;
    $("copy-cmd-hint").hidden = true;
    $("btn-resume").hidden = true;
    $("ws-row").hidden = true;
    $("chat-row").hidden = true;
    $("confirm-title").textContent = `End all ${running} session${running === 1 ? "" : "s"}?`;
    $("confirm-body").textContent = "Every listed managed agent session, plus any listed external Claude sessions, will close. Saved conversations remain available to their agent.";
    $("btn-confirm").textContent = "End all";
    confirmAction = async () => {
      const { killed } = await api("/api/sessions/kill-all", { method: "POST" });
      showToast(`Ended ${killed} session${killed === 1 ? "" : "s"}`);
    };
    openSheet("sheet-confirm");
  });

  agentAuth = window.createAgentAuth({
    $, api, openSheet, closeSheet, copyText, showToast, codexAuthSupported,
    commandCodeAuthSupported, commandCodeHasToken,
    capabilitiesResolved: () => capabilitiesResolved,
    registeredCommands,
    reloadCapabilities: loadCapabilities,
    escapeHtml,
  });

  /* ---------- projects ---------- */

  $("btn-projects").addEventListener("click", async () => {
    projects = (await api("/api/projects")).projects;
    renderProjectList();
    openSheet("sheet-projects");
  });

  function renderProjectList() {
    const wrap = $("project-list");
    wrap.innerHTML = "";
    for (const p of projects) {
      const row = document.createElement("div");
      row.className = "proj-row";
      row.innerHTML = `<span>${escapeHtml(p.label)}<div class="pick-path">${escapeHtml(middlePath(p.path, 44))}</div></span>`;
      const del = document.createElement("button");
      del.className = "proj-del";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        await api(`/api/projects/${p.id}`, { method: "DELETE" });
        projects = (await api("/api/projects")).projects;
        renderProjectList();
      });
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }

  $("form-project").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      await api("/api/projects", {
        method: "POST",
        body: JSON.stringify({
          path: $("input-proj-path").value.trim(),
          label: $("input-proj-label").value.trim(),
          // Optional-chain: a stale cached index.html may not have this checkbox,
          // and a hard throw here would silently kill every add.
          create: !!$("chk-create-folder")?.checked,
        }),
      });
      $("input-proj-path").value = "";
      $("input-proj-label").value = "";
      const chk = $("chk-create-folder");
      if (chk) chk.checked = false;
      projects = (await api("/api/projects")).projects;
      renderProjectList();
      showToast("Project added");
    } catch (e) {
      showToast(e.message);
    }
  });

  /* ---------- Commands registry ---------- */

  /* Arguments are typed as one line and tokenized server-side, where quoting is
     tested — `-c 'sleep 300'` must stay two arguments, not three. */

  async function loadCommands() {
    const wrap = $("command-list");
    wrap.innerHTML = "";
    let commands = [];
    try { commands = (await api("/api/commands")).commands; } catch (e) { showToast(e.message); return; }
    if (!commands.length) {
      wrap.innerHTML = '<p class="hint" style="text-align:left;margin:2px 2px 10px">No commands yet — add one below.</p>';
      return;
    }
    for (const c of commands) {
      const row = document.createElement("div");
      row.className = "proj-row";
      const argv = [c.bin, ...(c.args || [])].join(" ");
      const cred = c.envVar
        ? `${escapeHtml(c.envVar)} · ${c.hasToken ? "token stored" : "no token yet"}`
        : "no token env var";
      row.innerHTML = `<span>${escapeHtml(c.label)}<div class="pick-path">${escapeHtml(middlePath(argv, 44))}</div><div class="pick-path">${cred}</div></span>`;
      if (c.envVar) {
        const key = document.createElement("button");
        key.className = "proj-del";
        key.textContent = c.hasToken ? "Key" : "Add key";
        key.addEventListener("click", () => agentAuth?.openCommandToken(c));
        row.appendChild(key);
      }
      const del = document.createElement("button");
      del.className = "proj-del";
      del.textContent = "Remove";
      del.addEventListener("click", async () => {
        try {
          await api(`/api/commands/${c.id}`, { method: "DELETE" });
          await Promise.all([loadCommands(), loadPresets()]);
          await loadCapabilities(); // the agent picker is built from capabilities
        } catch (e) { showToast(e.message); }
      });
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }

  /* ---------- install agents on this server ----------
     One install at a time, run by the server as its own account. The list polls
     while an install runs, so the output and versions update in place. */
  let agentInstallPoll = null;

  async function startAgentInstall(agents) {
    try {
      await api("/api/agent-installs", { method: "POST", body: JSON.stringify({ agents }) });
      showToast(`Installing ${agents.join(", ")}…`);
      await loadAgentInstalls();
    } catch (e) { showToast(e.message); }
  }

  async function loadAgentInstalls(fresh = false) {
    clearTimeout(agentInstallPoll);
    let data;
    try { data = await api(`/api/agent-installs${fresh ? "?fresh=1" : ""}`); }
    catch (e) { $("agent-install-status").textContent = e.message; return; }
    const { agents, job } = data;
    const running = !!job?.running;
    const wrap = $("agent-install-list");
    wrap.replaceChildren();
    for (const agent of agents) {
      const row = document.createElement("div");
      row.className = "proj-row";
      const info = document.createElement("span");
      info.textContent = agent.label;
      const detail = document.createElement("div");
      detail.className = "proj-note";
      detail.textContent = running && job.agents.includes(agent.id) ? "Installing…"
        : agent.version ? `Installed · v${agent.version}` : agent.preset ? "Not installed · preset" : "Not installed";
      info.append(detail);
      const action = document.createElement("button");
      action.className = "proj-del";
      action.textContent = agent.version ? "Update" : "Install";
      action.disabled = running;
      action.addEventListener("click", () => startAgentInstall([agent.id]));
      row.append(info, action);
      wrap.append(row);
    }
    const output = $("agent-install-output");
    output.hidden = !job?.output;
    output.textContent = job?.output || "";
    output.scrollTop = output.scrollHeight;
    $("agent-install-status").textContent = !job ? ""
      : running ? `Installing ${job.agents.join(", ")}… npm installs can take a minute or two.`
      : job.result === "success" ? `Installed ${job.agents.join(", ")}.` : `Installing ${job.agents.join(", ")} failed — see the output below.`;
    if (running) {
      agentInstallPoll = setTimeout(async () => {
        await loadAgentInstalls();
        // Finished since the last poll: read versions again, and refresh what depends on them.
        if (!$("agent-install-list").querySelector("button:disabled")) {
          await loadAgentInstalls(true);
          agentAuth?.refreshAccounts?.();
          if (!$("sheet-commands").hidden) loadPresets();
        }
      }, 2000);
    }
  }
  $("btn-agent-auth").addEventListener("click", () => loadAgentInstalls());

  async function loadPresets() {
    const wrap = $("preset-list");
    wrap.replaceChildren();
    let presets = [];
    try { presets = (await api("/api/commands/presets")).presets; } catch (e) { showToast(e.message); return; }
    for (const preset of presets) {
      const row = document.createElement("div");
      row.className = "proj-row";
      const info = document.createElement("span");
      info.textContent = preset.label;
      const detail = document.createElement("div");
      detail.className = "proj-note";
      detail.textContent = preset.installed ? preset.notes : "Not installed yet. Install puts it on this server.";
      info.append(detail);
      const action = document.createElement("button");
      action.className = "proj-del preset-add";
      if (preset.registered) {
        action.textContent = "Added";
        action.disabled = true;
      } else if (!preset.installed) {
        action.textContent = "Install";
        action.addEventListener("click", async () => {
          action.disabled = true;
          await startAgentInstall([preset.id]);
          detail.textContent = "Installing… this can take a minute or two.";
          const wait = setInterval(async () => {
            const { job } = await api("/api/agent-installs").catch(() => ({ job: null }));
            if (job?.running) return;
            clearInterval(wait);
            if (job?.result !== "success") showToast(`Installing ${preset.label} failed. Details in Settings → Agent authentication.`);
            loadPresets();
          }, 2000);
        });
      } else {
        action.textContent = "Add";
        action.addEventListener("click", async () => {
          action.disabled = true;
          try {
            const { command } = await api("/api/commands", { method: "POST", body: JSON.stringify({ preset: preset.id }) });
            await Promise.all([loadPresets(), loadCommands(), loadCapabilities()]);
            showToast(command.envVar ? `${command.label} added. Store its ${command.envVar} next.` : `${command.label} added — pick it when you start a session`);
          } catch (e) { action.disabled = false; showToast(e.message); }
        });
      }
      row.append(info, action);
      wrap.append(row);
    }
  }

  $("btn-commands").addEventListener("click", () => {
    $("input-command-label").value = "";
    $("input-command-bin").value = "";
    $("input-command-args").value = "";
    $("input-command-env").value = "";
    loadPresets();
    loadCommands();
    openSheet("sheet-commands");
  });

  $("form-command").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const body = {
      label: $("input-command-label").value.trim(),
      bin: $("input-command-bin").value.trim(),
      argsLine: $("input-command-args").value,
      envVar: $("input-command-env").value.trim(),
    };
    try {
      const { command } = await api("/api/commands", { method: "POST", body: JSON.stringify(body) });
      $("input-command-label").value = "";
      $("input-command-bin").value = "";
      $("input-command-args").value = "";
      $("input-command-env").value = "";
      await loadCommands();
      await loadCapabilities();
      showToast(`${command.label} is ready — pick it when you start a session`);
    } catch (e) { showToast(e.message); }
  });

  /* ---------- CLI access tokens (cs) ---------- */

  async function loadCliTokens() {
    const wrap = $("cli-token-list");
    wrap.innerHTML = "";
    let tokens = [];
    try { tokens = (await api("/api/cli-tokens")).tokens; } catch (e) { showToast(e.message); return; }
    if (!tokens.length) {
      wrap.innerHTML = '<p class="hint" style="text-align:left;margin:2px 2px 10px">No tokens yet — generate one below.</p>';
      return;
    }
    for (const t of tokens) {
      const row = document.createElement("div");
      row.className = "proj-row";
      const last = t.last_used_at ? `used ${agoStr(t.last_used_at)}` : "never used";
      row.innerHTML = `<span>${escapeHtml(t.label || "Untitled")}<div class="pick-path">${last}</div></span>`;
      const del = document.createElement("button");
      del.className = "proj-del";
      del.textContent = "Revoke";
      del.addEventListener("click", async () => {
        try { await api(`/api/cli-tokens/${t.id}`, { method: "DELETE" }); loadCliTokens(); }
        catch (e) { showToast(e.message); }
      });
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }

  // Menu → a plain login shell on the server, in its own tab. Same lifecycle as
  // an attached one: closing the tab detaches, the screen keeps running.
  $("btn-web-terminal").addEventListener("click", () => {
    closeSheet();
    openWebTerminal({ kind: "shell" }, "Opening a terminal…");
  });

  /* ---------- GitHub access (gh) ---------- */

  async function loadGithubStatus() {
    const el = $("github-status");
    try {
      const s = await api("/api/github-auth/status");
      if (!s.installed) el.textContent = "The GitHub CLI (gh) is not installed on the server — ask for it to be installed first.";
      else if (s.authenticated) el.textContent = `Connected as ${s.account ?? "unknown account"}.`;
      else el.textContent = "Not connected. Paste a token below.";
      $("btn-github-logout").hidden = !s.authenticated;
    } catch (e) { el.textContent = e.message; }
  }

  $("btn-github-auth").addEventListener("click", () => {
    $("input-github-token").value = "";
    $("github-status").textContent = "Checking…";
    $("btn-github-logout").hidden = true;
    loadGithubStatus();
    openSheet("sheet-github");
  });

  $("form-github-token").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const token = $("input-github-token").value.trim();
    if (!token) return;
    $("github-status").textContent = "Checking the token with GitHub…";
    try {
      const r = await api("/api/github-auth/token", { method: "POST", body: JSON.stringify({ token }) });
      $("input-github-token").value = "";
      showToast(r.account ? `GitHub connected as ${r.account}` : "GitHub token saved");
      loadGithubStatus();
    } catch (e) {
      showToast(e.message);
      loadGithubStatus();
    }
  });

  $("btn-github-logout").addEventListener("click", async () => {
    try {
      await api("/api/github-auth/logout", { method: "POST" });
      showToast("GitHub access removed");
      loadGithubStatus();
    } catch (e) { showToast(e.message); }
  });

  async function loadMcpConnections() {
    const wrap = $("mcp-connection-list");
    wrap.innerHTML = "";
    let connections = [];
    try { connections = (await api("/api/mcp-connections")).connections; } catch (e) { showToast(e.message); return; }
    if (!connections.length) {
      wrap.innerHTML = '<p class="hint" style="text-align:left;margin:2px 2px 10px">None yet.</p>';
      return;
    }
    for (const c of connections) {
      const row = document.createElement("div");
      row.className = "proj-row";
      const last = c.last_used_at ? `used ${agoStr(c.last_used_at)}` : "never used";
      row.innerHTML = `<span>${escapeHtml(c.name)}<div class="pick-path">connected ${agoStr(c.created_at)} · ${last}</div></span>`;
      const del = document.createElement("button");
      del.className = "proj-del";
      del.textContent = "Disconnect";
      del.addEventListener("click", async () => {
        try { await api(`/api/mcp-connections/${encodeURIComponent(c.client_id)}`, { method: "DELETE" }); loadMcpConnections(); }
        catch (e) { showToast(e.message); }
      });
      row.appendChild(del);
      wrap.appendChild(row);
    }
  }

  const connectorsUI = window.createConnectorsUI({ $, api, openSheet, showToast, agoStr, escapeHtml });
  $("btn-connectors").addEventListener("click", () => connectorsUI.open());

  const secretsUI = window.createSecretsUI({ $, api, openSheet, showToast, agoStr, escapeHtml });
  $("btn-secrets").addEventListener("click", () => secretsUI.open());

  $("btn-cli-access").addEventListener("click", () => {
    $("cli-token-new").hidden = true;
    $("input-cli-label").value = "";
    $("cli-origin").textContent = location.origin;
    loadCliTokens();
    loadMcpConnections();
    openSheet("sheet-cli");
  });

  $("form-cli-token").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    try {
      const { token } = await api("/api/cli-tokens", {
        method: "POST",
        body: JSON.stringify({ label: $("input-cli-label").value.trim() }),
      });
      $("cli-token-value").value = token;
      fillCommands(connectCommands(token));
      $("cli-token-new").hidden = false;
      $("input-cli-label").value = "";
      loadCliTokens();
    } catch (e) { showToast(e.message); }
  });

  /* ---------- Allow a cs sign-in (cs server add) ---------- */

  async function openCliLogin() {
    const code = cliLoginCode;
    cliLoginCode = null;
    try {
      const { label } = await api(`/api/cli-login/request?user_code=${encodeURIComponent(code)}`);
      $("cli-login-label").textContent = label;
      $("cli-login-code").textContent = code;
      $("btn-cli-login-allow").dataset.code = code;
      openSheet("sheet-cli-login");
    } catch (e) { showToast(e.message); }
  }

  async function answerCliLogin(allow) {
    const code = $("btn-cli-login-allow").dataset.code;
    try {
      await api(`/api/cli-login/${allow ? "approve" : "deny"}`, { method: "POST", body: JSON.stringify({ user_code: code }) });
      showToast(allow ? "Allowed. Go back to your terminal." : "Denied. Nothing was given to cs.");
    } catch (e) { showToast(e.message); }
    closeSheet();
  }

  $("btn-cli-login-allow").addEventListener("click", () => answerCliLogin(true));
  $("btn-cli-login-deny").addEventListener("click", () => answerCliLogin(false));
  window.addEventListener("hashchange", () => {
    cliLoginCode = readCliLoginCode();
    if (cliLoginCode && me?.authed && !$("app").hidden) openCliLogin();
  });

  /* ---------- Connect Claude or Codex (MCP connector) ---------- */

  const MCP_URL = `${location.origin}/mcp`;
  const connectCommands = (token) => token ? {
    "cmd-claude-code-token": `claude mcp add --transport http -s user coding-sessions ${MCP_URL} --header "Authorization: Bearer ${token}"`,
    "cmd-codex-token": `codex mcp add coding-sessions --url ${MCP_URL} --bearer-token-env-var CS_TOKEN`,
  } : {
    "cmd-claude-app": MCP_URL,
    "cmd-claude-code": `claude mcp add --transport http -s user coding-sessions ${MCP_URL}`,
    "cmd-codex": `codex mcp add coding-sessions --url ${MCP_URL}`,
  };
  const fillCommands = (cmds) => { for (const [id, text] of Object.entries(cmds)) $(id).textContent = text; };

  $("btn-connect").addEventListener("click", () => {
    fillCommands(connectCommands());
    openSheet("sheet-connect");
  });

  // Tapping a copy box copies the command inside it; its chip says so.
  async function copyFromBox(box) {
    const ok = await copyText($(box.dataset.copy).textContent);
    const chip = box.querySelector(".copy-chip");
    if (ok && chip) {
      box.classList.add("copied");
      chip.textContent = "Copied ✓";
      clearTimeout(box._copiedTimer);
      box._copiedTimer = setTimeout(() => { box.classList.remove("copied"); chip.textContent = "Copy"; }, 1600);
    }
    showToast(ok ? (box.dataset.toast || "Copied") : "Couldn’t copy to clipboard");
  }
  document.addEventListener("click", (ev) => {
    const box = ev.target.closest("[data-copy]");
    if (box) copyFromBox(box);
  });
  document.addEventListener("keydown", (ev) => {
    const box = ev.target.closest?.("[data-copy]");
    if (box && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); copyFromBox(box); }
  });

  $("btn-cli-copy").addEventListener("click", async () => {
    const ok = await copyText($("cli-token-value").value);
    showToast(ok ? "Token copied" : "Couldn’t copy to clipboard");
  });

  /* ---------- toast ---------- */

  let toastTimer = null;
  function showToast(msg) {
    const t = $("toast");
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
  }

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(() => {});

  /* ---------- touch gestures ---------- */

  const native = window.NativeShell;
  const sideSheets = window.matchMedia("(min-width: 760px)");

  // A bottom sheet follows a downward drag from its top and closes past the
  // threshold (native.js decides), like the system sheets it imitates.
  document.querySelectorAll(".sheet").forEach((sheet) => {
    let drag = null;
    sheet.addEventListener("touchstart", (e) => {
      drag = null;
      if (sideSheets.matches || sheet !== openSheetEl || e.touches.length !== 1 || sheet.scrollTop > 0) return;
      if (e.target.closest("input, textarea, select, .browser-live, .cmd")) return;
      drag = { y: e.touches[0].clientY, dy: 0, at: e.timeStamp, velocity: 0, active: false };
    }, { passive: true });
    sheet.addEventListener("touchmove", (e) => {
      if (!drag) return;
      const dy = e.touches[0].clientY - drag.y;
      if (!drag.active) {
        if (dy < -6) { drag = null; return; } // scrolling up: the sheet's own content
        if (dy < 6) return;
        drag.active = true;
        sheet.classList.add("dragging");
      }
      e.preventDefault();
      const dt = Math.max(1, e.timeStamp - drag.at);
      drag.velocity = (dy - drag.dy) / dt;
      drag.dy = dy;
      drag.at = e.timeStamp;
      // Past the top it resists, the way an overscrolled native sheet does.
      sheet.style.transform = `translateY(${dy > 0 ? dy : dy / 4}px)`;
      $("scrim").style.opacity = String(Math.max(0, 1 - Math.max(0, dy) / sheet.offsetHeight));
    }, { passive: false });
    const end = () => {
      const done = drag;
      drag = null;
      if (!done?.active) return;
      sheet.classList.remove("dragging");
      sheet.style.transform = "";
      $("scrim").style.opacity = "";
      if (native.sheetShouldDismiss({ dy: done.dy, velocity: done.velocity, height: sheet.offsetHeight })) {
        native.haptic();
        closeSheet();
      }
    };
    sheet.addEventListener("touchend", end);
    sheet.addEventListener("touchcancel", end);
  });

  // Pull to refresh on the sessions list: the installed app has no browser
  // refresh, and the list is the one thing worth refreshing by hand.
  {
    // State lives on #app: the indicator and the content it pulls down both read it.
    const ptr = $("app");
    let pull = null;
    let refreshing = false;
    const show = (distance) => {
      ptr.style.setProperty("--pull", `${distance}px`);
      ptr.style.setProperty("--pull-progress", String(Math.min(1, distance / native.PULL_TRIGGER)));
    };
    document.addEventListener("touchstart", (e) => {
      pull = null;
      if (refreshing || openSheetEl || $("app").hidden || e.touches.length !== 1 || window.scrollY > 0) return;
      if (e.target.closest("input, textarea, select, .sheet, .dock")) return;
      pull = { y: e.touches[0].clientY, distance: 0, armed: false };
    }, { passive: true });
    document.addEventListener("touchmove", (e) => {
      if (!pull) return;
      const raw = e.touches[0].clientY - pull.y;
      if (raw <= 0 || window.scrollY > 0) {
        if (pull.distance) show(0);
        pull.distance = 0;
        ptr.classList.remove("ptr-pulling", "ptr-armed");
        return;
      }
      e.preventDefault();
      ptr.classList.add("ptr-pulling");
      pull.distance = native.pullDistance(raw);
      const armed = native.pullTriggered(pull.distance);
      if (armed && !pull.armed) native.haptic(6);
      pull.armed = armed;
      ptr.classList.toggle("ptr-armed", armed);
      show(pull.distance);
    }, { passive: false });
    const release = async () => {
      const done = pull;
      pull = null;
      if (!done) return;
      ptr.classList.remove("ptr-pulling", "ptr-armed");
      if (!native.pullTriggered(done.distance)) { show(0); return; }
      refreshing = true;
      ptr.classList.add("ptr-refreshing");
      show(native.PULL_TRIGGER * 0.75);
      // Long enough to read as a refresh even when the server answers at once.
      await Promise.all([refresh(true), new Promise((resolve) => setTimeout(resolve, 450))]);
      ptr.classList.remove("ptr-refreshing");
      show(0);
      refreshing = false;
    };
    document.addEventListener("touchend", release);
    document.addEventListener("touchcancel", release);
  }

  // Installing: Android offers its own dialog; iOS Safari only has Share, then
  // Add to Home Screen, so say that. Shown on the list until dismissed, once.
  {
    const KEY = "xs_install_hint";
    const hint = $("install-hint");
    let deferredPrompt = null;
    const dismissed = () => { try { return localStorage.getItem(KEY) === "dismissed"; } catch { return false; } };
    const dismiss = () => { try { localStorage.setItem(KEY, "dismissed"); } catch {} };
    const sync = () => {
      const kind = native.installHintKind({
        standalone: native.standalone, dismissed: dismissed(), hasPrompt: !!deferredPrompt,
        iosSafari: native.isIosSafari(navigator.userAgent, navigator.maxTouchPoints),
      });
      hint.hidden = !kind;
      if (!kind) return;
      $("btn-install").hidden = kind !== "prompt";
      $("install-body").textContent = kind === "prompt"
        ? "Opens from your home screen, full screen, like any app."
        : "Tap Share, then “Add to Home Screen” to open it full screen, like any app.";
    };
    window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredPrompt = e; sync(); });
    window.addEventListener("appinstalled", () => { deferredPrompt = null; dismiss(); sync(); });
    $("btn-install").addEventListener("click", async () => {
      const prompt = deferredPrompt;
      deferredPrompt = null;
      if (!prompt) return sync();
      prompt.prompt();
      const { outcome } = await prompt.userChoice.catch(() => ({ outcome: "dismissed" }));
      if (outcome === "accepted") dismiss();
      sync();
    });
    $("btn-install-dismiss").addEventListener("click", () => { dismiss(); sync(); });
    sync();
  }

  /* ---------- coming back ---------- */

  // Back from GitHub, another app, or the back-forward cache: whatever the page was
  // in the middle of may have frozen with it. Retry a boot that never finished,
  // re-sync the list, and drop any sheet chrome that outlived its sheet.
  window.NativeShell.onResume(() => {
    if (!$("offline").hidden) { boot(); return; }
    if ($("app").hidden) return;
    if (!openSheetEl) {
      $("scrim").hidden = true;
      $("scrim").classList.remove("show");
      document.body.classList.remove("sheet-open");
      $("app").inert = false;
    }
    refresh(true);
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => { if (!document.hidden) refresh(); }, 4000);
  });

  // The list's scroll survives a trip to chat or the terminal even when iOS
  // discarded the page meanwhile: it rides in the list's history entry.
  if ("scrollRestoration" in history) history.scrollRestoration = "manual";
  window.NativeShell.setBeforeLeave(async () => {
    await unwound;
    history.replaceState({ ...(history.state && typeof history.state === "object" ? history.state : {}), scrollY: Math.round(window.scrollY) }, "");
  });

  boot();
})();
