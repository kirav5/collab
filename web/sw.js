// Collab's service worker: the app shell works offline (pages and code are cached; the API and A2A never are), and
// Firebase Cloud Messaging delivers "your agent needs you" while the app is closed.
const SHELL = "collab-shell-v50";
const FILES = ["/", "/index.html", "/styles.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png", "/badge-96.png",
  "/js/app.js", "/js/api.js", "/js/agent.js", "/js/cards.js", "/js/live.js", "/js/local.js", "/js/screens.js", "/js/ui.js", "/js/version.js",
  "/js/processing.js", "/js/appcheck.js", "/js/gpay.js", "/icon-512.png",
  "/js/gemma.js", "/js/e2e.js", "/js/mydevices.js", "/js/outbox.js", "/js/pass.js", "/js/fits.js", "/js/panel.js", "/vendor/qrcode.js", "/js/roles.js"];

self.addEventListener("install", e => { e.waitUntil(caches.open(SHELL).then(c => c.addAll(FILES)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== SHELL).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

// Network first, so every open gets the version just deployed (files revalidate with ETags, so it's quick); the
// device's copy when offline or when the network takes over 3 s. Never the API, A2A, Firebase's own URLs or the
// version stamp the app checks for updates.
self.addEventListener("fetch", e => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || /^\/(api|a2a|cron|public|__)\//.test(url.pathname) || ["/health", "/version.txt"].includes(url.pathname)) return;
  if (["/pickup.html", "/verify.html"].includes(url.pathname)) return;
  const key = e.request.mode === "navigate" ? "/index.html" : url.pathname;
  const net = fetch(e.request).then(r => {
    if (r.ok && r.type === "basic") { const copy = r.clone(); caches.open(SHELL).then(c => c.put(key, copy)); }
    return r;
  });
  const cached = () => caches.match(key);
  const slow = new Promise(resolve => setTimeout(resolve, 3000)).then(cached);
  e.respondWith(Promise.race([net, slow]).then(r => r ?? net).catch(async () => (await cached()) ?? Response.error()));
});

// A tapped notification opens the conversation it's about. Registered before Firebase's own handler (which would only
// look for a window at that exact address and otherwise open another one): an open Collab is brought forward and told
// where to go — no reload — and a closed one opens there.
self.addEventListener("notificationclick", e => {
  e.stopImmediatePropagation();
  e.notification.close();
  const d = e.notification?.data ?? {};
  const raw = d.FCM_MSG?.fcmOptions?.link ?? d.FCM_MSG?.data?.link ?? d.link ?? "/";
  const url = new URL(raw, self.location.origin);
  const link = url.origin === self.location.origin ? url.pathname + url.search : "/";
  e.waitUntil((async () => {
    const ws = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const w = ws.find(c => new URL(c.url).origin === self.location.origin);
    if (w) { await w.focus().catch(() => {}); w.postMessage({ type: "collab-open", link }); return; }
    await self.clients.openWindow(link);
  })());
});

// Push: Firebase Hosting serves the SDK and this project's config at /__/firebase/…; elsewhere (local) push is off.
try {
  importScripts("/__/firebase/12.14.0/firebase-app-compat.js", "/__/firebase/12.14.0/firebase-messaging-compat.js", "/__/firebase/init.js");
  firebase.messaging();
} catch { /* no push here */ }

