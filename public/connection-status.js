(() => {
  const state = (tone, label, detail) => ({ tone, label, detail });
  const array = (value) => { if (!Array.isArray(value)) throw new Error("Missing status"); return value; };
  const describe = {
    connect: data => {
      const apps = array(data.connections);
      return apps.length
        ? state("positive", "Connected", `${apps.length} ${apps.length === 1 ? "app has" : "apps have"} authorized access.`)
        : state("neutral", "Not connected", "No apps linked through browser sign-in. Token access is managed below.");
    },
    cli: data => {
      const tokens = array(data.tokens);
      return tokens.length
        ? state("positive", "Configured", `${tokens.length} ${tokens.length === 1 ? "token" : "tokens"} available for CLI or MCP access.`)
        : state("neutral", "Not configured", "No access tokens created.");
    },
    github: data => {
      if (typeof data.installed !== "boolean" || typeof data.authenticated !== "boolean") throw new Error("Missing status");
      if (!data.installed) return state("warning", "Needs attention", "GitHub CLI is not installed on the server.");
      return data.authenticated
        ? state("positive", "Connected", data.account ? `Signed in as ${data.account}.` : "GitHub sign-in is active.")
        : state("neutral", "Not connected", "Sign in to access your GitHub repositories.");
    },
    browser: data => {
      if (!data.queue || typeof data.queue.authed !== "boolean") throw new Error("Missing status");
      if (data.queue.authExpired) return state("warning", "Needs attention", "Browser login expired. Sign in again.");
      if (data.state === "error") return state("warning", "Needs attention", "Browser sign-in failed. Open to retry.");
      if (data.running) return state("warning", "Sign-in pending", "Open to finish browser sign-in.");
      if (data.queue.failed) return state("warning", "Needs attention", "Some chat deletions failed. Open for details.");
      if (data.queue.authed) return state("neutral", "Not verified", "Browser profile saved; sign-in is checked when deleting a chat.");
      return state("neutral", "Not connected", "Sign in to delete Claude.ai chats from Sessions.");
    },
    passkey: data => {
      const keys = array(data.passkeys);
      const usable = keys.filter(key => key.usable === true).length;
      if (usable) return state("positive", "Set up", `${usable} ${usable === 1 ? "passkey" : "passkeys"} on your account. This device has not been verified.`);
      if (keys.length) return state("warning", "Needs attention", "Saved passkeys cannot sign in to this domain. Add a new one.");
      return state("neutral", "Not set up", "Add a passkey on this device for faster sign-in.");
    },
  };
  const icons = {
    positive: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    neutral: '<circle cx="12" cy="12" r="8"/>',
    warning: '<path d="m12 3 10 18H2Z"/><path d="M12 9v5m0 3v.01"/>',
  };
  function render(key, value) {
    const el = document.getElementById(`connection-${key}`);
    if (!el) return;
    el.dataset.tone = value.tone;
    el.innerHTML = `<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${icons[value.tone]}</svg>`;
    el.appendChild(document.createTextNode(value.label));
    document.getElementById(`connection-${key}-detail`).textContent = value.detail;
  }
  const endpoints = {
    connect: "/api/mcp-connections", cli: "/api/cli-tokens", github: "/api/github-auth/status",
    browser: "/api/browser-auth/status", passkey: "/api/passkeys",
  };
  let generation = 0;
  let controller;
  async function refresh(api) {
    const current = ++generation;
    controller?.abort();
    const request = controller = new AbortController();
    const timeout = setTimeout(() => request.abort(), 8000);
    await Promise.allSettled(Object.entries(endpoints).map(async ([key, path]) => {
      render(key, state("neutral", "Checking…", ""));
      try {
        const data = await api(path, { signal: request.signal });
        if (current === generation) render(key, describe[key](data));
      } catch {
        if (current === generation) render(key, state("warning", "Check failed", "Status is unavailable. Reopen Settings to retry."));
      }
    }));
    clearTimeout(timeout);
  }
  window.connectionStatus = { describe, refresh };
})();
