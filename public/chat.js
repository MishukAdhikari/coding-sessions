/* Chat window — a session's conversation, from one of two sources.
 *
 * Opened in its own tab by app.js, like term.html. Both sources poll with an
 * opaque cursor so each read carries only what is new, and both map their data
 * to the item list chat-view.js renders:
 *
 *   transcript  Claude / Codex terminal sessions: GET /api/sessions/:id/transcript,
 *               replies through POST /message, which types them into the session.
 *   acp         Chat (ACP) sessions (mode=acp): GET /api/sessions/:id/acp returns the
 *               bridge's event log; POST /acp sends prompt, cancel and permission answers.
 *
 * All agent and tool text is content, never markup: chat-view.js sets it as text
 * or builds markdown nodes with chat-markdown.js.
 */
(() => {
  const params = new URLSearchParams(location.search);
  const id = params.get("id") ?? "";
  const name = params.get("name") || "Chat";
  const agentParam = params.get("agent") || "";
  const acp = params.get("mode") === "acp";
  const api = `/api/sessions/${encodeURIComponent(id)}`;

  const POLL_MS = 2000;
  const ACTIVE_POLL_MS = 600;
  const HIDDEN_POLL_MS = 15000;
  const RETRY_MS = 5000;
  const MAX_ITEMS = 1000;

  let cursor = null;
  let timer = null;
  let gone = false;
  let loaded = false;

  const view = window.ChatView.create(document, {
    onSend: (text) => (acp ? sendPrompt(text) : sendMessage(text)),
    onStop: () => command({ op: "cancel" }).then(() => schedule(150)),
    onPermission: (requestId, optionId) => answerPermission(requestId, optionId),
    onTerminal: openTerminal,
    onClose: () => { window.close(); if (!window.closed) location.href = "/"; },
  });

  document.title = `${name} — Chat`;
  view.setHeader({ name, agent: agentParam || null, status: "Connecting…", tone: "starting" });
  view.setTerminal(!acp);
  view.setLoading(true);
  view.setComposer({ canSend: !acp, reason: acp ? "Connecting to the agent…" : "" });

  if (!/^m:cs-[a-z0-9][a-z0-9_-]{0,42}$/i.test(id)) { end(); return; }

  /* ---------- polling ---------- */

  function schedule(ms) {
    clearTimeout(timer);
    if (!gone) timer = setTimeout(poll, ms);
  }

  function end(title, body, linkText) {
    gone = true;
    clearTimeout(timer);
    view.showGone(title, body, linkText);
  }

  function reconnecting() {
    view.setHeader({ status: "Reconnecting…", tone: "starting" });
    schedule(RETRY_MS);
  }

  async function poll() {
    const path = acp ? "acp" : "transcript";
    let res;
    try {
      res = await fetch(`${api}/${path}${cursor === null ? "" : `?after=${encodeURIComponent(cursor)}`}`, { credentials: "same-origin", cache: "no-store" });
    } catch {
      return reconnecting();
    }
    if (res.status === 401) return end("You're signed out.", "Sign in again, then reopen the chat from the app.", "Sign in");
    if (res.status === 404) return end();
    if (res.status === 422) {
      const body = await res.json().catch(() => ({}));
      return end("No chat for this session.", body.error || "Open its web terminal from the app instead.");
    }
    // A proxy error or a restart (the app updates itself) is passing: keep trying.
    if (!res.ok) return reconnecting();
    let data;
    try { data = await res.json(); } catch { return reconnecting(); }
    if (!loaded) { loaded = true; view.setLoading(false); }
    const active = acp ? applyAcp(data) : applyTranscript(data);
    if (data.cursor !== undefined && data.cursor !== null) cursor = data.cursor;
    schedule(document.hidden ? HIDDEN_POLL_MS : active ? ACTIVE_POLL_MS : POLL_MS);
  }

  /* ---------- transcript source ---------- */

  const TRANSCRIPT_STATE = {
    asking: { status: "Waiting on you", tone: "attention" },
    working: { status: "Working", tone: "working" },
    waiting: { status: "Finished", tone: "done" },
    unknown: { status: "Connected", tone: "idle" },
  };
  const TOOL_KINDS = { bash: "execute", read: "read", edit: "edit", multiedit: "edit", write: "edit", notebookedit: "edit", grep: "search", glob: "search", ls: "search", webfetch: "fetch", websearch: "fetch", shell: "execute", exec: "execute", apply_patch: "edit" };
  let transcript = [];
  let seen = new Set();
  let transcriptRev = 0; // never reused, so a message that returns after a reset is drawn again

  function applyTranscript(data) {
    if (data.reset) { transcript = []; seen = new Set(); }
    for (const m of Array.isArray(data.messages) ? data.messages : []) {
      if (!m || typeof m.id !== "string" || seen.has(m.id)) continue;
      seen.add(m.id);
      const text = String(m.text ?? "");
      const key = `m:${m.id}`;
      if (m.role === "user") transcript.push({ key, rev: ++transcriptRev, kind: "user", text, at: m.at });
      else if (m.role === "tool") {
        const word = text.split(/\s/, 1)[0].toLowerCase();
        transcript.push({ key, rev: ++transcriptRev, kind: "tool", preview: true, title: text, toolKind: TOOL_KINDS[word] || "other", status: "completed" });
      } else transcript.push({ key, rev: ++transcriptRev, kind: "assistant", text, at: m.at });
    }
    // A tab left open on a long session keeps the latest messages, not all of them.
    if (transcript.length > MAX_ITEMS) transcript = transcript.slice(-MAX_ITEMS);
    const state = TRANSCRIPT_STATE[data.state] ? data.state : "unknown";
    view.setHeader(TRANSCRIPT_STATE[state]);
    view.setBanner(state === "asking"); // first: the banner changes the list's height, and with it "at the bottom"
    view.setEmpty("No messages yet", "Say something below. The agent's replies appear here as it writes them.");
    view.setItems(transcript, { working: state === "working" });
    document.body.dataset.state = state;
    return false;
  }

  async function sendMessage(text) {
    const res = await fetch(`${api}/message`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify({ text }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || "Couldn't send that.");
    schedule(400);
  }

  /* ---------- ACP source ---------- */

  let model = createAcpModel();
  let permissionBusy = null; // { requestId, optionId }
  let permissionError = null;

  function applyAcp(data) {
    if (data.reset) model = createAcpModel();
    for (const event of Array.isArray(data.events) ? data.events : []) model.apply(event);
    const state = ["starting", "working", "waiting", "idle", "exited", "failed"].includes(data.state) ? data.state : "idle";
    const agent = data.agent || model.agent;
    const agentName = agent?.title || agent?.name || agentParam || "The agent";
    if (data.error) model.error(data.error);

    const header = {
      starting: { status: "Starting", tone: "starting" },
      working: { status: "Working", tone: "working" },
      waiting: { status: "Waiting on you", tone: "attention" },
      idle: model.hasTurns() ? { status: "Finished", tone: "done" } : { status: "Ready", tone: "idle" },
      exited: { status: "Ended", tone: "ended" },
      failed: { status: "Failed", tone: "failed" },
    }[state];
    view.setHeader({ ...header, agent: agent?.title || agent?.name || agentParam || null, version: agent?.version });

    const pending = model.pending();
    const live = state === "working" || state === "waiting";
    view.setComposer({
      working: live,
      canStop: live,
      canSend: state === "idle" || state === "working",
      ended: state === "exited" || state === "failed",
      reason: state === "starting" ? `${agentName} is starting…`
        : pending.length ? "Answer the permission request above, or press Stop."
        : state === "waiting" ? "The agent is waiting on you."
        : state === "exited" ? "This session has ended. Resume it from ended history in the app."
        : state === "failed" ? `${agentName} couldn't start. End the session and try again.`
        : "",
    });

    if (permissionBusy && !pending.some((p) => p.requestId === permissionBusy.requestId)) permissionBusy = null;
    const first = pending[0];
    if (first && permissionError && permissionError.requestId !== first.requestId) permissionError = null;
    view.setPermission(first ? { ...first, agent: agentName, count: pending.length } : null, permissionState(first));

    view.setEmpty(
      state === "starting" ? `Starting ${agentName}…` : "Start the conversation",
      state === "starting" ? "The chat opens as soon as the agent is ready." : `Ask ${agentName} to do something in this project.`,
    );
    view.setItems(model.items(state === "working"), { working: state === "working" && model.idleTail() });
    document.body.dataset.state = state;
    return state === "starting" || live;
  }

  async function command(body) {
    const res = await fetch(`${api}/acp`, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
    return data;
  }

  async function sendPrompt(text) {
    const turnAtSend = model.turn();
    await command({ op: "prompt", text });
    model.echo(text, turnAtSend);
    view.setItems(model.items(true), { working: true });
    schedule(150);
  }

  async function answerPermission(requestId, optionId) {
    if (permissionBusy) return;
    permissionBusy = { requestId, optionId };
    permissionError = null;
    rerenderPermission();
    try {
      await command({ op: "permission", requestId, optionId });
    } catch (e) {
      permissionBusy = null;
      permissionError = { requestId, message: e.message || "Couldn't send that answer." };
      rerenderPermission();
    }
    schedule(150);
  }

  function rerenderPermission() {
    const pending = model.pending();
    const first = pending[0];
    if (!first) return;
    view.setPermission({ ...first, agent: model.agent?.title || model.agent?.name || agentParam || "The agent", count: pending.length }, permissionState(first));
  }

  // Busy and error belong to one request; with none pending there is nothing to mark.
  function permissionState(request) {
    if (!request) return {};
    return {
      busy: permissionBusy && permissionBusy.requestId === request.requestId ? permissionBusy.optionId : null,
      error: permissionError && permissionError.requestId === request.requestId ? permissionError.message : null,
    };
  }

  /* The ACP event log folded into chat items. Keyed so streamed chunks grow one item. */
  function createAcpModel() {
    const list = [];
    const byKey = new Map();
    const requests = new Map(); // requestId -> permission event, while unanswered
    const options = new Map(); // requestId -> permission event, for naming the answer
    const echoes = [];
    let rev = 0;
    let last = null;
    let turn = 0;
    let errorShown = null;
    const model = { agent: null };

    const add = (item) => { item.rev = ++rev; list.push(item); byKey.set(item.key, item); last = item; return item; };
    const touch = (item) => { item.rev = ++rev; };
    const textOf = (content) => {
      if (!content || typeof content !== "object") return "";
      if (content.type === "text") return String(content.text ?? "");
      if (content.type === "resource_link") return `[${content.name || content.uri}](${content.uri})`;
      if (content.type === "image") return "[image]";
      return "";
    };

    function chunk(prefix, kind, update, event) {
      const text = textOf(update.content);
      if (!text) return;
      let item = update.messageId ? byKey.get(`${prefix}:${update.messageId}`) : (last && last.kind === kind ? last : null);
      if (item) { item.text += text; touch(item); last = item; return; }
      add({ key: update.messageId ? `${prefix}:${update.messageId}` : `${prefix}:s${event.seq}`, kind, text, at: event.at });
    }

    function toolFields(item, fields) {
      item.raw = { ...(item.raw || {}), ...fields };
      const raw = item.raw;
      item.title = String(raw.title || item.title || "Tool call");
      item.toolKind = raw.kind || "other";
      item.status = raw.status || "pending";
      const location = Array.isArray(raw.locations) && raw.locations[0]?.path ? String(raw.locations[0].path) : "";
      const base = location.split("/").pop();
      item.target = location && !(base && item.title.includes(base)) ? location : "";
      const input = raw.rawInput;
      if (input && typeof input === "object") {
        const keys = Object.keys(input);
        if (typeof input.command === "string") item.input = Array.isArray(input.args) ? [input.command, ...input.args].join(" ") : input.command;
        else if (keys.every((k) => k === "path" || k === "file_path" || k === "abs_path")) item.input = "";
        else item.input = JSON.stringify(input, null, 2).slice(0, 4000);
      } else item.input = typeof input === "string" ? input : "";
      if (item.toolKind === "execute" && item.input && item.title.replace(/`/g, "") === item.input) item.input = "";
      const contents = [];
      for (const c of Array.isArray(raw.content) ? raw.content : []) {
        if (c?.type === "diff") contents.push({ type: "diff", path: c.path, oldText: c.oldText ?? null, newText: c.newText ?? "" });
        else if (c?.type === "terminal") contents.push({ type: "terminal" });
        else if (c?.type === "content") { const t = textOf(c.content); if (t) contents.push({ type: "text", text: t }); }
      }
      if (!contents.some((c) => c.type === "text") && raw.rawOutput !== undefined && raw.rawOutput !== null) {
        const out = typeof raw.rawOutput === "string" ? raw.rawOutput : JSON.stringify(raw.rawOutput, null, 2);
        if (out && out !== "{}") contents.push({ type: "text", text: out.slice(0, 20000) });
      }
      item.contents = contents;
    }

    function tool(fields, event) {
      if (!fields?.toolCallId) return null;
      const key = `t:${fields.toolCallId}`;
      let item = byKey.get(key);
      if (!item) item = add({ key, kind: "tool", at: event.at });
      else { touch(item); last = item; }
      toolFields(item, fields);
      return item;
    }

    function notice(key, text, level = "info", at) {
      if (byKey.has(key)) return;
      add({ key, kind: "notice", text, level, at });
    }

    model.apply = (event) => {
      if (!event || typeof event !== "object") return;
      switch (event.kind) {
        case "status": if (event.agent) model.agent = event.agent; break;
        case "user": {
          turn++;
          add({ key: `u:${event.seq}`, kind: "user", text: String(event.text ?? ""), at: event.at });
          // The logged prompt replaces the oldest copy shown while it was on its way.
          if (echoes.length) echoes.shift();
          break;
        }
        case "update": {
          const u = event.update || {};
          switch (u.sessionUpdate) {
            case "agent_message_chunk": chunk("a", "assistant", u, event); break;
            case "agent_thought_chunk": chunk("th", "thought", u, event); break;
            case "user_message_chunk": chunk("u", "user", u, event); break;
            case "tool_call":
            case "tool_call_update": tool(u, event); break;
            case "plan": {
              const key = `plan:${turn}`;
              let item = byKey.get(key);
              if (item) { touch(item); last = item; } else item = add({ key, kind: "plan", at: event.at });
              item.entries = (Array.isArray(u.entries) ? u.entries : []).map((e) => ({ content: String(e?.content ?? ""), status: e?.status }));
              break;
            }
            default: break; // unknown update kinds are ignored
          }
          break;
        }
        case "permission": {
          if (!event.requestId) break;
          requests.set(event.requestId, event);
          options.set(event.requestId, event);
          const t = event.toolCall?.toolCallId ? (byKey.get(`t:${event.toolCall.toolCallId}`) || tool({ status: "pending", ...event.toolCall }, event)) : null;
          if (t) { t.awaiting = true; touch(t); }
          break;
        }
        case "permission_resolved": {
          const request = options.get(event.requestId);
          requests.delete(event.requestId);
          const t = request?.toolCall?.toolCallId ? byKey.get(`t:${request.toolCall.toolCallId}`) : null;
          if (t && t.awaiting) { t.awaiting = false; touch(t); }
          const title = request?.toolCall?.title ? ` · ${request.toolCall.title}` : "";
          if (event.outcome === "cancelled" || !event.optionId) notice(`p:${event.seq}`, `Permission request cancelled${title}`, "info", event.at);
          else {
            const option = (request?.options || []).find((o) => o.optionId === event.optionId);
            const label = option?.name || event.optionId;
            notice(`p:${event.seq}`, event.auto ? `Approved automatically (${label})${title}` : `You chose “${label}”${title}`, String(option?.kind || "").startsWith("reject") ? "warning" : "info", event.at);
          }
          break;
        }
        case "turn_end":
          for (const item of list) if (item.kind === "thought" && item.live) { item.live = false; touch(item); }
          if (event.error) notice(`e:${event.seq}`, String(event.error), "error", event.at);
          else if (event.stopReason === "cancelled") notice(`e:${event.seq}`, "Stopped", "info", event.at);
          else if (event.stopReason === "max_tokens") notice(`e:${event.seq}`, "The reply hit the agent's length limit.", "warning", event.at);
          else if (event.stopReason === "max_turn_requests") notice(`e:${event.seq}`, "The agent stopped after too many steps in one turn.", "warning", event.at);
          else if (event.stopReason === "refusal") notice(`e:${event.seq}`, "The agent declined to continue.", "warning", event.at);
          last = null;
          break;
        case "notice": notice(`n:${event.seq}`, String(event.text ?? ""), event.level || "info", event.at); break;
        default: break;
      }
      if (list.length > MAX_ITEMS) {
        for (const old of list.splice(0, list.length - MAX_ITEMS)) byKey.delete(old.key);
      }
    };

    model.error = (text) => {
      if (errorShown === text) return;
      errorShown = text;
      if (![...byKey.values()].some((i) => i.kind === "notice" && i.text === text)) notice(`err:${text}`, text, "error");
    };
    // Shown at once after a send; a poll that already carried the prompt (turn moved on) needs no copy.
    model.echo = (text, turnAtSend) => { if (turn === turnAtSend) echoes.push({ key: `echo:${++rev}`, rev, kind: "user", text, pending: true }); };
    model.turn = () => turn;
    model.pending = () => [...requests.values()];
    model.hasTurns = () => turn > 0 || list.some((i) => i.kind === "user");
    // True when the agent is working but nothing of this turn is streaming yet.
    model.idleTail = () => !last || last.kind === "user";
    model.items = (working) => {
      const tail = list[list.length - 1];
      for (const item of list) {
        if (item.kind !== "thought") continue;
        const live = working && item === tail;
        if (!!item.live !== live) { item.live = live; touch(item); }
      }
      return echoes.length ? [...list, ...echoes] : list;
    };
    return model;
  }

  /* ---------- the terminal, for menus a transcript chat can't answer ---------- */

  // Same flow as app.js's openWebTerminal: pop the tab inside the gesture, then point it at the bridge.
  async function openTerminal() {
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
      view.showError(e.message || "Couldn't open the terminal.");
    }
  }

  document.addEventListener("visibilitychange", () => { if (!document.hidden) schedule(0); });
  poll();
})();
