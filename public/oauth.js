/* Sign-in step of the MCP connector's consent page (/oauth/authorize).
 *
 * The session cookie is SameSite=Strict, so on the navigation in from claude.ai or a
 * CLI's browser tab it isn't sent and the server shows this sign-in form even to a
 * signed-in user. A same-origin fetch does carry it: if /api/me says we're signed in,
 * reload from here (now a same-site navigation) and the consent page comes up. */
(() => {
  const box = document.querySelector("[data-oauth-signin]");
  if (!box) return;
  const $ = (id) => document.getElementById(id);
  const again = () => location.replace(location.href);

  async function api(path, body) {
    const res = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  }

  function showError(msg) {
    $("login-error").textContent = msg;
    $("login-error").hidden = false;
  }

  function showForms() {
    const canPasskey = box.dataset.hasPasskey === "1" && window.SimpleWebAuthnBrowser?.browserSupportsWebAuthn();
    $("btn-passkey").hidden = !canPasskey;
    $("form-password").hidden = canPasskey;
    $("btn-use-password").hidden = !canPasskey;
  }

  $("btn-passkey").addEventListener("click", async () => {
    try {
      const { options, challengeId } = await api("/api/auth/login/options");
      const response = await SimpleWebAuthnBrowser.startAuthentication({ optionsJSON: options });
      await api("/api/auth/login/verify", { challengeId, response });
      again();
    } catch (e) {
      if (e.name !== "NotAllowedError") showError(e.message || "Couldn't unlock.");
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
      await api("/api/auth/password", { password: $("input-password").value });
      again();
    } catch (e) {
      showError(e.message);
    }
  });

  // Once per page: should a browser still withhold the cookie after the reload,
  // fall back to the form instead of reloading forever.
  const KEY = "oauth-reloaded:" + location.href;
  let reloaded = false;
  try { reloaded = sessionStorage.getItem(KEY) === "1"; sessionStorage.setItem(KEY, "1"); } catch {}
  api("/api/me").then((me) => (me.authed && !reloaded ? again() : showForms())).catch(showForms);
})();
