// Collab's service worker: the app shell works offline (pages and code are cached; the API and A2A never are), and
// Firebase Cloud Messaging delivers "your agent needs you" while the app is closed.
const SHELL = "collab-shell-v1";
const FILES = ["/", "/index.html", "/styles.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png",
  "/js/app.js", "/js/api.js", "/js/agent.js", "/js/cards.js", "/js/live.js", "/js/local.js", "/js/screens.js", "/js/ui.js"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first (so a new version shows at once), the cache when offline. Never the API, A2A or Firebase's own URLs.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || /^\/(api|a2a|cron|__)\//.test(url.pathname) || url.pathname === "/health") return;
  e.respondWith(fetch(e.request).then(r => {
    if (r.ok) { const copy = r.clone(); caches.open(SHELL).then(c => c.put(e.request, copy)); }
    return r;
  }).catch(async () => (await caches.match(e.request)) ?? (e.request.mode === "navigate" ? caches.match("/index.html") : Response.error())));
});

// Push: Firebase Hosting serves the SDK and this project's config at /__/firebase/…; elsewhere (local) push is off.
try {
  importScripts("/__/firebase/12.4.0/firebase-app-compat.js", "/__/firebase/12.4.0/firebase-messaging-compat.js", "/__/firebase/init.js");
  firebase.messaging();
} catch { /* no push here */ }

self.addEventListener("notificationclick", e => {
  const link = e.notification?.data?.FCM_MSG?.fcmOptions?.link ?? "/";
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(ws => (ws[0] ? ws[0].navigate(link).then(w => w?.focus()) : self.clients.openWindow(link))));
});
