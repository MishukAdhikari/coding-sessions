/* The chat component shared by transcript chats and ACP chats.
 *
 * It renders a normalized item list and owns the header, the composer, the
 * permission card and scrolling. Sources (chat.js) map their data to items:
 *
 *   { key, rev, kind: "user",      text, at, pending? }
 *   { key, rev, kind: "assistant", text, at }                 markdown
 *   { key, rev, kind: "thought",   text, live? }              collapsed
 *   { key, rev, kind: "tool",      title, toolKind, status, target?, input?,
 *                                  contents?: [{type:"text",text}|{type:"diff",path,oldText,newText}|{type:"terminal"}],
 *                                  awaiting?, preview? }
 *   { key, rev, kind: "plan",      entries: [{content, status}] }
 *   { key, rev, kind: "notice",    level?: "info"|"warning"|"error", text, at? }
 *
 * Reconciliation is keyed: an item whose rev is unchanged keeps its node, a
 * changed one is rebuilt in place (so a streamed message grows one block and an
 * expanded tool row stays expanded). All agent text is set with textContent or
 * through ChatMarkdown, which builds nodes; nothing here writes markup.
 */
(function (root) {
  "use strict";

  const SVG = "http://www.w3.org/2000/svg";
  const ICONS = {
    read: "M4.5 1.75h4.75l2.5 2.5v10H4.5z M9.25 1.75v2.5h2.5 M6.5 8h3.5 M6.5 10.75h3.5",
    edit: "M10.75 2.25l3 3-8 8h-3v-3z M9 4l3 3",
    delete: "M2.75 4.25h10.5 M6.25 4.25V2.75h3.5v1.5 M4.25 4.25l.6 9.5h6.3l.6-9.5",
    move: "M2.75 5.25h10 M10 2.5l2.75 2.75L10 8 M13.25 10.75h-10 M6 8l-2.75 2.75L6 13.5",
    search: "M7 2.25a4.75 4.75 0 1 0 0 9.5a4.75 4.75 0 1 0 0-9.5z M10.5 10.5l3.25 3.25",
    execute: "M2.25 3.25h11.5v9.5H2.25z M4.75 6.25 6.75 8l-2 1.75 M8.5 10h2.75",
    think: "M6 12.25h4 M6.5 14.25h3 M8 1.75a4.25 4.25 0 0 0-2.5 7.7v1.3h5v-1.3A4.25 4.25 0 0 0 8 1.75z",
    fetch: "M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z M1.75 8h12.5 M8 1.75c1.75 1.8 2.6 3.85 2.6 6.25S9.75 12.45 8 14.25 M8 1.75C6.25 3.55 5.4 5.6 5.4 8s.85 4.45 2.6 6.25",
    other: "M3.5 8h.01 M8 8h.01 M12.5 8h.01",
    check: "M3.25 8.5l3 3 6.5-7",
    cross: "M4.5 4.5l7 7 M11.5 4.5l-7 7",
    chevron: "M6 3.75 10.25 8 6 12.25",
    alert: "M8 2.25 14.25 13.25H1.75z M8 6.5v3 M8 11.5h.01",
    info: "M8 1.75a6.25 6.25 0 1 0 0 12.5a6.25 6.25 0 1 0 0-12.5z M8 7.25v4 M8 4.75h.01",
    stop: "M4.5 4.5h7v7h-7z",
    lock: "M4.25 7.25h7.5v6.5h-7.5z M5.75 7.25V5a2.25 2.25 0 0 1 4.5 0v2.25",
  };
  const KIND_ICON = { read: "read", edit: "edit", delete: "delete", move: "move", search: "search", execute: "execute", think: "think", fetch: "fetch" };
  const STATUS = {
    pending: { label: "Pending", icon: null },
    in_progress: { label: "Running", icon: null },
    completed: { label: "Done", icon: "check" },
    failed: { label: "Failed", icon: "cross" },
  };
  const OUTPUT_LINES = 12;
  const DIFF_CONTEXT = 3;

  function create(doc, handlers = {}) {
    const $ = (id) => doc.getElementById(id);
    const main = $("chat-main");
    const list = $("chat-list");
    const empty = $("chat-empty");
    const working = $("chat-working");
    const jump = $("chat-jump");
    const input = $("chat-input");
    const send = $("chat-send");
    const stop = $("chat-stop");
    const reason = $("chat-reason");
    const error = $("chat-error");
    const permission = $("chat-permission");
    const banner = $("chat-banner");

    const nodes = new Map(); // key -> { node, rev }
    const expanded = new Set(); // "<key>:<n>" outputs the reader opened in full
    let composer = { canSend: true, working: false, canStop: false, reason: "" };
    let sending = false;
    let stopping = false;
    let atBottom = true;
    let first = true;

    /* ---------- small DOM helpers ---------- */

    function el(tag, className, text) {
      const node = doc.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    function icon(name, className = "cv-icon") {
      const svg = doc.createElementNS(SVG, "svg");
      svg.setAttribute("viewBox", "0 0 16 16");
      svg.setAttribute("class", className);
      svg.setAttribute("aria-hidden", "true");
      svg.setAttribute("focusable", "false");
      const path = doc.createElementNS(SVG, "path");
      path.setAttribute("d", ICONS[name] || ICONS.other);
      svg.append(path);
      return svg;
    }

    function time(at) {
      if (typeof at !== "string") return null;
      const date = new Date(at);
      if (Number.isNaN(date.getTime())) return null;
      const t = el("time", "cv-time", date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }));
      t.setAttribute("datetime", at);
      t.setAttribute("title", date.toLocaleString());
      return t;
    }

    const shortPath = (p) => {
      const parts = String(p).split("/").filter(Boolean);
      return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : String(p);
    };

    /* ---------- items ---------- */

    function renderUser(item, node) {
      node.className = `cv-turn cv-user${item.pending ? " is-pending" : ""}`;
      const body = el("div", "cv-user-text", item.text);
      const stamp = time(item.at);
      node.replaceChildren(...(stamp ? [stamp, body] : [body]));
    }

    function renderAssistant(item, node) {
      node.className = "cv-turn cv-assistant";
      const body = el("div", "md");
      root.ChatMarkdown.renderInto(body, item.text);
      const stamp = time(item.at);
      node.replaceChildren(...(stamp ? [body, stamp] : [body]));
    }

    function renderThought(item, node) {
      node.className = `cv-thought${item.live ? " is-live" : ""}`;
      const summary = el("summary", "cv-thought-summary");
      summary.append(icon("think"), el("span", "", item.live ? "Thinking…" : "Thinking"), icon("chevron", "cv-icon cv-chevron"));
      const body = el("div", "cv-thought-body md");
      root.ChatMarkdown.renderInto(body, item.text);
      node.replaceChildren(summary, body);
    }

    function renderPlan(item, node) {
      node.className = "cv-plan";
      node.setAttribute("aria-label", "Plan");
      const entries = Array.isArray(item.entries) ? item.entries : [];
      const done = entries.filter((e) => e.status === "completed").length;
      const head = el("div", "cv-plan-head");
      head.append(el("span", "cv-plan-title", "Plan"), el("span", "cv-plan-count", `${done} of ${entries.length} done`));
      const ol = el("ol", "cv-plan-list");
      for (const entry of entries) {
        const status = entry.status === "completed" || entry.status === "in_progress" ? entry.status : "pending";
        const li = el("li", `cv-plan-entry is-${status}`);
        const mark = el("span", "cv-plan-mark");
        if (status === "completed") mark.append(icon("check"));
        const label = { completed: "Done", in_progress: "In progress", pending: "To do" }[status];
        li.append(mark, el("span", "sr-only", `${label}: `), el("span", "cv-plan-text", String(entry.content ?? "")));
        ol.append(li);
      }
      node.replaceChildren(head, ol);
    }

    function renderNotice(item, node) {
      const level = item.level === "error" || item.level === "warning" ? item.level : "info";
      node.className = `cv-notice is-${level}`;
      node.replaceChildren(icon(level === "info" ? "info" : "alert"), el("span", "cv-notice-text", item.text));
    }

    /* Tool title: a verb, then the path or command in monospace when it is one. */
    function toolTitle(item) {
      const wrap = el("span", "cv-tool-title");
      let title = String(item.title || "Tool call").replace(/^`+|`+$/g, "");
      if (item.toolKind === "execute") {
        wrap.append(el("code", "cv-tool-code", title));
        return wrap;
      }
      const space = title.indexOf(" ");
      const rest = space > 0 ? title.slice(space + 1) : "";
      if (rest && /^[^\s]*[/.][^\s]*$/.test(rest.replace(/^`|`$/g, ""))) {
        const path = rest.replace(/^`|`$/g, "");
        const code = el("code", "cv-tool-code", shortPath(path));
        code.setAttribute("title", path);
        wrap.append(el("span", "cv-tool-verb", title.slice(0, space)), code);
      } else wrap.append(el("span", "cv-tool-verb", title));
      return wrap;
    }

    function statusBadge(item) {
      const key = item.awaiting ? "awaiting" : STATUS[item.status] ? item.status : "pending";
      const meta = key === "awaiting" ? { label: "Needs approval", icon: "lock" } : STATUS[key];
      const badge = el("span", `cv-tool-status is-${key}`);
      if (meta.icon) badge.append(icon(meta.icon));
      else badge.append(el("span", "cv-spin"));
      badge.append(el("span", "cv-tool-status-text", meta.label));
      return badge;
    }

    function outputBlock(item, text, index) {
      const lines = String(text).replace(/\n+$/, "").split("\n");
      const id = `${item.key}:${index}`;
      const wrap = el("div", "cv-output");
      const long = lines.length > OUTPUT_LINES + 2;
      const open = !long || expanded.has(id);
      const pre = el("pre", "cv-output-body", open ? lines.join("\n") : lines.slice(0, OUTPUT_LINES).join("\n"));
      pre.setAttribute("tabindex", "0");
      wrap.append(pre);
      if (long) {
        const more = el("button", "cv-more", open ? "Show less" : `Show all ${lines.length} lines`);
        more.setAttribute("type", "button");
        more.setAttribute("aria-expanded", String(open));
        more.addEventListener("click", () => {
          if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
          const fresh = outputBlock(item, text, index);
          wrap.replaceWith ? wrap.replaceWith(fresh) : null;
        });
        wrap.append(more);
      }
      return wrap;
    }

    function diffBlock(item, content, index) {
      const rows = unifiedDiff(content.oldText, content.newText);
      const added = rows.filter((r) => r.type === "add").length;
      const removed = rows.filter((r) => r.type === "del").length;
      const wrap = el("div", "cv-diff");
      const head = el("div", "cv-diff-head");
      const path = el("span", "cv-diff-path", shortPath(content.path || "file"));
      path.setAttribute("title", String(content.path || ""));
      const stats = el("span", "cv-diff-stats");
      stats.append(el("span", "cv-diff-add", `+${added}`), el("span", "cv-diff-del", `−${removed}`));
      if (content.oldText == null) head.append(el("span", "cv-diff-new", "New file"));
      head.prepend(path);
      head.append(stats);
      const body = el("div", "cv-diff-body");
      body.setAttribute("tabindex", "0");
      body.setAttribute("role", "group");
      body.setAttribute("aria-label", `Changes to ${content.path || "file"}: ${added} added, ${removed} removed`);
      const limit = expanded.has(`${item.key}:${index}`) ? rows.length : 80;
      for (const row of rows.slice(0, limit)) {
        const line = el("div", `cv-dl is-${row.type}`);
        if (row.type === "hunk") line.append(el("span", "cv-dl-hunk", row.text));
        else {
          line.append(
            el("span", "cv-dl-no", row.oldNo ?? ""),
            el("span", "cv-dl-no", row.newNo ?? ""),
            el("span", "cv-dl-sign", row.type === "add" ? "+" : row.type === "del" ? "−" : " "),
            el("span", "cv-dl-text", row.text),
          );
        }
        body.append(line);
      }
      wrap.append(head, body);
      if (rows.length > limit) {
        const more = el("button", "cv-more", `Show all ${rows.length} diff lines`);
        more.setAttribute("type", "button");
        more.addEventListener("click", () => { expanded.add(`${item.key}:${index}`); wrap.replaceWith?.(diffBlock(item, content, index)); });
        wrap.append(more);
      }
      return wrap;
    }

    function renderTool(item, node) {
      const status = item.awaiting ? "awaiting" : STATUS[item.status] ? item.status : "pending";
      const contents = Array.isArray(item.contents) ? item.contents : [];
      const expandable = !item.preview && (contents.length > 0 || item.input);
      const row = el(expandable ? "summary" : "div", "cv-tool-row");
      const kind = el("span", "cv-tool-kind");
      kind.append(icon(KIND_ICON[item.toolKind] || "other"));
      row.append(kind, toolTitle(item));
      if (item.target) {
        const target = el("code", "cv-tool-target", shortPath(item.target));
        target.setAttribute("title", item.target);
        row.append(target);
      }
      if (!item.preview) row.append(statusBadge(item));
      if (expandable) row.append(icon("chevron", "cv-icon cv-chevron"));

      if (!expandable) {
        node.className = `cv-tool is-${status}${item.preview ? " is-preview" : ""}`;
        node.replaceChildren(row);
        return node;
      }

      const body = el("div", "cv-tool-body");
      if (item.input) {
        const label = el("div", "cv-tool-label", item.toolKind === "execute" ? "Command" : "Input");
        const pre = el("pre", "cv-output-body cv-input", item.input);
        pre.setAttribute("tabindex", "0");
        body.append(label, pre);
      }
      let shownOutput = false;
      contents.forEach((content, index) => {
        if (content.type === "diff") body.append(diffBlock(item, content, index));
        else if (content.type === "terminal") body.append(el("p", "cv-tool-note", "Terminal output is not available in the chat."));
        else if (content.text) {
          if (!shownOutput) { body.append(el("div", "cv-tool-label", status === "failed" ? "Error" : "Output")); shownOutput = true; }
          body.append(outputBlock(item, content.text, index));
        }
      });
      node.className = `cv-tool is-${status}`;
      node.replaceChildren(row, body);
      return node;
    }

    function nodeFor(item) {
      const tag = item.kind === "thought" ? "details"
        : item.kind === "tool" ? (!item.preview && ((item.contents && item.contents.length) || item.input) ? "details" : "div")
        : item.kind === "plan" ? "section"
        : item.kind === "notice" ? "p" : "div";
      const node = el(tag);
      node.dataset.key = item.key;
      // Edits and failures start open so the change or the error is visible; long output inside stays collapsed.
      if (tag === "details" && item.kind === "tool" && (item.status === "failed" || (item.contents || []).some((c) => c.type === "diff"))) node.open = true;
      return node;
    }

    function fill(item, node) {
      switch (item.kind) {
        case "user": renderUser(item, node); return node;
        case "assistant": renderAssistant(item, node); return node;
        case "thought": renderThought(item, node); return node;
        case "plan": renderPlan(item, node); return node;
        case "tool": {
          // A row gains (or loses) its expandable detail as updates arrive: swap the element then.
          const wantsDetails = !!(!item.preview && ((item.contents && item.contents.length) || item.input));
          const isDetails = String(node.tagName || "").toLowerCase() === "details";
          return renderTool(item, wantsDetails === isDetails ? node : nodeFor(item));
        }
        default: renderNotice(item, node); return node;
      }
    }

    function setItems(items, options = {}) {
      const stick = atBottom || first;
      const before = list.children.length;
      let changed = false;
      const order = [];
      const keep = new Set();
      for (const item of items) {
        if (!item || typeof item.key !== "string") continue;
        keep.add(item.key);
        const known = nodes.get(item.key);
        let node = known?.node;
        if (!known || known.rev !== item.rev) {
          node = fill(item, node || nodeFor(item));
          nodes.set(item.key, { node, rev: item.rev });
          changed = true;
        }
        order.push(node);
      }
      for (const key of [...nodes.keys()]) if (!keep.has(key)) { nodes.delete(key); changed = true; }

      const current = list.children;
      let same = current.length === order.length;
      if (same) for (let i = 0; i < order.length; i++) if (current[i] !== order[i]) { same = false; break; }
      if (!same) {
        let prefix = current.length <= order.length;
        if (prefix) for (let i = 0; i < current.length; i++) if (current[i] !== order[i]) { prefix = false; break; }
        if (prefix) list.append(...order.slice(current.length));
        else list.replaceChildren(...order);
        changed = true;
      }

      const hasItems = order.length > 0;
      if (empty) empty.hidden = hasItems || !!options.loading;
      if (working) working.hidden = !options.working;
      list.setAttribute("aria-busy", options.working ? "true" : "false");
      if (changed || first) afterGrow(stick, order.length > before || changed);
      if (hasItems || !options.loading) first = false;
    }

    function setEmpty(title, body) {
      if (!empty) return;
      const t = empty.querySelector?.(".cv-empty-title");
      const b = empty.querySelector?.(".cv-empty-body");
      if (t) t.textContent = title; else empty.textContent = title;
      if (b) b.textContent = body || "";
    }

    function setLoading(on) {
      const skeleton = $("chat-loading");
      if (skeleton) skeleton.hidden = !on;
      if (on && empty) empty.hidden = true;
    }

    /* ---------- scrolling ---------- */

    const distance = () => main.scrollHeight - main.scrollTop - main.clientHeight;
    function toBottom(smooth) {
      if (smooth && main.scrollTo) main.scrollTo({ top: main.scrollHeight, behavior: reduceMotion() ? "auto" : "smooth" });
      else main.scrollTop = main.scrollHeight;
      atBottom = true;
      if (jump) jump.hidden = true;
    }
    function afterGrow(stick, grew) {
      if (stick) toBottom(false);
      else if (grew && jump) jump.hidden = false;
    }
    const reduceMotion = () => !!root.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    main.addEventListener("scroll", () => {
      atBottom = distance() < 72;
      if (atBottom && jump) jump.hidden = true;
    }, { passive: true });
    jump?.addEventListener("click", () => toBottom(true));
    // The dock grows (a permission card, a taller reply) and fonts load late: stay pinned if we were.
    if (typeof root.ResizeObserver === "function") {
      const observer = new root.ResizeObserver(() => { if (atBottom) main.scrollTop = main.scrollHeight; });
      observer.observe(main);
      observer.observe(list);
    }
    doc.fonts?.ready?.then(() => { if (atBottom) main.scrollTop = main.scrollHeight; });

    /* ---------- header ---------- */

    function setHeader({ name, agent, version, status, tone } = {}) {
      if (name !== undefined) $("chat-name").textContent = name;
      const chip = $("chat-agent");
      if (agent !== undefined && chip) {
        chip.hidden = !agent;
        chip.textContent = agent || "";
        if (version) chip.setAttribute("title", `${agent} ${version}`); else chip.removeAttribute?.("title");
      }
      if (status !== undefined) {
        const s = $("chat-status");
        s.dataset.tone = tone || "idle";
        $("chat-status-text").textContent = status;
      }
    }

    function setTerminal(visible) { const b = $("btn-chat-term"); if (b) b.hidden = !visible; }
    function setBanner(visible) { if (banner) banner.hidden = !visible; }

    /* ---------- composer ---------- */

    function syncComposer() {
      const showStop = composer.working && composer.canStop;
      stop.hidden = !showStop;
      send.hidden = showStop;
      stop.disabled = stopping;
      stop.setAttribute("aria-label", stopping ? "Stopping…" : "Stop the agent");
      const blocked = !composer.canSend || sending;
      send.disabled = blocked || !input.value.trim();
      input.disabled = !!composer.ended;
      input.setAttribute("aria-disabled", String(!composer.canSend));
      reason.textContent = composer.reason || "";
      reason.hidden = !composer.reason;
      $("chat-form").dataset.state = composer.ended ? "ended" : !composer.canSend ? "blocked" : composer.working ? "working" : "ready";
    }

    function setComposer(next) {
      composer = { ...composer, ...next };
      if (!composer.working) stopping = false;
      syncComposer();
    }

    function fit() {
      input.style.height = "auto";
      input.style.height = `${Math.min(input.scrollHeight || 0, 200)}px`;
    }

    function showError(message) {
      error.textContent = message || "";
      error.hidden = !message;
    }

    async function submit() {
      const text = input.value;
      if (!text.trim() || sending || !composer.canSend || (composer.working && composer.canStop)) return;
      sending = true;
      showError(null);
      syncComposer();
      try {
        await handlers.onSend?.(text);
        input.value = "";
        fit();
        toBottom(false);
      } catch (e) {
        showError(e?.message || "Couldn't send that.");
      } finally {
        sending = false;
        syncComposer();
      }
    }

    $("chat-form").addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    input.addEventListener("input", () => { fit(); syncComposer(); });
    // Enter sends; Shift+Enter adds a line; an IME composing a character keeps Enter for itself.
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing || e.keyCode === 229) return;
      e.preventDefault();
      submit();
    });
    stop.addEventListener("click", async () => {
      if (stopping) return;
      stopping = true;
      syncComposer();
      showError(null);
      try { await handlers.onStop?.(); } catch (e) { stopping = false; showError(e?.message || "Couldn't stop the agent."); syncComposer(); }
    });
    $("btn-chat-term")?.addEventListener("click", () => handlers.onTerminal?.());
    $("btn-chat-close")?.addEventListener("click", () => handlers.onClose?.());

    /* ---------- permission card ---------- */

    let shownPermission = null;
    function setPermission(request, state = {}) {
      if (!request) {
        permission.hidden = true;
        permission.replaceChildren();
        shownPermission = null;
        return;
      }
      const sig = `${request.requestId}|${state.busy || ""}|${state.error || ""}|${request.count || 1}`;
      if (shownPermission === sig) return;
      const fresh = !shownPermission || !shownPermission.startsWith(`${request.requestId}|`);
      shownPermission = sig;
      const head = el("div", "cv-perm-head");
      head.append(icon("lock", "cv-icon cv-perm-icon"));
      const copy = el("div", "cv-perm-copy");
      const heading = el("h2", "cv-perm-title", `${request.agent || "The agent"} wants to continue`);
      heading.id = "chat-permission-title";
      const what = el("p", "cv-perm-what");
      const tool = request.toolCall || {};
      what.append(icon(KIND_ICON[tool.kind] || "other"), el("span", "", String(tool.title || "Run a tool")));
      copy.append(heading, what);
      head.append(copy);
      if ((request.count || 1) > 1) head.append(el("span", "cv-perm-count", `1 of ${request.count}`));
      const actions = el("div", "cv-perm-actions");
      const options = Array.isArray(request.options) ? request.options : [];
      let firstButton = null;
      for (const option of options) {
        const kind = String(option.kind || "");
        const style = kind === "allow_once" ? "is-primary" : kind.startsWith("allow") ? "is-allow" : "is-reject";
        const b = el("button", `cv-perm-btn ${style}`, option.name || option.optionId);
        b.setAttribute("type", "button");
        b.disabled = !!state.busy;
        if (state.busy === option.optionId) b.dataset.busy = "true";
        b.addEventListener("click", () => handlers.onPermission?.(request.requestId, option.optionId));
        actions.append(b);
        firstButton ??= b;
      }
      const parts = [head, actions];
      if (state.error) parts.push(el("p", "cv-perm-error", state.error));
      permission.replaceChildren(...parts);
      permission.hidden = false;
      // Bring a new request to the keyboard user who was typing, without stealing from elsewhere.
      if (fresh && doc.activeElement === input && firstButton?.focus) firstButton.focus();
      if (atBottom) main.scrollTop = main.scrollHeight;
    }

    /* ---------- ended ---------- */

    function showGone(title, body, linkText) {
      main.hidden = true;
      $("chat-dock").hidden = true;
      setTerminal(false);
      if (title) $("chat-gone-title").textContent = title;
      if (body) $("chat-gone-body").textContent = body;
      if (linkText) $("chat-gone-link").textContent = linkText;
      $("chat-gone").hidden = false;
    }

    syncComposer();
    return { setItems, setEmpty, setLoading, setHeader, setTerminal, setBanner, setComposer, setPermission, showError, showGone, focus: () => input.focus?.() };
  }

  /* ---------- unified diff from old and new text ---------- */

  const linesOf = (text) => (text == null || text === "" ? [] : String(text).replace(/\n$/, "").split("\n"));

  function lineOps(a, b) {
    let pre = 0;
    while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    let suf = 0;
    while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
    const A = a.slice(pre, a.length - suf);
    const B = b.slice(pre, b.length - suf);
    const ops = [];
    for (let i = 0; i < pre; i++) ops.push({ op: "=", a: i, b: i });
    if (A.length * B.length > 4_000_000) {
      A.forEach((_, i) => ops.push({ op: "-", a: pre + i }));
      B.forEach((_, j) => ops.push({ op: "+", b: pre + j }));
    } else {
      const n = A.length, m = B.length, w = m + 1;
      const lcs = new Uint32Array((n + 1) * w);
      for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
        lcs[i * w + j] = A[i] === B[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
      }
      let i = 0, j = 0;
      while (i < n || j < m) {
        if (i < n && j < m && A[i] === B[j]) { ops.push({ op: "=", a: pre + i, b: pre + j }); i++; j++; }
        else if (j < m && (i >= n || lcs[i * w + j + 1] >= lcs[(i + 1) * w + j])) { ops.push({ op: "+", b: pre + j }); j++; }
        else { ops.push({ op: "-", a: pre + i }); i++; }
      }
    }
    for (let k = 0; k < suf; k++) ops.push({ op: "=", a: a.length - suf + k, b: b.length - suf + k });
    // Within each change, show removals before additions.
    for (let k = 0; k < ops.length; k++) {
      if (ops[k].op === "=") continue;
      let end = k;
      while (end < ops.length && ops[end].op !== "=") end++;
      const block = ops.slice(k, end);
      ops.splice(k, block.length, ...block.filter((o) => o.op === "-"), ...block.filter((o) => o.op === "+"));
      k = end;
    }
    return ops;
  }

  function unifiedDiff(oldText, newText) {
    const a = linesOf(oldText);
    const b = linesOf(newText);
    const ops = lineOps(a, b);
    const keep = new Array(ops.length).fill(false);
    ops.forEach((o, k) => {
      if (o.op === "=") return;
      for (let d = Math.max(0, k - DIFF_CONTEXT); d <= Math.min(ops.length - 1, k + DIFF_CONTEXT); d++) keep[d] = true;
    });
    const rows = [];
    let last = -1;
    ops.forEach((o, k) => {
      if (!keep[k]) return;
      if (k !== last + 1 || rows.length === 0) {
        const oldStart = (o.a ?? ops.slice(k).find((x) => x.a !== undefined)?.a ?? a.length) + 1;
        const newStart = (o.b ?? ops.slice(k).find((x) => x.b !== undefined)?.b ?? b.length) + 1;
        if (rows.length || k > 0) rows.push({ type: "hunk", text: `@@ −${oldStart} +${newStart} @@` });
      }
      if (o.op === "=") rows.push({ type: "ctx", text: a[o.a], oldNo: o.a + 1, newNo: o.b + 1 });
      else if (o.op === "-") rows.push({ type: "del", text: a[o.a], oldNo: o.a + 1 });
      else rows.push({ type: "add", text: b[o.b], newNo: o.b + 1 });
      last = k;
    });
    return rows;
  }

  root.ChatView = { create, unifiedDiff };
})(typeof window !== "undefined" ? window : globalThis);
