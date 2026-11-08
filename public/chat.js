/* Chat window — a session's conversation as messages, with a reply box.
 *
 * Opened in its own tab by app.js, like term.html. It polls
 * /api/sessions/:id/transcript with a cursor, so each poll carries only what is
 * new, and sends replies through /api/sessions/:id/message, which types them into
 * the session exactly as the terminal would. Transcript text is agent and user
 * content: it is only ever set with textContent.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const id = params.get("id") ?? "";
  const name = params.get("name") ?? "Chat";
  const api = `/api/sessions/${encodeURIComponent(id)}`;

  const list = $("chat-list");
  const input = $("chat-input");
  const send = $("chat-send");
  const error = $("chat-error");

  const POLL_MS = 2000;
  const HIDDEN_POLL_MS = 15000;
  const RETRY_MS = 5000;
  const MAX_ROWS = 1000;
  const STATE_TEXT = { asking: "Waiting on you", working: "Working…", waiting: "Your turn", unknown: "" };

  let cursor = null;
  let seen = new Set();
  let timer = null;
  let gone = false;

  $("chat-name").textContent = name;
  document.title = `${name} — Chat`;
  $("btn-chat-close").addEventListener("click", () => { window.close(); if (!window.closed) location.href = "/"; });

  if (!/^m:cs-[a-z0-9][a-z0-9_-]{0,42}$/i.test(id)) { showGone(); return; }

  /* ---------- reading ---------- */

  function schedule(ms) {
    clearTimeout(timer);
    if (!gone) timer = setTimeout(poll, ms);
  }

  async function poll() {
    let res;
    try {
      res = await fetch(`${api}/transcript${cursor === null ? "" : `?after=${cursor}`}`, { credentials: "same-origin", cache: "no-store" });
    } catch {
      $("chat-state").textContent = "Reconnecting…";
      return schedule(RETRY_MS);
    }
    if (res.status === 401) return showGone("You're signed out.", "Sign in again, then reopen the chat from the app.", "Sign in");
    if (res.status === 404) return showGone();
    if (res.status === 422) {
      const body = await res.json().catch(() => ({}));
      return showGone("No chat for this session.", body.error || "Open its web terminal from the app instead.");
    }
    // A proxy error or a restart (the app updates itself) is passing: keep trying.
    if (!res.ok) {
      $("chat-state").textContent = "Reconnecting…";
      return schedule(RETRY_MS);
    }
    const data = await res.json();
    if (data.reset) { list.replaceChildren(); seen = new Set(); }
    setState(data.state); // first: the banner changes the list's height, and with it "at the bottom"
    render(data.messages || []);
    cursor = Number.isSafeInteger(data.cursor) ? data.cursor : cursor;
    schedule(document.hidden ? HIDDEN_POLL_MS : POLL_MS);
  }

  function render(messages) {
    const fresh = messages.filter((m) => m && typeof m.id === "string" && !seen.has(m.id));
    const empty = $("chat-empty");
    if (!fresh.length) {
      if (empty && !seen.size) empty.textContent = "No messages yet. Say something below.";
      return;
    }
    empty?.remove();
    for (const m of fresh) {
      seen.add(m.id);
      const role = m.role === "user" || m.role === "tool" ? m.role : "assistant";
      const row = document.createElement("div");
      row.className = `chat-msg chat-${role}`;
      const text = document.createElement(role === "tool" ? "code" : "p");
      text.className = "chat-text";
      text.textContent = String(m.text ?? "");
      row.append(text);
      if (typeof m.at === "string") row.title = new Date(m.at).toLocaleString();
      list.append(row);
    }
    // A tab left open on a long session keeps the latest messages, not all of them.
    while (list.children.length > MAX_ROWS) list.firstElementChild.remove();
    pin();
  }

  // Follow new messages only while the reader is at the bottom; scrolling up to read stops it.
  let stick = true;
  const pin = () => { if (stick) list.scrollTop = list.scrollHeight; };
  list.addEventListener("scroll", () => { stick = list.scrollHeight - list.scrollTop - list.clientHeight < 48; });
  window.addEventListener("resize", pin);
  document.fonts?.ready.then(pin); // the web font changes line heights after the first render

  function setState(state) {
    const s = STATE_TEXT[state] !== undefined ? state : "unknown";
    $("chat-state").textContent = STATE_TEXT[s];
    $("chat-banner").hidden = s !== "asking";
    document.body.dataset.state = s;
  }

  function showGone(title, body, linkText) {
    gone = true;
    clearTimeout(timer);
    $("chat-main").hidden = true;
    $("chat-form").hidden = true;
    $("btn-chat-term").hidden = true;
    document.querySelector(".term-live").hidden = true;
    if (title) $("chat-gone-title").textContent = title;
    if (body) $("chat-gone-body").textContent = body;
    if (linkText) $("chat-gone-link").textContent = linkText;
    $("chat-gone").hidden = false;
  }

  /* ---------- replying ---------- */

  async function reply() {
    const text = input.value;
    if (!text.trim() || send.disabled) return;
    send.disabled = true;
    error.hidden = true;
    try {
      const res = await fetch(`${api}/message`, {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Couldn't send that.");
      input.value = "";
      fit();
      schedule(400);
    } catch (e) {
      error.textContent = e.message || "Couldn't send that.";
      error.hidden = false;
    } finally {
      send.disabled = false;
    }
  }

  function fit() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
  }

  $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); reply(); });
  input.addEventListener("input", fit);
  // Enter sends; Shift+Enter (or an IME composing) adds a line.
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); reply(); }
  });

  /* ---------- the terminal, for menus the chat can't answer ---------- */

  // Same flow as app.js's openWebTerminal: pop the tab inside the gesture, then point it at the bridge.
  $("btn-chat-term").addEventListener("click", async () => {
    const tab = window.open("about:blank", "_blank");
    try {
      const res = await fetch("/api/terminal", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "attach", screen: id.slice(2) }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      const url = `/term.html?id=${encodeURIComponent(body.id)}&name=${encodeURIComponent(name)}&mux=${encodeURIComponent(body.mux ?? "screen")}`;
      if (tab) tab.location = url; else location.href = url;
    } catch (e) {
      if (tab) tab.close();
      error.textContent = e.message || "Couldn't open the terminal.";
      error.hidden = false;
    }
  });

  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  poll();
})();
