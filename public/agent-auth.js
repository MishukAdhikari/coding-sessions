/* Coding Sessions — provider-scoped authentication UI */
(() => {
  window.createAgentAuth = ({
    $,
    api,
    openSheet,
    closeSheet,
    copyText,
    showToast,
    codexAuthSupported,
    commandCodeAuthSupported = () => false,
    commandCodeHasToken = () => false,
    capabilitiesResolved,
    registeredCommands = () => [],
    reloadCapabilities = async () => {},
    escapeHtml = (v) => String(v),
    openTerminal = async () => {},
  }) => {
    const authProviderInputs = () => [...document.querySelectorAll('input[name="auth-provider"]')];
    const selectedAuthProvider = () => authProviderInputs().find((input) => input.checked)?.value || null;
    const providerInput = (p) => authProviderInputs().find((input) => input.value === p) || null;
    let providerTransition = 0;
    let providerTransitionPending = false;
    let tokenTarget = null; // whose credential the token sheet is editing, and where it saves
    let accounts = null;
    let terminalAgents = []; // preset agents found on the server, however they were installed
    let accountsError = "";
    let accountRequest = 0;

    const isCommandProvider = (p) => typeof p === "string" && p.startsWith("cmd:");
    const isPresetProvider = (p) => typeof p === "string" && p.startsWith("preset:");
    /* The agent whose own login runs in a server terminal: an installed preset, or
       a Command registered from one. Built-ins sign in through the app instead. */
    const terminalAgentFor = (p) => {
      const id = isPresetProvider(p) ? p.slice("preset:".length) : isCommandProvider(p) ? commandFor(p)?.preset : null;
      return id ? terminalAgents.find((a) => a.id === id && a.installed) || null : null;
    };
    const commandFor = (p) => registeredCommands().find((c) => c.provider === p) || null;

    /* Registered Commands sign in with a stored token rather than Claude's
       setup-token or Codex's device-code flow, so they join the picker with their
       own detail line instead of being left out of the sheet entirely. */
    function renderCommandAuthChoices() {
      const picker = $("auth-provider-picker");
      if (!picker) return;
      const selected = selectedAuthProvider();
      for (const stale of picker.querySelectorAll("[data-auth-provider-card]")) {
        const id = stale.dataset.authProviderCard || "";
        if (isCommandProvider(id) || isPresetProvider(id)) stale.remove();
      }
      const registeredPresets = new Set(registeredCommands().map((c) => c.preset).filter(Boolean));
      const cards = [
        ...registeredCommands(),
        // Installed by hand or by the app but not added as a Command: it still gets a row.
        ...terminalAgents.filter((a) => a.installed && !registeredPresets.has(a.id))
          .map((a) => ({ provider: `preset:${a.id}`, label: a.label, envVar: null, preset: a.id })),
      ];
      for (const command of cards) {
        const label = document.createElement("label");
        label.className = "provider-pick";
        label.dataset.authProviderCard = command.provider;
        const terminal = !!terminalAgentFor(command.provider);
        const detail = command.envVar
          ? `${command.hasToken ? "Token stored" : "Token needed"} · ${command.envVar}`
          : terminal ? "Installed · sign in in a terminal" : command.preset ? "Not installed on this server" : "Add a token env var first";
        const enabled = !!command.envVar || terminal;
        label.setAttribute("data-auth-provider-card", command.provider);
        const span = (className, value) => {
          const el = document.createElement("span");
          el.className = className;
          el.textContent = value;
          return el;
        };
        const input = document.createElement("input");
        input.type = "radio";
        input.setAttribute("name", "auth-provider");
        input.name = "auth-provider";
        input.value = command.provider;
        input.disabled = !enabled;
        input.checked = enabled && selected === command.provider;
        input.addEventListener("change", updateProviderSelection);
        const mark = span("provider-mark provider-mark-command", (command.label[0] || "C").toUpperCase());
        mark.setAttribute("aria-hidden", "true");
        const copy = span("provider-copy", "");
        copy.append(span("provider-name", command.label), span("provider-detail", detail));
        label.append(input, mark, copy);
        picker.append(label);
      }
    }

    /* One sheet serves every stored credential: a Command's token and Command Code's
       API key differ only in where they are saved and what the agent calls them. */
    function openTokenSheet(target) {
      tokenTarget = target;
      $("command-token-title").textContent = `${target.label} ${target.noun}`;
      $("command-token-body").textContent = target.body;
      $("input-command-token").value = "";
      $("input-command-token").placeholder = `Paste the ${target.noun}`;
      $("btn-command-token-clear").hidden = !target.hasToken;
      $("btn-command-token-clear").textContent = `Remove stored ${target.noun}`;
      openSheet("sheet-command-token");
    }

    function openCommandTokenSheet(command) {
      openTokenSheet({
        label: command.label,
        noun: "token",
        endpoint: `/api/commands/${command.id}/token`,
        hasToken: command.hasToken,
        body: `Stored on the server and passed to ${command.label} as ${command.envVar} when a session starts. `
          + `It is never shown again and never appears in a command line.`,
      });
    }

    function openCommandCodeTokenSheet() {
      openTokenSheet({
        label: "Command Code",
        noun: "API key",
        endpoint: "/api/command-code-auth/token",
        hasToken: commandCodeHasToken(),
        verifies: true,
        body: "Stored on the server and passed to Command Code as COMMAND_CODE_API_KEY when a session "
          + "starts. It is never shown again and never appears in a command line.",
      });
    }

    function updateProviderSelection() {
      const provider = selectedAuthProvider();
      for (const card of document.querySelectorAll("[data-auth-provider-card]")) {
        card.classList.toggle("selected", card.dataset.authProviderCard === provider);
      }
      const note = $("auth-provider-note");
      const unavailable = [
        codexAuthSupported() ? null : "Codex",
        commandCodeAuthSupported() ? null : "Command Code",
      ].filter(Boolean);
      if (!capabilitiesResolved()) note.textContent = "Checking agent support…";
      else if (unavailable.length) note.textContent = `${unavailable.join(" and ")} authentication is unavailable on this server.`;
      else note.textContent = "";
      $("btn-auth-provider-continue").disabled = providerTransitionPending
        || !provider
        || (provider === "codex" && !codexAuthSupported())
        || (provider === "command-code" && !commandCodeAuthSupported())
        || (isCommandProvider(provider) && !commandFor(provider)?.envVar && !terminalAgentFor(provider))
        || (isPresetProvider(provider) && !terminalAgentFor(provider));
      const terminalAgent = terminalAgentFor(provider);
      const tokenSignIn = isCommandProvider(provider) && !!commandFor(provider)?.envVar;
      $("btn-agent-terminal-login").hidden = !terminalAgent || !tokenSignIn;
      $("btn-agent-terminal-login").disabled = providerTransitionPending;
      $("agent-terminal-hint").hidden = !terminalAgent;
      $("agent-terminal-hint").textContent = terminalAgent
        ? `${terminalAgent.loginHint} Its sign-in status is not read by this app.` : "";
      const account = accounts?.find((a) => a.provider === provider);
      const builtin = provider && !isCommandProvider(provider) && !isPresetProvider(provider);
      $("agent-account-details").hidden = !builtin;
      if (builtin) {
        $("agent-account-state").textContent = account ? !account.installed ? "CLI not installed"
          : account.loggedIn === true ? "Signed in" : account.loggedIn === false ? "Signed out" : "Could not verify sign-in"
          : accountsError || "Checking account…";
        $("agent-account-email").textContent = account?.email || (account?.loggedIn ? "Not provided by this CLI" : "—");
        $("agent-account-plan").textContent = account?.plan || "—";
        $("agent-account-org").textContent = account?.organization || "—";
        $("agent-account-since").textContent = account?.loggedInSince ? new Date(account.loggedInSince).toLocaleString()
          : account?.loggedIn ? "Unknown — login time was not recorded" : "—";
        $("btn-auth-provider-continue").disabled ||= !account?.installed || account.loggedIn === null;
      }
      $("btn-auth-provider-continue").textContent = tokenSignIn ? "Manage token"
        : terminalAgent ? "Sign in in a terminal" : account?.loggedIn ? "Change account" : "Sign in";
      $("btn-agent-signout").hidden = !account?.loggedIn;
      $("btn-agent-signout").disabled = providerTransitionPending;
      $("agent-account-note").textContent = account?.loggedIn
        ? "Changing accounts signs out the current account first. Existing sessions may need to sign in again."
        : "Accounts are shared by sessions on this server. Account emails are shown only when the CLI provides them.";
    }

    async function loadAccounts() {
      const request = ++accountRequest;
      accountsError = "";
      try {
        const result = await api("/api/agent-accounts");
        if (request !== accountRequest) return;
        accounts = result.accounts;
        terminalAgents = Array.isArray(result.agents) ? result.agents : [];
      } catch (error) { if (request === accountRequest) { accounts = null; accountsError = error.message; } }
      renderCommandAuthChoices();
      updateProviderSelection();
    }

    function updateAvailability() {
      renderCommandAuthChoices();
      for (const [provider, supported] of [["codex", codexAuthSupported], ["command-code", commandCodeAuthSupported]]) {
        const input = providerInput(provider);
        if (!input) continue;
        input.disabled = !supported();
        if (input.disabled && input.checked) input.checked = false;
      }
      // Say whether a key is already stored, so "sign in again" isn't a guess.
      const detail = $("auth-command-code-detail");
      if (detail) detail.textContent = commandCodeHasToken() ? "API key stored" : "API key sign in";
      updateProviderSelection();
    }

    for (const input of authProviderInputs()) input.addEventListener("change", updateProviderSelection);

    function dismissAccounts() {
      providerTransition += 1;
      accountRequest += 1;
      providerTransitionPending = false;
    }

    function openAccounts(provider = null) {
      dismissAccounts();
      accounts = null;
      for (const input of authProviderInputs()) input.checked = input.value === provider;
      updateAvailability();
      openSheet("sheet-agent-auth");
      loadAccounts();
      requestAnimationFrame(() => authProviderInputs().find((input) => !input.disabled)?.focus());
    }
    $("btn-agent-auth").addEventListener("click", () => openAccounts());
    $("btn-agent-account-refresh").addEventListener("click", loadAccounts);
    $("btn-agent-signout").addEventListener("click", async () => {
      const provider = selectedAuthProvider();
      if (!provider || providerTransitionPending) return;
      providerTransitionPending = true;
      const generation = ++providerTransition;
      updateProviderSelection();
      try {
        await api("/api/agent-accounts", { method: "POST", body: JSON.stringify({ provider, action: "logout" }) });
        if (generation !== providerTransition) return;
        await reloadCapabilities();
        if (generation !== providerTransition) return;
        await loadAccounts();
        if (generation === providerTransition) showToast("Signed out");
      } catch (error) { if (generation === providerTransition) showToast(error.message); }
      finally { if (generation === providerTransition) { providerTransitionPending = false; updateProviderSelection(); } }
    });

    $("btn-auth-provider-continue").addEventListener("click", async () => {
      const provider = selectedAuthProvider();
      if (!provider || providerTransitionPending) return;
      providerTransitionPending = true;
      updateProviderSelection();
      const generation = ++providerTransition;
      if (accounts?.find((a) => a.provider === provider)?.loggedIn) {
        try {
          await api("/api/agent-accounts", { method: "POST", body: JSON.stringify({ provider, action: "switch" }) });
          if (generation !== providerTransition) return;
          await reloadCapabilities();
        } catch (error) {
          if (generation !== providerTransition) return;
          providerTransitionPending = false;
          updateProviderSelection();
          showToast(error.message);
          return;
        }
      }
      if (generation !== providerTransition) return;
      providerTransitionPending = false;
      updateProviderSelection();
      if (isCommandProvider(provider) && commandFor(provider)?.envVar) openCommandTokenSheet(commandFor(provider));
        else if (terminalAgentFor(provider)) openTerminalLogin(provider);
        else if (provider === "codex") beginCodexAuth();
        else if (provider === "command-code") openCommandCodeTokenSheet();
        else beginClaudeAuth();
    });

    function openTerminalLogin(provider) {
      const agent = terminalAgentFor(provider);
      if (!agent) return;
      openTerminal({ kind: "shell", login: agent.id }, `Opening ${agent.label} sign-in…`);
    }
    $("btn-agent-terminal-login").addEventListener("click", () => openTerminalLogin(selectedAuthProvider()));

    /* ---------- Command token ---------- */

    $("form-command-token").addEventListener("submit", async (ev) => {
      ev.preventDefault();
      if (!tokenTarget) return;
      const target = tokenTarget;
      const token = $("input-command-token").value;
      try {
        const result = await api(target.endpoint, { method: "POST", body: JSON.stringify({ token }) });
        $("input-command-token").value = "";
        await reloadCapabilities();
        closeSheet();
        // Where the server can check the credential, report what it found rather
        // than "saved" — a rejected key that reads as stored is the worse lie.
        showToast(target.verifies && result?.verified === false
          ? (result.message || `${target.label} did not accept that ${target.noun}`)
          : `${target.label} ${target.noun} stored`);
      } catch (e) { showToast(e.message); }
    });

    $("btn-command-token-clear").addEventListener("click", async () => {
      if (!tokenTarget) return;
      const target = tokenTarget;
      try {
        await api(target.endpoint, { method: "DELETE" });
        await reloadCapabilities();
        closeSheet();
        showToast(`${target.label} ${target.noun} removed`);
      } catch (e) { showToast(e.message); }
    });

    /* ---------- Claude re-auth ---------- */

    let authPoll = null;

    function stopAuthPoll() {
      if (authPoll) { clearInterval(authPoll); authPoll = null; }
    }

    function showAuthTail(tail) {
      $("auth-tail").hidden = !tail;
      $("auth-tail").textContent = tail || "";
    }

    function finishAuth(message, { tail = "", restart = false } = {}) {
      stopAuthPoll();
      $("auth-wait").textContent = message;
      $("form-auth-code").hidden = true;
      $("auth-link").hidden = true;
      $("btn-auth-restart").hidden = !restart;
      showAuthTail(tail);
    }

    async function pollAuth() {
      let status;
      try { status = await api("/api/claude-auth/status"); } catch { return; }
      if ($("sheet-auth").hidden) { stopAuthPoll(); return; }

      if (status.authorized === true) {
        finishAuth("✓ Claude is authorized on this server. Sessions will work now.");
        showToast("Claude authorized");
        return;
      }
      if (!status.running) {
        finishAuth(
          status.authorized === false
            ? "Authorization did not complete — Claude is still signed out."
            : "Process finished, but the login state couldn't be confirmed.",
          { tail: status.tail, restart: true },
        );
        return;
      }
      if (status.stage === "error") {
        finishAuth(status.error || "The code was rejected.", { tail: status.tail, restart: true });
        return;
      }

      $("btn-auth-restart").hidden = true;
      $("auth-link").hidden = !status.url;
      if (status.url) $("auth-link").href = status.url;
      if (status.stage === "checking") {
        // Keep the form down while the CLI verifies, so the submit doesn't look ignored.
        $("auth-wait").textContent = "Code sent — checking with Anthropic…";
        $("form-auth-code").hidden = true;
      } else if (status.url) {
        $("auth-wait").textContent = "Open the login page, approve, then paste the code below.";
        $("form-auth-code").hidden = false;
      } else {
        $("auth-wait").textContent = "Waiting for the login URL…";
      }
      showAuthTail(status.tail);
    }

    async function startClaudeAuthRun() {
      stopAuthPoll();
      $("auth-link").hidden = true;
      $("form-auth-code").hidden = true;
      $("auth-tail").hidden = true;
      $("btn-auth-restart").hidden = true;
      $("auth-wait").textContent = "Starting…";
      $("input-auth-code").value = "";
      try { await api("/api/claude-auth/start", { method: "POST" }); } catch (error) {
        showToast(error.message);
        $("auth-wait").textContent = error.message;
        return;
      }
      authPoll = setInterval(pollAuth, 2000);
      pollAuth();
    }

    function beginClaudeAuth() {
      openSheet("sheet-auth");
      startClaudeAuthRun();
    }

    // Reopening the sheet would re-enter closeSheet's hide timer, so restart in place.
    $("btn-auth-restart").addEventListener("click", startClaudeAuthRun);

    $("form-auth-code").addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        await api("/api/claude-auth/code", {
          method: "POST",
          body: JSON.stringify({ code: $("input-auth-code").value.trim() }),
        });
        $("auth-wait").textContent = "Code sent — checking with Anthropic…";
        $("form-auth-code").hidden = true;
        $("input-auth-code").value = "";
      } catch (error) {
        showToast(error.message);
      }
    });

    $("btn-auth-cancel").addEventListener("click", async () => {
      stopAuthPoll();
      await api("/api/claude-auth/cancel", { method: "POST" }).catch(() => {});
      closeSheet();
    });

    /* ---------- Codex device auth ---------- */

    let codexAuthPoll = null;
    let codexAuthActive = false;
    let codexAuthGeneration = 0;
    let lastCodexAuthPresentation = "";

    const normalizeAuthState = (state) => String(state || "failed").toLowerCase().replace(/[ -]/g, "_");
    const activeStates = new Set(["starting", "running", "awaiting", "awaiting_user", "pending"]);
    const successStates = new Set(["success", "succeeded", "authenticated", "already_authenticated"]);

    function stopCodexAuthPoll() {
      if (codexAuthPoll) { clearInterval(codexAuthPoll); codexAuthPoll = null; }
    }

    function safeHttpsUrl(value) {
      try {
        const url = new URL(String(value));
        return url.protocol === "https:" ? url.href : null;
      } catch { return null; }
    }

    function renderCodexAuth(raw) {
      const status = raw?.status && typeof raw.status === "object" ? raw.status : (raw || {});
      const state = normalizeAuthState(status.state);
      const active = activeStates.has(state);
      const success = successStates.has(state);
      const url = active ? safeHttpsUrl(status.verificationUrl) : null;
      const userCode = active && typeof status.userCode === "string" && status.userCode.length <= 80
        ? status.userCode
        : "";
      const defaults = {
        starting: "Starting Codex device sign-in…",
        running: "Waiting for the Codex verification details…",
        awaiting: "Open the verification page and enter this device code.",
        awaiting_user: "Open the verification page and enter this device code.",
        pending: "Waiting for authorization in your browser…",
        success: "Codex is signed in on this server.",
        succeeded: "Codex is signed in on this server.",
        authenticated: "Codex is signed in on this server.",
        already_authenticated: "Codex is already signed in on this server.",
        timeout: "The device sign-in timed out. Start it again to get a new code.",
        expired: "The device sign-in timed out. Start it again to get a new code.",
        cancelled: "Codex device sign-in was cancelled.",
        missing_binary: "Codex is not installed for the server account.",
        unavailable_device_auth: "This Codex installation does not support device sign-in.",
        failed: "Codex device sign-in could not be completed.",
      };
      const suppliedError = !active && !success && typeof status.error === "string" ? status.error : "";
      const suppliedMessage = typeof status.message === "string" ? status.message : "";
      const message = suppliedError || suppliedMessage || defaults[state] || defaults.failed;
      const presentation = JSON.stringify([state, url, userCode, message]);
      codexAuthActive = active;

      if (presentation === lastCodexAuthPresentation) return;
      lastCodexAuthPresentation = presentation;
      $("codex-auth-message").textContent = message;
      $("codex-auth-link").hidden = !url;
      if (url) $("codex-auth-link").href = url;
      else $("codex-auth-link").removeAttribute("href");
      $("codex-auth-code-wrap").hidden = !userCode;
      $("codex-auth-code").textContent = userCode;
      $("btn-codex-auth-copy").hidden = !userCode;
      $("btn-codex-auth-cancel").hidden = !active;
      $("btn-codex-auth-retry").hidden = active || success;
      $("btn-codex-auth-close").hidden = active;
      $("btn-codex-auth-close").textContent = success ? "Done" : "Close";
      if (!active) stopCodexAuthPoll();
    }

    async function pollCodexAuth(generation = codexAuthGeneration) {
      if (generation !== codexAuthGeneration || $("sheet-codex-auth").hidden) {
        stopCodexAuthPoll();
        return;
      }
      try {
        const status = await api("/api/codex-auth/status");
        if (generation === codexAuthGeneration && !$("sheet-codex-auth").hidden) renderCodexAuth(status);
      } catch (error) {
        if (generation === codexAuthGeneration && !$("sheet-codex-auth").hidden) {
          renderCodexAuth({ state: "failed", error: error.message || "Could not check Codex sign-in." });
        }
      }
    }

    async function startCodexAuth() {
      const generation = ++codexAuthGeneration;
      stopCodexAuthPoll();
      lastCodexAuthPresentation = "";
      renderCodexAuth({ state: "starting" });
      try {
        const status = await api("/api/codex-auth/start", { method: "POST" });
        if (generation !== codexAuthGeneration || $("sheet-codex-auth").hidden) return;
        renderCodexAuth(status);
        if (codexAuthActive) {
          stopCodexAuthPoll();
          codexAuthPoll = setInterval(() => pollCodexAuth(generation), 1500);
          pollCodexAuth(generation);
        }
      } catch (error) {
        if (generation === codexAuthGeneration && !$("sheet-codex-auth").hidden) {
          renderCodexAuth({ state: "failed", error: error.message || "Could not start Codex sign-in." });
        }
      }
    }

    function beginCodexAuth() {
      openSheet("sheet-codex-auth");
      startCodexAuth();
    }

    function dismissCodexAuth() {
      codexAuthGeneration += 1;
      stopCodexAuthPoll();
      if (codexAuthActive) api("/api/codex-auth/cancel", { method: "POST" }).catch(() => {});
      codexAuthActive = false;
      lastCodexAuthPresentation = "";
      $("codex-auth-code").textContent = "";
      $("codex-auth-code-wrap").hidden = true;
      $("btn-codex-auth-copy").hidden = true;
      $("codex-auth-link").hidden = true;
      $("codex-auth-link").removeAttribute("href");
    }

    $("btn-codex-auth-copy").addEventListener("click", async () => {
      const copied = await copyText($("codex-auth-code").textContent || "");
      showToast(copied ? "Device code copied" : "Couldn’t copy to clipboard");
    });
    $("btn-codex-auth-retry").addEventListener("click", startCodexAuth);
    $("btn-codex-auth-cancel").addEventListener("click", async () => {
      codexAuthGeneration += 1;
      stopCodexAuthPoll();
      codexAuthActive = false;
      await api("/api/codex-auth/cancel", { method: "POST" }).catch(() => {});
      closeSheet();
    });
    $("btn-codex-auth-close").addEventListener("click", closeSheet);

    /* ---------- claude.ai browser (chat deletion) ---------- */

    let browserPoll = null;
    let submittingCode = false;
    let signInStarted = false; // a sign-in began during this visit to the sheet

    function stopBrowserPoll() {
      if (browserPoll) { clearInterval(browserPoll); browserPoll = null; }
      stopLive();
    }

    /* Live view: claude.ai sometimes asks for a human check (a CAPTCHA) after the code. The
       server browser's screen is shown here and the person's taps and drags are replayed there. */
    let liveTimer = null;
    let liveOn = false;
    function nextLiveFrame(delay) {
      clearTimeout(liveTimer);
      liveTimer = setTimeout(() => {
        if (!liveOn || $("sheet-browser").hidden) return stopLive();
        $("browser-live-img").src = `/api/browser-auth/screen?t=${Date.now()}`;
      }, delay);
    }
    function startLive() {
      if (liveOn) return;
      liveOn = true;
      nextLiveFrame(0);
    }
    function stopLive() {
      liveOn = false;
      clearTimeout(liveTimer);
      liveTimer = null;
    }
    $("browser-live-img").addEventListener("load", () => { if (liveOn) nextLiveFrame(500); });
    $("browser-live-img").addEventListener("error", () => { if (liveOn) nextLiveFrame(1500); });

    let liveDown = null;
    const liveFraction = (event) => {
      const rect = $("browser-live-img").getBoundingClientRect();
      const clamp = (v) => Math.min(1, Math.max(0, v));
      return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height), rect };
    };
    $("browser-live-img").addEventListener("pointerdown", (event) => {
      event.preventDefault();
      $("browser-live-img").setPointerCapture?.(event.pointerId);
      liveDown = liveFraction(event);
    });
    $("browser-live-img").addEventListener("pointerup", (event) => {
      if (!liveDown) return;
      const start = liveDown;
      liveDown = null;
      const end = liveFraction(event);
      const moved = Math.hypot((end.x - start.x) * end.rect.width, (end.y - start.y) * end.rect.height);
      const input = moved < 8 ? { type: "click", x: start.x, y: start.y }
        : { type: "drag", x: start.x, y: start.y, x2: end.x, y2: end.y };
      api("/api/browser-auth/input", { method: "POST", body: JSON.stringify(input) })
        .then(() => nextLiveFrame(300))
        .catch((error) => showToast(error.message));
    });
    $("browser-live-img").addEventListener("pointercancel", () => { liveDown = null; });

    /**
     * One place decides what the sheet offers, so the start button and the code form never
     * compete: while a code is expected, "Submit code" is the only primary action, and asking
     * for another code is a deliberate secondary link (it starts over and voids the last code).
     */
    function browserStep(step, message) {
      const start = $("btn-browser-start");
      const wait = $("browser-wait");
      // After a success the button stays as "Sign in again": the login can expire later, or the
      // account can change, and the sheet must always offer a way back in.
      start.hidden = step === "starting" || step === "code_sent" || step === "submitting" || step === "human_check";
      $("browser-live").hidden = step !== "human_check";
      if (step === "human_check") startLive(); else stopLive();
      start.disabled = step === "starting";
      start.textContent = step === "error" ? "Try again — email me a code"
        : step === "success" ? "Sign in again" : "Sign in — email me a code";
      start.classList.toggle("btn-primary", step !== "success");
      start.classList.toggle("btn-ghost", step === "success");
      $("form-browser-code").hidden = !(step === "code_sent" || step === "submitting");
      $("btn-browser-resend").hidden = step !== "code_sent";
      // While the server types the code into claude.ai and waits (~20s), show it is working.
      const busy = step === "submitting";
      const submit = $("btn-browser-code-submit");
      submit.disabled = busy;
      submit.classList.toggle("is-busy", busy);
      submit.textContent = busy ? "Signing in…" : "Submit code";
      $("input-browser-code").disabled = busy;
      wait.hidden = step === "idle";
      if (message !== undefined) wait.textContent = message;
    }

    async function pollBrowser() {
      let status;
      try { status = await api("/api/browser-auth/status"); } catch { return; }
      if ($("sheet-browser").hidden) { stopBrowserPoll(); return; }
      const queue = status.queue || {};
      const queueEl = $("browser-queue");
      if (queue.authExpired) {
        queueEl.hidden = false;
        queueEl.textContent = "⚠️ The browser login expired — sign in again, then failed deletions retry automatically.";
      } else if (queue.pending || queue.failed) {
        queueEl.hidden = false;
        queueEl.textContent = `Deletion queue: ${queue.pending} pending, ${queue.failed} failed.`;
      } else {
        queueEl.hidden = true;
      }
      const account = $("browser-account");
      account.hidden = !status.email;
      account.textContent = status.email ? `Codes are emailed to ${status.email}.` : "";
      if (status.state === "starting") browserStep("starting", "Opening claude.ai…");
      else if (status.state === "human_check") {
        submittingCode = false;
        browserStep("human_check", status.message || "claude.ai wants to check you're human — solve it below.");
      }
      else if (status.state === "code_sent") {
        // Keep "signing in…" while a submitted code is being checked; polling must not undo it.
        if (!submittingCode) browserStep("code_sent", status.message || "Code emailed — paste it below.");
      } else if (status.state === "success" && queue.authExpired && !signInStarted) {
        // An old success on disk; deletions have since found the login expired.
        browserStep("idle");
      } else if (status.state === "success") {
        submittingCode = false;
        browserStep("success", "✓ Signed in. Chat deletions will work.");
        if (queue.failed) api("/api/chat-queue/retry", { method: "POST" }).catch(() => {});
        stopBrowserPoll();
      } else if (status.state === "error") {
        submittingCode = false;
        browserStep("error", `Failed: ${status.message || "unknown error"}`);
      }
    }

    $("btn-browser-auth").addEventListener("click", () => {
      submittingCode = false;
      signInStarted = false;
      browserStep("idle");
      $("input-browser-code").value = "";
      openSheet("sheet-browser");
      stopBrowserPoll();
      browserPoll = setInterval(pollBrowser, 2000);
      pollBrowser();
    });

    async function startBrowserSignIn() {
      const start = $("btn-browser-start");
      if (start.disabled) return;
      // Disabled at once: a second click would start another sign-in and void the first code.
      start.disabled = true;
      submittingCode = false;
      signInStarted = true;
      $("input-browser-code").value = "";
      browserStep("starting", "Opening claude.ai…");
      try { await api("/api/browser-auth/start", { method: "POST" }); }
      catch (error) { showToast(error.message); browserStep("error", `Failed: ${error.message}`); }
    }
    $("btn-browser-start").addEventListener("click", startBrowserSignIn);
    $("btn-browser-resend").addEventListener("click", startBrowserSignIn);

    $("form-browser-code").addEventListener("submit", async (event) => {
      event.preventDefault();
      if (submittingCode) return;
      submittingCode = true;
      browserStep("submitting", "Checking the code with claude.ai — this takes about 20 seconds…");
      try {
        await api("/api/browser-auth/code", {
          method: "POST",
          body: JSON.stringify({ code: $("input-browser-code").value.trim() }),
        });
      } catch (error) {
        submittingCode = false;
        showToast(error.message);
        browserStep("code_sent", "Code emailed — paste it below.");
      }
    });

    // Closing only stops watching: a sign-in waiting for the emailed code keeps waiting, and
    // "Send a new code" replaces it on the server.
    $("btn-browser-cancel").addEventListener("click", stopBrowserPoll);

    return { updateAvailability, dismissCodexAuth, dismissAccounts, openAccounts, refreshAccounts: loadAccounts, openCommandToken: openCommandTokenSheet };
  };
})();
