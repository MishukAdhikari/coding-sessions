/* Coding Sessions — service worker: network-first app shell, offline fallback */
const CACHE = "xs-v83";
const ASSETS = [
  "/",
  "/app.css",
  "/tokens.css",
  "/theme.js",
  "/native.js",
  "/session-search.js",
  "/session-status.js",
  "/connection-status.js",
  "/connectors.js",
  "/secrets.js",
  "/launch-mode.js",
  "/fonts/instrument-sans.ttf",
  "/agent-auth.js",
  "/app.js",
  "/term.html",
  "/term.js",
  "/chat.html",
  "/chat.css",
  "/chat-markdown.js",
  "/chat-view.js",
  "/chat.js",
  "/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/vendor/webauthn.js",
];
// A page load waits this long for the network before the cached shell answers
// instead: a hung connection after resuming must not hold a blank screen. The
// shell then shows its own offline state and retries.
const NAVIGATION_TIMEOUT_MS = 3000;

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Tapping an "needs your answer" notification focuses the app (or opens it).
self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      for (const c of clients) {
        if ("focus" in c) return c.focus();
      }
      return self.clients.openWindow ? self.clients.openWindow("/") : undefined;
    }),
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Never the API: sign-in, passkey challenges and every live call go straight to
  // the server, uncached and unmodified.
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Live ttyd bridges are per-terminal and short-lived — caching one would
  // resurrect a dead terminal's UI offline, with nothing behind it.
  if (url.pathname.startsWith("/term/")) return;
  // OAuth callbacks carry a one-time code and state in the URL: never cache or replay them.
  if (url.pathname.startsWith("/oauth/") || url.pathname.startsWith("/.well-known/")) return;
  const network = fetch(e.request).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy));
    }
    return res;
  });
  const cached = () => caches.match(e.request, { ignoreSearch: true }).then((r) => r ?? caches.match("/"));
  if (e.request.mode !== "navigate") {
    e.respondWith(network.catch(cached));
    return;
  }
  e.respondWith(new Promise((resolve) => {
    let settled = false;
    const fallback = () => cached().then((r) => {
      if (settled) return;
      if (r) { settled = true; resolve(r); }
    });
    const timer = setTimeout(fallback, NAVIGATION_TIMEOUT_MS);
    network.then((res) => {
      clearTimeout(timer);
      if (!settled) { settled = true; resolve(res); }
    }, () => {
      clearTimeout(timer);
      cached().then((r) => {
        if (settled) return;
        settled = true;
        resolve(r ?? Response.error());
      });
    });
  }));
});
