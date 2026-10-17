// Collab's service worker: the app shell works offline (pages and code are cached; the API and A2A never are), and
// Firebase Cloud Messaging delivers "your agent needs you" while the app is closed.
const SHELL = "collab-shell-v26";
const FILES = ["/", "/index.html", "/styles.css", "/manifest.webmanifest", "/icon.svg", "/icon-192.png",
  "/js/app.js", "/js/api.js", "/js/agent.js", "/js/cards.js", "/js/live.js", "/js/local.js", "/js/screens.js", "/js/ui.js", "/js/version.js",
  "/js/processing.js", "/js/appcheck.js", "/js/gpay.js", "/icon-512.png",
  "/js/gemma.js", "/js/e2e.js", "/js/mydevices.js", "/js/outbox.js", "/js/pass.js", "/js/fits.js", "/vendor/qrcode.js"];

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

// Push: Firebase Hosting serves the SDK and this project's config at /__/firebase/…; elsewhere (local) push is off.
try {
  importScripts("/__/firebase/12.14.0/firebase-app-compat.js", "/__/firebase/12.14.0/firebase-messaging-compat.js", "/__/firebase/init.js");
  firebase.messaging();
} catch { /* no push here */ }

self.addEventListener("notificationclick", e => {
  const link = e.notification?.data?.FCM_MSG?.fcmOptions?.link ?? "/";
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then(ws => (ws[0] ? ws[0].navigate(link).then(w => w?.focus()) : self.clients.openWindow(link))));
});
