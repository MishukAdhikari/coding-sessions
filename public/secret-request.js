/* Coding Sessions — answer a session's request for a secret or a connector.
 * Opened from its one-time link (#secret-request=<token>), a session card, or Settings › Secrets.
 * Every node is made with createElement and textContent: the name, the reason and the session
 * come from an agent, so they are only ever shown as text. The copy that warns about what
 * saving does is the app's own and never comes from the request. */
(() => {
  const LINK_KEY = "cs.secretRequest";
  const OAUTH_DONE_KEY = "cs.connectorRequestDone";
  const SHEET = "sheet-secret-request";
  const SVG = "http://www.w3.org/2000/svg";
  const AGENTS = { claude: "Claude", codex: "Codex", "command-code": "Command Code" };
  const GONE = "This link has expired or was already used. Ask the agent for a new one.";

  const minutesLeft = (expiresAt) => Math.max(1, Math.ceil((Number(expiresAt) - Date.now()) / 60_000));
  const agentLabel = (agent) => AGENTS[agent] || (typeof agent === "string" && agent.startsWith("cmd:") ? agent.slice(4) : agent) || "";
  const chipClass = (agent) => `chip chip-provider-${String(agent).startsWith("cmd:") ? "command" : agent}`;
  const isGone = (error) => error?.status === 410 || error?.code === "gone";

  window.createSecretRequestUI = ({ $, api, openSheet, closeSheet, showToast, agoStr, getGrant, onResolved, doc = document, win = window }) => {
    let ref = null; // { token } from a link, or { id } from inside the app; set only once its lookup renders
    let viaLink = false;
    let busy = false;
    let generation = 0; // a lookup that finishes after a newer open() is dropped

    const el = (tag, className, text) => {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = String(text);
      return node;
    };
    const button = (label, className, type = "button") => {
      const b = el("button", className, label);
      b.setAttribute("type", type);
      return b;
    };
    const icon = (paths, className) => {
      const svg = doc.createElementNS(SVG, "svg");
      for (const [k, v] of Object.entries({ class: className, viewBox: "0 0 24 24", width: "18", height: "18", fill: "none", stroke: "currentColor",
        "stroke-width": "1.8", "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false" })) svg.setAttribute(k, v);
      for (const d of paths) {
        const path = doc.createElementNS(SVG, "path");
        path.setAttribute("d", d);
        svg.append(path);
      }
      return svg;
    };
    const post = (path, body) => api(`/api/secret-requests/${path}`, { method: "POST", body: JSON.stringify(body) });
    const store = (fn) => { try { return fn(win.sessionStorage); } catch { return null; } };
    const forgetLink = () => store((s) => s?.removeItem(LINK_KEY));
    const heading = () => $("secret-request-heading");
    const content = () => $("secret-request-content");

    function setHeading(textValue, outcome = false) {
      heading().textContent = textValue;
      heading().classList.toggle("sr-outcome-title", outcome);
    }

    /* ---------- the request ---------- */

    function render(view) {
      const connector = view.kind === "connector";
      const operator = view.requested_by === "operator";
      const bearer = connector && view.auth !== "oauth";
      setHeading(operator ? "Requested through the operator connection (MCP)"
        : connector ? "A session is asking to connect a server" : "A session is asking for a secret");
      const body = content();
      body.dataset.state = "pending";
      body.replaceChildren();

      if (view.session?.name) {
        const who = el("p", "sr-who");
        if (operator) who.append("for ");
        who.append(el("span", "sr-session", view.session.name));
        if (view.session.agent) who.append(" ", el("span", chipClass(view.session.agent), agentLabel(view.session.agent)));
        body.append(who);
      }

      const subject = el("div", "sr-subject");
      subject.append(el("p", "sr-name", view.name));
      if (connector && view.host) subject.append(el("p", "sr-host", bearer ? `Your token will be sent to ${view.host}.` : view.host));
      body.append(subject);

      const reason = el("figure", "sr-reason");
      reason.append(el("figcaption", "sr-reason-label", "Their reason"), el("blockquote", "sr-reason-text", view.reason ?? ""));
      body.append(reason);

      const agent = view.session?.agent ? `${agentLabel(view.session.agent)} sessions` : "every session";
      const warning = el("p", "sr-note");
      warning.append(
        icon(["M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6L12 3Z", "M12 8v4.5", "M12 15.75v.01"], "sr-note-icon"),
        el("span", null, connector
          ? `The token stays in Coding Sessions; agents use this server’s tools through it but never see the token. All of its tools will be available to ${agent}; narrow them in Settings › Connectors.`
          : "Every session on this server can read this value, including ones already running."),
      );
      body.append(warning);

      if (connector && view.connector?.url_matches === false) {
        body.append(el("p", "sr-existing sr-conflict", "A connector with this name points elsewhere; change it in Settings › Connectors."));
        body.append(declineButton(), expiry(view));
        return;
      }

      const replacing = connector
        ? !!(view.connector?.credential_set || view.connector?.state === "connected")
        : view.existing?.set === true;
      const existing = el("p", "sr-existing");
      existing.hidden = !replacing;
      if (replacing) existing.textContent = connector ? `${view.name} is already connected. Saving replaces its token for every session.` : existingText(view);
      body.append(existing);

      const ctx = valueForm(view, { connector, replacing });
      if (connector && !bearer) {
        // OAuth: signing in at the host is the main way; a token stays one tap away.
        ctx.form.hidden = true;
        const signIn = button(`Sign in to ${view.host || view.name}`, "btn btn-primary btn-big");
        signIn.addEventListener("click", () => startOAuth(signIn, ctx));
        const paste = button("Paste a token instead", "btn-link sr-paste");
        paste.addEventListener("click", () => {
          ctx.form.hidden = false;
          paste.hidden = true;
          ctx.input.focus();
        });
        body.append(signIn, paste);
      }
      body.append(ctx.form, ctx.stepUp, declineButton(), expiry(view));
    }

    function existingText(view) {
      const from = view.existing.source ? ` from ${view.existing.source}` : "";
      const when = view.existing.updated_at ? `, updated ${agoStr(view.existing.updated_at)}` : "";
      return `${view.name} already has a value${from}${when}. Saving replaces it for every session.`;
    }

    function expiry(view) {
      return el("p", "hint sr-expiry", `${viaLink ? "Link expires" : "Expires"} in ${minutesLeft(view.expires_at)} min`);
    }

    /** The value (or token) field, never prefilled and kept away from password managers. */
    function valueForm(view, { connector, replacing }) {
      const form = el("form", "sr-form");
      form.setAttribute("autocomplete", "off");
      const input = el("input", "field sr-field");
      const attrs = {
        type: "password", name: `v${Math.random().toString(36).slice(2, 12)}`, autocomplete: "off", autocapitalize: "off",
        autocorrect: "off", spellcheck: "false", "data-1p-ignore": "", "data-lpignore": "true", "data-bwignore": "", "data-form-type": "other",
        "aria-label": connector ? `Token for ${view.host || view.name}` : `Value for ${view.name}`,
        placeholder: connector ? "Paste the token" : "Paste the value",
      };
      for (const [k, v] of Object.entries(attrs)) input.setAttribute(k, v);
      input.value = "";
      if (connector && view.auth === "oauth" && view.host) form.append(el("p", "hint sr-token-host", `Your token will be sent to ${view.host}.`));
      const error = el("p", "sr-error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      const save = button(replacing ? "Replace…" : connector ? "Connect" : "Save", "btn btn-primary btn-big", "submit");
      form.append(input, error, save);
      const ctx = { view, connector, replacing, form, input, error, save, stepUp: el("div", "sr-stepup") };
      ctx.stepUp.hidden = true;
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        if (connector) connectBearer(ctx);
        else saveSecret(ctx);
      });
      return ctx;
    }

    function declineButton() {
      const decline = button("Decline", "btn btn-ghost btn-big sr-decline");
      decline.addEventListener("click", () => declineRequest(decline));
      return decline;
    }

    function showError(ctx, message) {
      ctx.error.textContent = message;
      ctx.error.hidden = !message;
    }

    function setBusy(control, on) {
      busy = on;
      control.disabled = on;
      control.classList.toggle("is-busy", on);
      for (const b of content().querySelectorAll("button")) if (b !== control) b.disabled = on;
    }

    /** A fresh check for this one change: the passkey, or the admin password asked for right here. */
    async function confirmIdentity(ctx) {
      try {
        return await getGrant({ askPassword: () => askPassword(ctx) });
      } catch (error) {
        if (error?.name === "NotAllowedError") return null; // the passkey prompt was dismissed
        throw error;
      } finally {
        ctx.stepUp.hidden = true;
        ctx.stepUp.replaceChildren();
      }
    }

    // Its own form beside the value's, so a password manager never pairs the two as old and new.
    function askPassword(ctx) {
      return new Promise((resolve) => {
        const box = ctx.stepUp;
        box.replaceChildren();
        const form = el("form", "server-setting-confirm sr-stepup-form");
        const label = el("p", "sr-stepup-label", "Confirm it’s you with the admin password.");
        const input = el("input", "field");
        for (const [k, v] of Object.entries({ type: "password", autocomplete: "current-password", placeholder: "Admin password", "aria-label": "Admin password", required: "" })) input.setAttribute(k, v);
        const confirm = button("Confirm", "btn btn-primary", "submit");
        const cancel = button("Cancel", "btn btn-ghost");
        form.append(label, input, confirm, cancel);
        // Waiting on the person, not the network: no spinner until they confirm.
        ctx.save.classList.remove("is-busy");
        form.addEventListener("submit", (event) => { event.preventDefault(); ctx.save.classList.add("is-busy"); resolve(input.value); input.value = ""; });
        cancel.addEventListener("click", () => resolve(null));
        box.append(form);
        box.hidden = false;
        // While it waits, the step-up is the only thing to press.
        confirm.disabled = false;
        cancel.disabled = false;
        input.focus();
      });
    }

    async function saveSecret(ctx) {
      if (busy) return;
      const value = ctx.input.value;
      if (!value) { showError(ctx, "Paste the value first."); ctx.input.focus(); return; }
      showError(ctx, "");
      setBusy(ctx.save, true);
      const target = ref; // the request on screen now, whatever opens while this waits
      try {
        const body = { ...target, value };
        if (ctx.replacing) {
          const grant = await confirmIdentity(ctx);
          if (!grant || target !== ref) return;
          Object.assign(body, { replace: true, grant });
        }
        await post("fulfil", body);
        ctx.input.value = "";
        if (target !== ref) return;
        finish(ctx.view, "saved");
      } catch (error) {
        if (isGone(error)) { ctx.input.value = ""; gone(); return; }
        if (error?.code === "exists" || error?.code === "step_up") {
          // Someone saved this name meanwhile: replacing it now takes the step-up.
          ctx.replacing = true;
          ctx.save.textContent = "Replace…";
        }
        showError(ctx, error?.message || "Couldn’t save it. Try again.");
      } finally {
        if (busy) setBusy(ctx.save, false);
      }
    }

    async function connectBearer(ctx) {
      if (busy) return;
      const value = ctx.input.value;
      if (!value) { showError(ctx, "Paste the token first."); ctx.input.focus(); return; }
      showError(ctx, "");
      setBusy(ctx.save, true);
      const target = ref; // bound before the step-up wait: the token goes only to this request's server
      try {
        // Sending a token to a server always takes the step-up: the address came from an agent.
        const grant = await confirmIdentity(ctx);
        if (!grant || target !== ref) return;
        const result = await post("connector", { ...target, auth: "bearer", value, grant });
        if (target !== ref) return;
        if (result?.ok && result.state === "fulfilled") {
          ctx.input.value = "";
          finish(ctx.view, "connected");
          return;
        }
        showError(ctx, result?.detail || "The server didn’t accept the token.");
        ctx.save.textContent = "Try again";
      } catch (error) {
        if (isGone(error)) { ctx.input.value = ""; gone(); return; }
        showError(ctx, error?.message || "Couldn’t connect. Try again.");
      } finally {
        if (busy) setBusy(ctx.save, false);
      }
    }

    async function startOAuth(control, ctx) {
      if (busy) return;
      showError(ctx, "");
      setBusy(control, true);
      const target = ref;
      try {
        // The callback page reads this to say the tab can close.
        store((s) => s?.setItem(OAUTH_DONE_KEY, "1"));
        let result;
        try { result = await post("connector", { ...target, auth: "oauth" }); }
        catch (error) {
          // Switching a connector that holds a token over to a sign-in replaces that token.
          if (error?.code !== "step_up") throw error;
          const grant = await confirmIdentity(ctx);
          if (!grant || target !== ref) { store((s) => s?.removeItem(OAUTH_DONE_KEY)); setBusy(control, false); return; }
          result = await post("connector", { ...target, auth: "oauth", grant });
        }
        if (target !== ref) return;
        if (result?.state === "fulfilled") { store((s) => s?.removeItem(OAUTH_DONE_KEY)); finish(ctx.view, "connected"); return; }
        if (!result?.connector_id) throw new Error(result?.detail || "Couldn’t start the sign-in. Try again.");
        const { authorization_url: url } = await api(`/api/connectors/${encodeURIComponent(result.connector_id)}/oauth/start`, { method: "POST", body: "{}" });
        forgetLink();
        win.location.href = url;
      } catch (error) {
        store((s) => s?.removeItem(OAUTH_DONE_KEY));
        if (isGone(error)) { gone(); return; }
        setBusy(control, false);
        ctx.form.hidden = false;
        showError(ctx, error?.message || "Couldn’t start the sign-in. Try again.");
      }
    }

    async function declineRequest(control) {
      if (busy) return;
      setBusy(control, true);
      const target = ref;
      try {
        await post("decline", target);
        if (target !== ref) return;
        finish(null, "declined");
      } catch (error) {
        if (isGone(error)) { gone(); return; }
        setBusy(control, false);
        showToast(error?.message || "Couldn’t decline it. Try again.");
      }
    }

    /* ---------- outcomes ---------- */

    function outcome(state, title, detail) {
      busy = false;
      forgetLink();
      setHeading(title, true);
      const body = content();
      body.dataset.state = state;
      body.replaceChildren();
      if (detail) {
        const line = el("p", "sr-done-name");
        if (state === "done") line.append(icon(["M20 6 9 17l-5-5"], "sr-done-icon"));
        line.append(el("span", null, detail));
        body.append(line);
      }
      const done = button(state === "done" ? "Done" : "Close", `btn ${state === "done" ? "btn-primary" : "btn-ghost"} btn-big`);
      done.addEventListener("click", () => closeSheet());
      body.append(done);
      done.focus();
    }

    function finish(view, result) {
      const closeTab = viaLink ? " You can close this tab." : "";
      if (result === "declined") outcome("declined", "Declined. Nothing was saved.");
      else outcome("done", `${result === "connected" ? "Connected." : "Saved."}${closeTab}`, view?.name);
      onResolved?.();
      // Closes only a tab a script opened; anywhere else this does nothing.
      if (viaLink && result !== "declined") { try { win.close(); } catch {} }
    }

    function gone() {
      outcome("gone", GONE);
      onResolved?.();
    }

    async function open(nextRef, fromLink) {
      const gen = ++generation;
      try {
        const { request } = await post("lookup", nextRef);
        if (gen !== generation) return;
        ref = nextRef;
        viaLink = fromLink;
        busy = false;
        render(request);
      } catch (error) {
        if (gen !== generation) return;
        if (!isGone(error)) { showToast(error?.message || "Couldn’t open the request."); return; }
        ref = nextRef;
        viaLink = fromLink;
        busy = false;
        gone();
      }
      openSheet(SHEET);
    }

    /* ---------- Settings › Secrets ---------- */

    function renderSettingsList(container, requests) {
      const list = Array.isArray(requests) ? requests.filter((r) => r?.id) : [];
      container.replaceChildren();
      container.hidden = list.length === 0;
      if (!list.length) return;
      container.append(el("h3", "label", "Requests"));
      for (const request of list) {
        const row = el("div", "proj-row sr-row");
        const copy = el("span", "sr-row-copy");
        const firstLine = String(request.reason ?? "").split("\n")[0].trim();
        const who = request.session?.name || (request.requested_by === "operator" ? "Operator connection" : "");
        copy.append(
          el("span", "sr-row-name", request.name),
          el("span", "pick-path", [who, firstLine].filter(Boolean).join(" · ")),
          el("span", "pick-path", `expires in ${minutesLeft(request.expires_at)} min`),
        );
        const actions = el("div", "row-actions");
        const openButton = button("Open", "proj-act");
        openButton.setAttribute("aria-label", `Open the request for ${request.name}`);
        openButton.addEventListener("click", () => open({ id: request.id }, false));
        const decline = button("Decline", "proj-del");
        decline.setAttribute("aria-label", `Decline the request for ${request.name}`);
        decline.addEventListener("click", async () => {
          decline.disabled = true;
          try {
            await post("decline", { id: request.id });
            showToast(`Declined ${request.name}. Nothing was saved.`);
          } catch (error) {
            if (!isGone(error)) { decline.disabled = false; showToast(error?.message || "Couldn’t decline it."); return; }
          }
          row.remove();
          if (!container.querySelector(".sr-row")) { container.replaceChildren(); container.hidden = true; }
          onResolved?.();
        });
        actions.append(openButton, decline);
        row.append(copy, actions);
        container.append(row);
      }
    }

    return {
      openByToken: (token) => open({ token }, true),
      openById: (id) => open({ id }, false),
      renderSettingsList,
    };
  };
})();
