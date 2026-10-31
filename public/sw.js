/* xCloud Sessions — service worker: network-first app shell, offline fallback */
const CACHE = "xs-v58";
const ASSETS = [
  "/",
  "/app.css",
  "/tokens.css",
  "/theme.js",
  "/session-search.js",
  "/session-status.js",
  "/fonts/instrument-sans.ttf",
  "/agent-auth.js",
  "/app.js",
  "/term.html",
  "/term.js",
  "/icon.svg",
  "/apple-touch-icon.png",
  "/manifest.webmanifest",
  "/vendor/webauthn.js",
];

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
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/")) return;
  // Live ttyd bridges are per-terminal and short-lived — caching one would
  // resurrect a dead terminal's UI offline, with nothing behind it.
  if (url.pathname.startsWith("/term/")) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() =>
        caches.match(e.request, { ignoreSearch: true })
          .then((r) => r ?? caches.match("/")),
      ),
  );
});
