/* Terminal window — chrome around the ttyd iframe.
 *
 * Opened in its own tab by app.js. Closing it is a browser tab close and
 * nothing more: ttyd gets SIGHUP, screen detaches, and whatever is running on
 * the server keeps running. Nothing here ends a session.
 *
 * The iframe is same-origin, so ttyd's `window.term` (xterm.js) is reachable —
 * that's how the key row types and how we re-fit when the soft keyboard
 * changes the viewport.
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const id = params.get("id") ?? "";
  const name = params.get("name") ?? "Terminal";

  const frame = $("term-frame");
  const keys = $("term-keys");

  $("term-name").textContent = name;

  // ⇞ enters screen's copy mode (Ctrl-A [) by default. A zmx session has no
  // copy mode — its scrollback reaches the browser as-is, and Claude's
  // fullscreen view scrolls itself — so there the key sends Page Up instead;
  // Ctrl-A [ would type a literal "[" into the prompt.
  if (params.get("mux") === "zmx") {
    const scrollKey = keys.querySelector(".key-scroll");
    if (scrollKey) {
      scrollKey.dataset.seq = "\x1b[5~";
      scrollKey.title = "Page up — scrolls Claude's conversation (Page Down: Ctrl+End jumps back)";
    }
  }
  document.title = `${name} — Terminal`;

  if (!/^[a-z0-9]{4,32}$/i.test(id)) { showGone(); return; }
  frame.src = `/term/${encodeURIComponent(id)}/`;

  /* ---------- talking to xterm.js inside the iframe ---------- */

  function termApi() {
    try { return frame.contentWindow.term ?? null; } catch { return null; }
  }

  // `input()` goes straight to the pty. `paste()` is the fallback, but under
  // bracketed-paste mode it would wrap escape sequences in \e[200~…\e[201~ and
  // the app would read them as literal text, so it is genuinely a last resort.
  function send(seq) {
    const t = termApi();
    if (!t) return;
    try {
      if (typeof t.input === "function") t.input(seq);
      else if (typeof t.paste === "function") t.paste(seq);
      t.focus?.();
    } catch {}
  }

  function refit() {
    const t = termApi();
    try { t?.fit?.(); } catch {}
  }

  /**
   * iOS: tapping the terminal can raise the keyboard without the terminal ever
   * taking focus, so what you type goes nowhere. xterm focuses its helper
   * textarea from a mousedown, which on a phone is a *synthesised* event rather
   * than the real gesture; re-asserting focus from the genuine touchend is the
   * standard workaround.
   *
   * Unconfirmed against a real device — it does not reproduce in Chromium's
   * touch emulation (tap focuses correctly there, and neither a viewport resize
   * nor fit() drops focus), so this is a mitigation, not a diagnosed fix. It is
   * a no-op wherever focus already worked. Skipped mid-selection so that
   * selecting text to copy still behaves.
   */
  function armTapFocus(t) {
    const doc = (() => { try { return frame.contentDocument; } catch { return null; } })();
    if (!doc) return;
    doc.addEventListener("touchend", () => {
      if (doc.getSelection?.()?.toString()) return;
      try { t.focus(); } catch {}
    }, { passive: true });
  }

  // ?focusdebug=1 — read focus state on the actual phone, since it can't be
  // reproduced here. Remove once the iOS behaviour is pinned down.
  if (new URLSearchParams(location.search).has("focusdebug")) {
    const tag = document.createElement("div");
    tag.style.cssText = "position:fixed;left:8px;bottom:96px;z-index:9;font:11px ui-monospace,monospace;" +
      "background:rgba(0,0,0,.75);color:#6FD49B;padding:6px 8px;border-radius:8px;pointer-events:none;max-width:90vw";
    document.body.appendChild(tag);
    setInterval(() => {
      let inner = "no frame", vv = "";
      try {
        const d = frame.contentDocument;
        const ae = d.activeElement;
        inner = (ae ? ae.tagName + "." + (ae.className || "").split(" ")[0] : "none") + (d.hasFocus() ? " hasFocus" : " NOfocus");
      } catch {}
      if (window.visualViewport) vv = ` vv=${Math.round(window.visualViewport.height)}`;
      tag.textContent = `outer=${document.activeElement?.tagName} inner=${inner}${vv}`;
    }, 400);
  }

  /* ---------- keys the soft keyboard doesn't have ---------- */

  // Fire on pointerdown, not click: preventDefault() here stops the tap from
  // stealing focus (which would dismiss the soft keyboard — exactly wrong after
  // pressing esc mid-prompt), but it also suppresses the compatibility click
  // event on touch, so the key has to be sent from this handler.
  keys.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(".key");
    if (!btn) return;
    e.preventDefault();
    if (btn.dataset.seq) send(btn.dataset.seq);
    else termApi()?.focus?.();
  });

  // Keyboard activation (Enter/Space on a focused key) reports detail === 0 and
  // never produces a pointerdown, so it needs its own path.
  keys.addEventListener("click", (e) => {
    if (e.detail !== 0) return;
    const btn = e.target.closest(".key");
    if (!btn) return;
    if (btn.dataset.seq) send(btn.dataset.seq);
    else termApi()?.focus?.();
  });

  $("btn-term-keys").addEventListener("click", (e) => {
    const on = keys.hasAttribute("hidden");
    keys.toggleAttribute("hidden", !on);
    e.currentTarget.setAttribute("aria-pressed", String(on));
    setTimeout(refit, 60);
  });

  /* ---------- share ---------- */

  // Hand this terminal to another device. The link is only useful to someone who
  // can already get past Cloudflare Access and the app's own auth — it carries no
  // credential of its own — so in practice it's "open this on my laptop".
  // The bridge id is per-terminal: once it's gone the link lands on the closed
  // state below rather than someone else's session.
  const share = $("btn-term-share");
  share.addEventListener("click", async () => {
    const url = location.href;
    const flash = (label) => {
      share.textContent = label;
      setTimeout(() => { share.textContent = "Share"; }, 1600);
    };
    try {
      if (navigator.share) {
        await navigator.share({ title: `${name} — Terminal`, url });
        return; // the sheet is its own confirmation
      }
      await navigator.clipboard.writeText(url);
      flash("Copied");
    } catch (e) {
      if (e?.name === "AbortError") return; // the share sheet was dismissed
      // Clipboard API needs a secure context and can still be blocked — fall
      // back to the old execCommand path before admitting defeat.
      try {
        const ta = document.createElement("textarea");
        ta.value = url;
        ta.setAttribute("readonly", "");
        ta.style.cssText = "position:fixed;top:-1000px";
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand("copy");
        ta.remove();
        flash(ok ? "Copied" : "Copy failed");
      } catch {
        flash("Copy failed");
      }
    }
  });

  /* ---------- close ---------- */

  $("btn-term-close").addEventListener("click", () => {
    window.close();
    // close() is a no-op unless this tab was script-opened (deep link, PWA,
    // restored tab) — fall back to walking back into the app.
    setTimeout(() => { if (!window.closed) location.replace("/"); }, 150);
  });

  /* ---------- fitting ---------- */

  /* ---------- resume ---------- */

  // The bridge id in this URL is per-terminal and short-lived: the idle reaper or
  // a server restart kills it while the screen session it fronted keeps running.
  // A shared or bookmarked link would then dead-end on "closed" even though the
  // thing it points at is alive. The screen name is already in the URL, so ask
  // for a fresh bridge to it instead of giving up. `r=1` stops a bridge that
  // dies immediately from redirecting in a loop.
  const alreadyResumed = params.get("r") === "1";

  async function resumeBridge() {
    // Server-shell terminals are labelled "Server shell" and live in their own
    // ephemeral session — there is no cs-* session to reattach to. The name
    // pattern (no spaces) rejects them, matching the server's own validation.
    if (alreadyResumed || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,60}$/.test(name)) return { resumed: false };
    try {
      const res = await fetch("/api/terminal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ kind: "attach", screen: `cs-${name}` }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.id) return { resumed: false, error: data.error };
      location.replace(`/term.html?id=${encodeURIComponent(data.id)}&name=${encodeURIComponent(name)}&mux=${encodeURIComponent(data.mux ?? "screen")}&r=1`);
      return { resumed: true };
    } catch {
      return { resumed: false };
    }
  }

  // Reattach if the session is still there; otherwise say what actually happened
  // instead of the default "the session keeps running", which would be a lie.
  function resumeOrGone() {
    resumeBridge().then(({ resumed, error }) => {
      if (resumed) return;
      if (error) showGone("This terminal has closed.", `${error} Start a new session from the app.`);
      else showGone();
    });
  }

  frame.addEventListener("load", () => {
    const doc = (() => { try { return frame.contentDocument; } catch { return null; } })();
    if (doc && /No such terminal/i.test(doc.body?.textContent ?? "")) { resumeOrGone(); return; }

    // An expired cookie doesn't 401 here — /term/<id>/ redirects to "/", so the
    // whole app (login screen and all) would render inside the terminal frame.
    if (doc && (doc.getElementById("login") || doc.getElementById("app"))) { showSignedOut(); return; }

    // `load` fires before ttyd has constructed its Terminal, so window.term is
    // still undefined here — poll for it rather than configuring nothing.
    let tries = 0;
    const wait = setInterval(() => {
      const t = termApi();
      // 10s with no Terminal and no ttyd page: something served us something
      // else. Say so rather than leaving a blank frame.
      if (!t) { if (++tries > 100) { clearInterval(wait); resumeOrGone(); } return; }
      clearInterval(wait);
      // ttyd's default 13px gives ~48 columns on a phone; Claude's TUI needs more.
      if (window.innerWidth < 520) { try { t.options.fontSize = 11; } catch {} }
      refit();
      armTapFocus(t);
    }, 100);
  });

  /* ---------- soft keyboard ---------- */

  // A phone keyboard shrinks the *visual* viewport but usually leaves the layout
  // viewport at full height, so a 100dvh page keeps its size and its bottom rows
  // — the cursor line, and the key row — end up behind the keyboard. Android
  // Chrome takes the `interactive-widget` hint in term.html; iOS ignores it, and
  // neither is worth trusting alone, so drive the height from visualViewport too.
  const vv = window.visualViewport;
  let pending = false;

  function syncViewport() {
    pending = false;
    let height = "";
    if (vv) {
      // Only take over while something is actually covering the page. A small
      // delta is just browser chrome collapsing, and overriding for that would
      // fight the CSS on every scroll.
      const covered = window.innerHeight - vv.height;
      if (covered > 120) height = `${vv.height}px`;
    }
    document.documentElement.style.setProperty("--term-vh", height);
    refit();
  }

  // visualViewport fires a burst of events per keyboard animation frame.
  function queueSync() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(syncViewport);
  }

  window.addEventListener("resize", queueSync);
  vv?.addEventListener("resize", queueSync);
  vv?.addEventListener("scroll", queueSync);
  window.addEventListener("orientationchange", () => setTimeout(queueSync, 250));

  function showGone(title, body) {
    frame.hidden = true;
    keys.hidden = true;
    // Nothing is live any more: stop the pulsing dot claiming otherwise, and
    // drop the controls that now act on nothing. Close still gets you out.
    // by id, not the `share` binding above: showGone() also runs for a bad id
    // before that const is initialised, and touching it there would throw.
    document.querySelector(".term-live").hidden = true;
    $("btn-term-share").hidden = true;
    $("btn-term-keys").hidden = true;
    if (title) $("term-gone-title").textContent = title;
    if (body) $("term-gone-body").textContent = body;
    $("term-gone").hidden = false;
  }

  function showSignedOut() {
    showGone("You're signed out.", "Sign in again, then reopen the terminal from the app. Whatever was running is untouched.");
    $("term-gone-link").textContent = "Sign in";
  }
})();
