/* Coding Sessions: finish an external MCP connector sign-in. Loaded only by the callback landing. */
(() => {
  const params = new URLSearchParams(location.search);
  // Take the code and state out of the address bar and history before anything else.
  history.replaceState(null, "", location.pathname);
  const body = {};
  for (const key of ["state", "code", "iss", "error"]) if (params.has(key)) body[key] = params.get(key);
  const main = document.querySelector(".callback");
  const back = document.getElementById("back");
  const show = (state, title, detail, connectorId) => {
    main.dataset.state = state;
    document.getElementById("title").textContent = title;
    document.getElementById("detail").textContent = detail;
    // Return only to an internal settings view, by connector id; never with the code or state.
    if (/^[0-9a-f-]{36}$/.test(connectorId ?? "")) back.href = `/?settings=connector&id=${connectorId}`;
    back.hidden = false;
    back.focus();
  };
  if (!body.state) { show("error", "Sign-in incomplete", "This page was opened without a sign-in response. Start the sign-in from connector settings."); return; }
  // Default fetch mode sends the real Origin even under no-referrer; the server requires it.
  fetch("/api/connectors/oauth/complete", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
    .then(async (response) => {
      const data = await response.json().catch(() => ({}));
      if (response.ok) {
        const who = data.connector?.auth?.oauth?.identity;
        const account = who ? ` as ${who.email || who.name || who.subject}` : "";
        show("ok", "Signed in", `${data.connector?.name ?? "The connector"} is signed in${account}. Choose which tools agents may use in its settings.`, data.connector?.id);
        back.textContent = "Open connector settings";
      } else show("error", "Sign-in not completed", data.error || "Start the sign-in again from connector settings.");
    })
    .catch(() => show("error", "Sign-in not completed", "The app could not be reached. Start the sign-in again from connector settings."));
})();
