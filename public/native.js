/* NativeShell: the small things that make the installed app behave like one on a
 * phone — no zoom, swipe and back gestures, the keyboard, coming back from another
 * app. Loaded right after theme.js on every page. The decisions are pure functions
 * (tested in server/native-shell.test.js); the installers at the bottom wire them
 * to the page and run only where there is a document. */
(() => {
  const NS = {};

  /* ---------- pure decisions ---------- */

  /** Running as an installed app (home-screen icon), not in a browser tab. */
  NS.isStandalone = (win) => {
    try {
      if (win.navigator?.standalone === true) return true; // iOS Safari
      return ["standalone", "fullscreen", "minimal-ui"].some((mode) => win.matchMedia?.(`(display-mode: ${mode})`).matches);
    } catch { return false; }
  };

  /** iOS Safari in a tab, where Add to Home Screen is the only way to install. */
  NS.isIosSafari = (ua, maxTouchPoints = 0) => {
    const ios = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && maxTouchPoints > 1);
    return ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
  };

  // Where a double tap must keep working: controls, form fields, and content a
  // person may want to select (chat messages, code, paths).
  NS.DOUBLE_TAP_ALLOWED = "a,button,input,textarea,select,label,summary,[role=button],[role=link],[contenteditable],.md,.cv-list,pre,code,.selectable,.xterm";
  const DOUBLE_TAP_MS = 300;
  const DOUBLE_TAP_PX = 24;

  /** A second tap that would zoom: quick, close to the first, and not on anything that needs it. */
  NS.blocksDoubleTap = ({ gapMs, distance, allowed }) => !allowed && gapMs >= 0 && gapMs < DOUBLE_TAP_MS && distance < DOUBLE_TAP_PX;

  // Pull to refresh: the indicator follows the finger at half speed, stops at
  // PULL_MAX, and a release past PULL_TRIGGER refreshes.
  NS.PULL_TRIGGER = 64;
  NS.PULL_MAX = 96;
  NS.pullDistance = (raw) => (raw > 0 ? Math.min(NS.PULL_MAX, raw * 0.5) : 0);
  NS.pullTriggered = (distance) => distance >= NS.PULL_TRIGGER;

  /** A sheet dragged down far enough, or flicked down fast enough, closes. */
  NS.sheetShouldDismiss = ({ dy, velocity, height }) => dy > 0 && (dy > height * 0.25 || (velocity > 0.5 && dy > 24));

  /** The height the page should take while a soft keyboard covers part of it, or null. */
  NS.keyboardViewport = ({ innerHeight, vvHeight }) => {
    if (!(vvHeight > 0)) return null;
    // A small difference is browser chrome collapsing, not a keyboard.
    return innerHeight - vvHeight > 120 ? Math.round(vvHeight) : null;
  };

  /** Enter sends from a hardware keyboard; with an on-screen keyboard up it starts a new line. */
  NS.enterSends = ({ softKeyboard, shift, composing }) => !shift && !composing && !softKeyboard;

  /** Which install hint, if any: "prompt" (Android's install dialog) or "ios" (Add to Home Screen). */
  NS.installHintKind = ({ standalone, dismissed, hasPrompt, iosSafari }) =>
    standalone || dismissed ? null : hasPrompt ? "prompt" : iosSafari ? "ios" : null;

  /** What a history step from sheet depth `current` to `target` means for the sheets. */
  NS.historyTarget = (current, target) => {
    if (!(target < current)) return { action: "none" };
    if (target <= 0) return { action: "close" };
    return { action: "back", steps: current - target };
  };

  /** Offer the saved passkey through autofill only where it can work and nothing else is pending. */
  NS.passkeyAutofillPlan = ({ supported, hasPasskey, setupToken }) => supported === true && hasPasskey === true && !setupToken;

  /** How a screen's close button leaves: back to the app, close a script-opened tab, or load the list. */
  NS.closeTarget = ({ referrerSameOrigin, historyLength, opened }) => {
    if (referrerSameOrigin && historyLength > 1) return "back";
    return opened ? "close" : "list";
  };

  globalThis.NativeShell = NS;

  if (typeof document === "undefined" || typeof document.addEventListener !== "function") return;

  /* ---------- installers ---------- */

  const standalone = NS.isStandalone(window);
  NS.standalone = standalone;
  document.documentElement.classList.toggle("standalone", standalone);

  /** A short tick where the platform has one (Android). iOS has no web vibration. */
  NS.haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };

  /** No pinch or double-tap zoom in this document (the user asked for an app, not a page). */
  NS.guardZoom = (doc) => {
    const stop = (e) => e.preventDefault();
    for (const type of ["gesturestart", "gesturechange", "gestureend"]) doc.addEventListener(type, stop, { passive: false });
    doc.addEventListener("touchmove", (e) => {
      if (e.touches?.length > 1 || (typeof e.scale === "number" && e.scale !== 1)) e.preventDefault();
    }, { passive: false });
    let last = null;
    doc.addEventListener("touchend", (e) => {
      const t = e.changedTouches?.[0];
      if (!t || e.touches?.length) { last = null; return; }
      const now = e.timeStamp || Date.now();
      if (last) {
        const allowed = !!e.target?.closest?.(NS.DOUBLE_TAP_ALLOWED);
        const distance = Math.hypot(t.clientX - last.x, t.clientY - last.y);
        if (NS.blocksDoubleTap({ gapMs: now - last.at, distance, allowed })) { e.preventDefault(); last = null; return; }
      }
      last = { at: now, x: t.clientX, y: t.clientY };
    }, { passive: false });
  };
  NS.guardZoom(document);

  /** Open a link outside the app. A real anchor, so iOS keeps the app mounted underneath. */
  NS.openExternal = (url) => {
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.hidden = true;
    document.body.append(a);
    a.click();
    a.remove();
  };

  /** Run before leaving for another screen of the app (pages register it). */
  let beforeLeave = null;
  NS.setBeforeLeave = (fn) => { beforeLeave = fn; };

  /** Show another screen of the app (chat, terminal). Installed: in this window, so
   *  back comes here. In a browser tab: a new tab, as before. Call inside the tap. */
  NS.screenOpener = () => {
    if (standalone) {
      return {
        go: async (url) => { await beforeLeave?.(); location.assign(url); },
        cancel() {},
      };
    }
    const tab = window.open("about:blank", "_blank");
    return {
      go: (url) => { if (tab) tab.location = url; else location.href = url; },
      cancel: () => { try { tab?.close(); } catch {} },
    };
  };
  NS.openScreen = (url) => NS.screenOpener().go(url);

  /** Leave a screen: back to where it was opened from, close its tab, or load the list. */
  NS.closeScreen = () => {
    let referrerSameOrigin = false;
    try { referrerSameOrigin = !!document.referrer && new URL(document.referrer).origin === location.origin; } catch {}
    const how = NS.closeTarget({ referrerSameOrigin, historyLength: history.length, opened: !!window.opener || !standalone });
    if (how === "back") { history.back(); return; }
    if (how === "close") {
      window.close();
      setTimeout(() => { if (!window.closed) location.replace("/"); }, 150);
      return;
    }
    location.replace("/");
  };

  /** Run fn whenever the page comes back: restored from the back-forward cache,
   *  made visible again, or back online. */
  NS.onResume = (fn) => {
    window.addEventListener("pageshow", (e) => { if (e.persisted) fn("pageshow"); });
    document.addEventListener("visibilitychange", () => { if (!document.hidden) fn("visible"); });
    window.addEventListener("online", () => fn("online"));
  };

  // iOS can bring a page back from the cache, or an app back from the
  // background, without repainting it: a blank screen until the next touch.
  // Nudge a repaint whenever that happens.
  NS.onResume(() => {
    const root = document.documentElement;
    root.classList.add("repaint");
    requestAnimationFrame(() => root.classList.remove("repaint"));
  });

  /** Keep `--{name}` at the height left above the on-screen keyboard (unset when none). */
  NS.trackKeyboard = (name, onChange) => {
    const vv = window.visualViewport;
    let pending = false;
    let up = false;
    const sync = () => {
      pending = false;
      const height = vv ? NS.keyboardViewport({ innerHeight: window.innerHeight, vvHeight: vv.height }) : null;
      document.documentElement.style.setProperty(`--${name}`, height ? `${height}px` : "");
      up = height !== null;
      document.documentElement.classList.toggle("keyboard-up", up);
      // iOS scrolls the whole page to reveal the caret; the page already fits, so undo it.
      if (up && window.scrollY) window.scrollTo(0, 0);
      onChange?.(up);
    };
    const queue = () => { if (!pending) { pending = true; requestAnimationFrame(sync); } };
    window.addEventListener("resize", queue);
    vv?.addEventListener("resize", queue);
    vv?.addEventListener("scroll", queue);
    window.addEventListener("orientationchange", () => setTimeout(queue, 250));
    sync();
    return { softKeyboard: () => up, sync };
  };

  // Going back skips the cross-document view transition: the system back gesture
  // already animated it, and doubling it looks broken.
  window.addEventListener("pagereveal", (e) => {
    try {
      if (e.viewTransition && navigation?.activation?.navigationType === "traverse") e.viewTransition.skipTransition();
    } catch {}
  });
})();
