/* Command palette (Cmd+K / Ctrl+K): searches every setting, a few actions and the sessions.
 *
 * The index is read from the page, not from a list kept here, so a new setting shows up
 * by itself. CONTRIBUTING.md ("Settings search") documents the markup it reads:
 *   - a settings page is a `.sheet` with data-settings="<id of the Settings row that opens it>"
 *     (the Settings sheet itself names the topbar button);
 *   - inside it, every visible field (input, select, textarea), Settings row (.row-btn),
 *     list row (.proj-row), section heading (h3) and `.label` heading is an entry, labelled
 *     by its <label>, aria-label or first line, described by the hint next to it;
 *   - data-search="words" adds synonyms to an element (on a sheet: to all its entries);
 *   - data-search-skip leaves an element and everything inside it out;
 *   - data-command="Label" on any other button makes it an action that clicks it, and on a
 *     <select> one action per option.
 * Dynamic rows (agents, connectors, secret names, commands, tokens, projects) are indexed
 * from what their sheet renders; the app passes loaders that render them before a search.
 * Secret values never reach the page, so they can't reach the index. */
(() => {
  const normalize = (value) => String(value ?? "").toLowerCase().normalize("NFKD")
    .replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9@./+-]+/g, " ").trim();
  const clean = (value) => String(value ?? "").replace(/\s+/g, " ").replace(/\s*…$/, "").trim();
  const textOf = (node) => clean(node?.textContent);

  /* ---------- matching ---------- */

  /** How well one query word matches one field: 0 (not at all) to 100 (the whole field). */
  function fuzzy(token, field) {
    if (!token || !field) return 0;
    if (field === token) return 100;
    if (field.startsWith(token)) return 90;
    const at = field.indexOf(token);
    if (at > 0 && /[^a-z0-9]/.test(field[at - 1])) return 80;
    if (at > 0) return 60;
    if (token.length < 3) return 0;
    // In order, possibly with gaps ("pskey" → "passkey"): the tighter, the better.
    let from = 0, start = -1;
    for (const ch of token) {
      const i = field.indexOf(ch, from);
      if (i < 0) return 0;
      if (start < 0) start = i;
      from = i + 1;
    }
    const span = from - start;
    if (span > token.length * 2.5) return 0;
    return Math.round(20 + 25 * (token.length / span));
  }

  const WEIGHTS = { label: 1, keywords: 0.85, section: 0.55, desc: 0.5 };
  const KIND_BONUS = { setting: 30, action: 8, session: 0 };

  /** An item's score for a query, 0 when some word matches nothing. Settings rank first. */
  function scoreItem(item, query) {
    const tokens = normalize(query).split(" ").filter(Boolean);
    if (!tokens.length) return 0;
    const fields = item._norm ??= {
      label: normalize(item.label), keywords: normalize(item.keywords),
      section: normalize(item.section), desc: normalize(item.desc),
    };
    let total = 0;
    for (const token of tokens) {
      let best = 0;
      for (const [name, weight] of Object.entries(WEIGHTS)) {
        const words = name === "label" ? [fields.label] : fields[name].split(" ");
        let s = name === "label" ? fuzzy(token, fields.label) : 0;
        if (name !== "label") for (const word of [fields[name], ...words]) s = Math.max(s, fuzzy(token, word));
        best = Math.max(best, s * weight);
      }
      if (!best) return 0;
      total += best;
    }
    // The whole query as one phrase in the name beats words scattered over the details.
    const phrase = tokens.join(" ");
    const whole = fields.label === phrase ? 60 : tokens.length > 1 && fields.label.includes(phrase) ? 40 : 0;
    return total / tokens.length + whole + (KIND_BONUS[item.kind] ?? 0) + (item.kind === "setting" && item.page ? 2 : 0);
  }

  /** The items matching query, best first. An empty query lists recent ones, then settings pages. */
  function rank(items, query, { limit = 50, recent = [] } = {}) {
    if (!normalize(query)) {
      const byId = new Map(items.map((item) => [item.id, item]));
      const seen = new Set();
      const out = [];
      for (const id of recent) if (byId.has(id) && !seen.has(id)) { seen.add(id); out.push({ ...byId.get(id), recent: true }); }
      for (const item of items) if (item.page && !seen.has(item.id)) { seen.add(item.id); out.push(item); }
      return out.slice(0, limit);
    }
    return items.map((item, order) => ({ item, order, score: scoreItem(item, query) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.order - b.order)
      .slice(0, limit)
      .map((r) => r.item);
  }

  /** The next active index for a key, wrapping around. */
  function moveActive(index, key, count) {
    if (!count) return -1;
    if (key === "ArrowDown") return (index + 1) % count;
    if (key === "ArrowUp") return index <= 0 ? count - 1 : index - 1;
    if (key === "Home") return 0;
    if (key === "End") return count - 1;
    return index;
  }

  /* ---------- the shortcut ---------- */

  const isMac = (navigator) => /mac|iphone|ipad|ipod/i.test(navigator?.userAgentData?.platform || navigator?.platform || navigator?.userAgent || "");

  /** Whether a keydown opens the palette. Cmd+K on a Mac, Ctrl+K elsewhere. Ctrl+K on a Mac
   *  also works, except in a text field, where it is the system's delete-to-end-of-line.
   *  Never inside a terminal, a multi-line or rich editor (which may bind Cmd+K itself), or
   *  anything marked data-own-cmdk. */
  function isPaletteShortcut(event, { mac = false } = {}) {
    if (event.defaultPrevented || event.altKey || event.shiftKey || String(event.key).toLowerCase() !== "k") return false;
    const cmd = event.metaKey && !event.ctrlKey;
    const ctrl = event.ctrlKey && !event.metaKey;
    if (!cmd && !ctrl) return false;
    if (!mac && !ctrl) return false;
    const target = event.target;
    for (let n = target; n && n.nodeType === 1; n = n.parentNode) {
      if (n.hasAttribute?.("data-own-cmdk") || n.classList?.contains("xterm")) return false;
    }
    const tag = target?.localName;
    if (tag === "textarea" || target?.isContentEditable) return false;
    if (mac && ctrl && (tag === "input" || tag === "select")) return false;
    return true;
  }

  /* ---------- reading the page ---------- */

  function* walk(el) {
    for (const child of el.children) { yield child; yield* walk(child); }
  }
  const up = (el, stop, test) => {
    for (let n = el; n && n !== stop; n = n.parentNode) if (test(n)) return n;
    return null;
  };
  const is = (el, selector) => !!el.matches?.(selector);
  const ownText = (el) => clean(el.childNodes ? [...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join(" ") : "");

  /** The words of an element and its ancestors' data-search, up to the sheet. */
  function keywordsOf(el, sheet) {
    const words = [];
    for (let n = el; n; n = n.parentNode) {
      if (n.dataset?.search) words.push(n.dataset.search);
      if (n === sheet) break;
    }
    return words.join(" ");
  }

  /** A label's visible name and the detail line after it (provider cards have both). */
  function splitLabel(label) {
    const parts = [...label.children].filter((c) => !is(c, "input") && c.getAttribute("aria-hidden") !== "true" && textOf(c));
    if (!parts.length) return [ownText(label) || textOf(label), ""];
    const first = parts[0];
    const inner = [...first.children].filter((c) => textOf(c));
    if (inner.length > 1) return [textOf(inner[0]), inner.slice(1).map(textOf).join(" ")];
    return [ownText(label) || textOf(first), parts.slice(1).map(textOf).join(" ")];
  }

  function hintAfter(el) {
    for (let n = el.nextElementSibling ?? nextSibling(el); n; n = n.nextElementSibling ?? nextSibling(n)) {
      if (is(n, ".hint, .provider-note")) return textOf(n);
      if (is(n, "input, select, textarea, label, button, .row-btn, h3")) return "";
    }
    return "";
  }
  function nextSibling(el) {
    const siblings = el.parentNode?.children;
    if (!siblings) return null;
    return siblings[[...siblings].indexOf(el) + 1] ?? null;
  }

  function controlEntry(el, sheet) {
    if (is(el, "input[type=hidden], input[type=submit], input[type=button]")) return null;
    const wrapping = up(el.parentNode, sheet, (n) => n.localName === "label");
    const forLabel = el.id ? [...sheet.querySelectorAll("label")].find((l) => l.getAttribute("for") === el.id || l.htmlFor === el.id) : null;
    let label = "", desc = "";
    if (wrapping) [label, desc] = splitLabel(wrapping);
    if (!label && forLabel) label = textOf(forLabel);
    if (!label) label = clean(el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
    if (!label) return null;
    const anchor = wrapping || (forLabel && forLabel.parentNode === el.parentNode ? el : el);
    desc = desc || hintAfter(anchor);
    const options = el.localName === "select" ? [...el.querySelectorAll("option")].map(textOf).join(" ") : "";
    return { label, desc, extra: options };
  }

  function rowEntry(el) {
    if (is(el, ".row-btn")) {
      const first = [...el.children].find((c) => !is(c, ".connection-status, .connection-detail") && textOf(c));
      const label = first ? textOf(first) : ownText(el);
      const detail = el.querySelector(".connection-detail");
      return label ? { label, desc: detail ? textOf(detail) : "" } : null;
    }
    // .proj-row: the name, then its smaller lines.
    const first = el.children[0];
    if (!first) return null;
    const label = ownText(first) || textOf(first.children?.[0] ?? first);
    const desc = [...el.querySelectorAll(".pick-path"), ...el.querySelectorAll(".proj-note")].map(textOf).join(" · ");
    return label ? { label, desc } : null;
  }

  /** Every setting on the page, with where it lives. */
  function collectSettings(document) {
    const items = [];
    const seen = new Set();
    for (const sheet of document.querySelectorAll(".sheet")) {
      if (!sheet.dataset?.settings || sheet.hasAttribute("data-search-skip")) continue;
      const title = textOf(sheet.querySelector(".sheet-title"));
      const menu = sheet.dataset.settings === "btn-menu";
      const page = menu ? "Settings" : title;
      const pageBody = sheet.querySelector(".sheet-body");
      const add = (entry) => {
        if (seen.has(entry.id)) return;
        seen.add(entry.id);
        items.push(entry);
      };
      add({
        id: `setting:${sheet.id}`, kind: "setting", page: true, sheet: sheet.id,
        label: page, section: menu ? "" : "Settings", desc: textOf(pageBody), keywords: keywordsOf(sheet, sheet), locate: null,
      });
      let heading = "";
      for (const el of walk(sheet)) {
        if (up(el, sheet, (n) => n.hidden || n.hasAttribute?.("data-search-skip") || is(n, ".sheet-close, .sheet-back, [data-close]"))) continue;
        let entry = null;
        if (el.localName === "h3") { heading = textOf(el); entry = { label: heading, desc: "" }; }
        else if (is(el, "input, select, textarea")) {
          if (up(el.parentNode, sheet, (n) => is(n, ".row-btn, .proj-row"))) continue;
          entry = controlEntry(el, sheet);
        } else if (is(el, ".row-btn, .proj-row")) entry = rowEntry(el);
        else if (is(el, "label.label") && !el.getAttribute("for")) entry = { label: textOf(el), desc: hintAfter(el) };
        if (!entry?.label) continue;
        const section = [page === "Settings" ? "Settings" : `Settings › ${page}`, el.localName === "h3" ? "" : heading].filter(Boolean).join(" › ");
        add({
          id: `setting:${sheet.id}:${el.id || normalize(entry.label)}`,
          kind: "setting", sheet: sheet.id, label: entry.label, section, desc: entry.desc,
          keywords: [keywordsOf(el, sheet), entry.extra].filter(Boolean).join(" "),
          locate: el.id ? { id: el.id } : { label: entry.label },
        });
      }
    }
    return items;
  }

  /** Actions from data-command: a button is clicked, a select gets one action per option. */
  function collectActions(document) {
    const items = [];
    for (const el of document.querySelectorAll("[data-command]")) {
      const name = el.dataset.command;
      // A button already indexed as a setting stays one entry (its option actions still count).
      if (el.localName !== "select" && up(el, null, (n) => is(n, ".sheet") && !!n.dataset?.settings)) continue;
      if (el.localName === "select") {
        for (const option of el.querySelectorAll("option")) {
          items.push({
            id: `action:${el.id}:${option.value}`, kind: "action", label: `${name}: ${textOf(option)}`, section: "Action",
            desc: "", keywords: el.dataset.search || "",
            run: () => { el.value = option.value; el.dispatchEvent(new Event("change", { bubbles: true })); },
          });
        }
      } else {
        items.push({
          id: `action:${el.id || normalize(name)}`, kind: "action", label: name, section: "Action",
          desc: el.dataset.commandDetail || "", keywords: el.dataset.search || "", run: () => el.click(),
        });
      }
    }
    return items;
  }

  /** The element an item points at now (dynamic rows are re-rendered, so by label too). */
  function locate(document, item) {
    const sheet = document.getElementById(item.sheet);
    if (!sheet) return null;
    if (!item.locate) return sheet;
    if (item.locate.id) return document.getElementById(item.locate.id);
    const match = collectSettings(document).find((other) => other.sheet === item.sheet && other.label === item.locate.label && other.locate?.id);
    if (match) return document.getElementById(match.locate.id);
    for (const el of walk(sheet)) {
      if (!is(el, ".row-btn, .proj-row, h3, label, .server-setting")) continue;
      const entry = is(el, ".row-btn, .proj-row") ? rowEntry(el) : { label: textOf(el) };
      if (entry?.label === item.locate.label) return el;
    }
    return null;
  }

  /* ---------- the dialog ---------- */

  const RECENT_KEY = "cs.palette.recent";
  const FOCUSABLE = "button, a[href], input, select, textarea, [tabindex]";

  function create({ document, window, canOpen = () => true, getSessions = () => [], openSession = () => {}, openSheetEl = () => null, closeSheet = () => {}, preload = [] }) {
    const $ = (id) => document.getElementById(id);
    const root = $("palette");
    const input = $("palette-input");
    const list = $("palette-list");
    const status = $("palette-status");
    const mac = isMac(window.navigator);
    let items = [];
    let shown = [];
    let active = -1;
    let returnFocus = null;
    let preloading = null;
    let preloadedAt = 0;

    const readRecent = () => { try { return JSON.parse(window.localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } };
    const remember = (id) => {
      try { window.localStorage.setItem(RECENT_KEY, JSON.stringify([id, ...readRecent().filter((r) => r !== id)].slice(0, 6))); } catch {}
    };

    function sessionItems() {
      return getSessions().map((s) => ({
        id: `session:${s.id}`, kind: "session", label: s.name, section: s.archived ? "Ended session" : "Session",
        desc: [s.project, s.provider, s.status].filter(Boolean).join(" · "), keywords: "session open jump",
        run: () => openSession(s.id),
      }));
    }

    function rebuild() {
      items = [...collectSettings(document), ...collectActions(document), ...sessionItems()];
    }

    function render() {
      shown = rank(items, input.value, { recent: readRecent(), limit: 60 });
      active = shown.length ? 0 : -1;
      list.replaceChildren();
      let lastGroup = "";
      shown.forEach((item, i) => {
        const group = item.recent ? "Recent" : !normalize(input.value) ? "Settings" : { setting: "Settings", action: "Actions", session: "Sessions" }[item.kind];
        if (group !== lastGroup) {
          const head = document.createElement("li");
          head.className = "palette-group";
          head.setAttribute("role", "presentation");
          head.textContent = group;
          list.append(head);
          lastGroup = group;
        }
        const li = document.createElement("li");
        li.id = `palette-option-${i}`;
        li.className = "palette-option";
        li.setAttribute("role", "option");
        li.dataset.index = String(i);
        const label = document.createElement("span");
        label.className = "palette-label";
        label.textContent = item.label;
        const where = document.createElement("span");
        where.className = "palette-where";
        where.textContent = [item.section, item.desc].filter(Boolean).join(" — ");
        li.append(label, where);
        li.addEventListener("click", () => choose(i));
        li.addEventListener("mousemove", () => { if (active !== i) setActive(i, false); });
        list.append(li);
      });
      setActive(active);
      status.textContent = normalize(input.value)
        ? (shown.length ? `${shown.length} result${shown.length === 1 ? "" : "s"}` : "No matches")
        : "";
    }

    function setActive(i, scroll = true) {
      active = i;
      for (const li of list.querySelectorAll(".palette-option")) {
        const on = Number(li.dataset.index) === i;
        li.setAttribute("aria-selected", on ? "true" : "false");
        li.classList.toggle("active", on);
        if (on && scroll) li.scrollIntoView?.({ block: "nearest" });
      }
      if (i >= 0) input.setAttribute("aria-activedescendant", `palette-option-${i}`);
      else input.removeAttribute("aria-activedescendant");
    }

    function runPreload() {
      if (preloading || Date.now() - preloadedAt < 30_000) return;
      preloading = Promise.allSettled(preload.map((load) => Promise.resolve().then(load))).then(() => {
        preloading = null;
        preloadedAt = Date.now();
        if (!root.hidden) { const value = input.value; rebuild(); input.value = value; render(); }
      });
    }

    function open() {
      if (!root.hidden) { input.focus(); input.select?.(); return; }
      if (!canOpen()) return;
      returnFocus = document.activeElement;
      rebuild();
      root.hidden = false;
      input.value = "";
      input.setAttribute("aria-expanded", "true");
      render();
      input.focus();
      runPreload();
    }

    function close({ restore = true } = {}) {
      if (root.hidden) return;
      root.hidden = true;
      input.setAttribute("aria-expanded", "false");
      if (restore && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
      returnFocus = null;
    }

    async function choose(i) {
      const item = shown[i];
      if (!item) return;
      remember(item.id);
      close({ restore: false });
      if (item.run) {
        if (openSheetEl() && item.kind === "session") closeSheet();
        item.run();
        return;
      }
      await goTo(item);
    }

    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    /** Opens Settings at an item's page, then scrolls to, highlights and focuses it. */
    async function goTo(item) {
      const sheet = $(item.sheet);
      const current = openSheetEl();
      if (current !== sheet) {
        if (current) { closeSheet(); await wait(320); }
        $("btn-menu").click();
        if (item.sheet !== "sheet-menu") {
          await wait(30);
          $(sheet.dataset.settings)?.click();
        }
      }
      let target = null;
      for (let t = 0; t < 60; t++) {
        await wait(50);
        target = locate(document, item);
        if (target && sheet.classList.contains("show") && target.getClientRects().length) break;
      }
      if (!target) return;
      await wait(60); // after the sheet focuses itself
      reveal(target);
    }

    function reveal(el) {
      const box = up(el, null, (n) => is(n, ".server-setting, .ws-row, .appearance-setting, .menu-group, .proj-row, .row-btn, .provider-pick")) || el;
      const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      box.scrollIntoView?.({ block: "center", behavior: reduced ? "auto" : "smooth" });
      box.classList.remove("palette-flash");
      void box.offsetWidth;
      box.classList.add("palette-flash");
      window.setTimeout(() => box.classList.remove("palette-flash"), 2000);
      let focus = is(el, FOCUSABLE) && !el.disabled ? el : [...el.querySelectorAll(FOCUSABLE)].find((n) => !n.disabled && n.getClientRects().length);
      if (!focus) {
        if (!el.hasAttribute("tabindex")) el.setAttribute("tabindex", "-1");
        focus = el;
      }
      focus.focus({ preventScroll: true });
    }

    input.addEventListener("input", render);
    root.addEventListener("keydown", (event) => {
      event.stopPropagation(); // the sheets' own Escape and focus trap stay out of it
      if (event.key === "Escape") { event.preventDefault(); close(); return; }
      if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); choose(active); return; }
      if (["ArrowDown", "ArrowUp"].includes(event.key) || ((event.key === "Home" || event.key === "End") && event.ctrlKey)) {
        event.preventDefault();
        setActive(moveActive(active, event.key, shown.length));
        return;
      }
      if (event.key === "Tab") { event.preventDefault(); input.focus(); }
      if (isPaletteShortcut(event, { mac }) || (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))) { event.preventDefault(); close(); }
    });
    root.addEventListener("mousedown", (event) => { if (event.target === root) { event.preventDefault(); close(); } });
    root.querySelector("[data-palette-close]")?.addEventListener("click", () => close());
    document.addEventListener("keydown", (event) => {
      if (!isPaletteShortcut(event, { mac })) return;
      event.preventDefault();
      open();
    });
    $("btn-palette")?.addEventListener("click", open);
    const hint = $("palette-shortcut");
    if (hint) hint.textContent = mac ? "⌘K" : "Ctrl+K";

    return { open, close, isOpen: () => !root.hidden, items: () => items, rebuild };
  }

  window.CommandPalette = { normalize, fuzzy, scoreItem, rank, moveActive, isPaletteShortcut, collectSettings, collectActions, locate, create };
})();
