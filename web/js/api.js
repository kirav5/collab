// Sign-in (Firebase Auth) and the server API. On Firebase Hosting the config comes from /__/firebase/init.json; a
// local server without Firebase uses test accounts (DEV_AUTH).
import { appCheckCode, usableToken } from "./appcheck.js";
export const FB = "https://www.gstatic.com/firebasejs/12.14.0";
export const session = { track: () => {}, appCheckNow: () => null, appCheckRefresh: () => {}, appCheckError: null, appCheckOk: false, ready: null, fresh: false, pushOn: false, install: null, fsReady: null, uid: null, user: null, token: null, fs: null, config: {}, google: null, signOut: null, appCheck: null, app: null, push: null };

// The app works offline and installs as an app (PWA); the same service worker receives push notifications.
export const worker = "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);

const CONFIG_KEY = "collab.config";

/** The server's and Firebase's config, fetched together; null when the server can't be reached. */
const fetchConfig = () => Promise.all([
  fetch("/__/firebase/init.json", { signal: AbortSignal.timeout(10_000) }).then(r => (r.ok ? r.json() : null)).catch(() => null),
  fetch("/api/config", { signal: AbortSignal.timeout(10_000) }).then(r => (r.ok ? r.json() : null)).catch(() => null),
]).then(([hosted, server]) => {
  if (!server) return null;
  const c = { ...server, firebase: hosted ?? server.firebase ?? null };
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(c)); } catch {}
  return c;
});

// Installing: Chrome/Edge/Android offer a prompt the app can show from its own button; iPhone and iPad install from
// Safari's Share menu (and only an installed app can get notifications there).
export const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
export const ios = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
export function installHint() {
  if (ios() && !standalone()) return "On iPhone, notifications work only in the installed app: tap Share, then “Add to Home Screen”, and open Collab from there.";
  return "This browser can't show notifications.";
}
addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  session.install = async () => { e.prompt(); const r = await e.userChoice; session.install = null; return r.outcome === "accepted"; };
  dispatchEvent(new Event("collab-installable"));
});
addEventListener("appinstalled", () => { session.install = null; dispatchEvent(new Event("collab-installable")); });

export async function signIn() {
  // The config this browser saw last is used at once (and refreshed in the background), so a returning visit doesn't
  // wait on the server before signing in; the Firebase SDK starts loading at the same time.
  let cached = null;
  try { cached = JSON.parse(localStorage.getItem(CONFIG_KEY) ?? "null"); } catch {}
  const fresh = fetchConfig();
  const sdk = c => (c?.firebase ? Promise.all([import(`${FB}/firebase-app.js`), import(`${FB}/firebase-auth.js`)]) : null);
  let loading = sdk(cached);
  session.config = cached ?? (await fresh) ?? {};
  if (cached) fresh.then(c => { if (c) session.config = { ...session.config, ...c }; });
  else loading = sdk(session.config);
  const config = session.config.firebase;
  if (config) {
    const [{ initializeApp }, authSdk] = await loading;
    const { getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, linkWithPopup, linkWithRedirect, signInWithPopup,
      signInWithCredential, signInWithRedirect, getRedirectResult, signOut } = authSdk;
    // ?as=<name> gives this tab its own guest account (Firebase keeps sign-ins per app name), so one browser can be
    // two people — for trying both sides of a conversation.
    const as = new URLSearchParams(location.search).get("as")?.replace(/[^\w-]/g, "").slice(0, 24);
    const app = as ? initializeApp(config, `as-${as}`) : initializeApp(config);
    session.app = app;
    // Push: asks the browser (only ever from a tap), then registers this device's address with the server. Once
    // permission is there, every visit re-registers quietly, since browsers rotate the address.
    session.push = async (ask = true) => {
      const reg = await worker;
      if (!reg || !("Notification" in window) || !("PushManager" in window)) throw new Error(installHint());
      if (Notification.permission === "denied") throw new Error("Notifications are blocked for this site — allow them in your browser's site settings, then try again.");
      if (Notification.permission !== "granted" && (!ask || (await Notification.requestPermission()) !== "granted")) return false;
      const { getMessaging, getToken, onMessage } = await import(`${FB}/firebase-messaging.js`);
      const messaging = getMessaging(app);
      const token = await getToken(messaging, { serviceWorkerRegistration: await navigator.serviceWorker.ready });
      await api("/api/push/token", { token });
      if (!session.pushOn) onMessage(messaging, m => window.dispatchEvent(new CustomEvent("collab-push", { detail: { ...(m.notification ?? {}), link: m.fcmOptions?.link } })));
      session.pushOn = true;
      return true;
    };
    // App Check (reCAPTCHA Enterprise): the server can tell its own web app from scripts calling the API. It runs on
    // its own Firebase app instance so sign-in doesn't wait for reCAPTCHA (Auth would otherwise attach a token to
    // every call): the two run side by side, and API calls wait for the token only if it isn't ready yet.
    const appCheck = session.config.appCheckSiteKey ? import(`${FB}/firebase-app-check.js`).then(({ initializeAppCheck, ReCaptchaEnterpriseProvider, getToken, getLimitedUseToken, onTokenChanged }) => {
      const ac = initializeAppCheck(initializeApp(config, `check-${as ?? "main"}`), { provider: new ReCaptchaEnterpriseProvider(session.config.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
      let current = null;
      const failed = e => { session.appCheckError = { code: appCheckCode(e), at: Date.now() }; session.appCheckOk = false; session.track("appcheck_failed", { code: session.appCheckError.code }); };
      const got = t => { session.appCheckOk = true; session.appCheckError = null; return t; };
      onTokenChanged(ac, t => { current = t?.token ?? null; if (current) got(current); }, failed);
      session.appCheckNow = () => current;
      // A stale token is never sent; asking for a fresh one happens in the background.
      session.appCheckRefresh = () => getToken(ac, false).then(r => { current = r.token; got(r.token); }).catch(failed);
      session.appCheckRefresh();
      return async (limited = false, force = false) => {
        try { return got((await (limited ? getLimitedUseToken(ac) : getToken(ac, force))).token); }
        catch (e) { failed(e); throw e; }
      };
    }).catch(e => { session.appCheckError = { code: appCheckCode(e), at: Date.now() }; return null; }) : null;
    if (appCheck) session.appCheck = async (limited = false, force = false) => { const get = await appCheck; return get ? get(limited, force) : null; };
    const auth = getAuth(app);
    // Returning from a Google redirect (used where pop-ups don't work, like some installed apps) — only checked when
    // this tab started one, so ordinary visits don't wait on it.
    let redirected = false;
    try { redirected = sessionStorage.getItem("collab.redirect") === "1"; sessionStorage.removeItem("collab.redirect"); } catch {}
    if (redirected) await getRedirectResult(auth).catch(async e => {
      const cred = GoogleAuthProvider.credentialFromError(e);
      if (e.code === "auth/credential-already-in-use" && cred) await signInWithCredential(auth, cred);
    });
    const adopt = u => { session.uid = u.uid; session.user = u; session.token = () => u.getIdToken(); };
    await new Promise(resolve => onAuthStateChanged(auth, u => {
      if (u) { adopt(u); session.ready ??= Promise.resolve(); resolve(); return; }
      if (session.ready) return;
      // First visit on this device: the start screen shows now and the guest sign-in (about a second) runs while the
      // visitor types their name. Everything that needs the account waits on session.ready.
      session.fresh = true;
      session.ready = signInAnonymously(auth).then(c => adopt(c.user));
      resolve();
    }));
    /**
     * Google sign-in. A guest's account is upgraded in place (same identity, handle and context); if that Google
     * account already has a Collab identity, this device switches to it. Returns "linked" or "switched".
     */
    session.google = async () => {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      try {
        if (auth.currentUser?.isAnonymous) await linkWithPopup(auth.currentUser, provider);
        else await signInWithPopup(auth, provider);
        session.user = auth.currentUser;
        // A fresh token says Google now, so a report made next counts on the seller's record (a guest's doesn't).
        await auth.currentUser?.getIdToken(true).catch(() => {});
        return "linked";
      } catch (e) {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if (e.code === "auth/credential-already-in-use" && cred) { await signInWithCredential(auth, cred); return "switched"; }
        if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(e.code ?? "")) {
          try { sessionStorage.setItem("collab.redirect", "1"); } catch {}
          await (auth.currentUser?.isAnonymous ? linkWithRedirect(auth.currentUser, provider) : signInWithRedirect(auth, provider)); return "redirect";
        }
        if (/popup-closed|cancelled-popup/.test(e.code ?? "")) return "cancelled";
        throw e;
      }
    };
    session.signOut = async () => { await signOut(auth); location.reload(); };
    // Product analytics (Google Analytics for Firebase): event names and small numbers only — never message text,
    // names, handles or private facts. Loaded after sign-in so it never delays the first screen.
    if (config.measurementId && !as) import(`${FB}/firebase-analytics.js`).then(({ getAnalytics, logEvent, setUserProperties }) => {
      const ga = getAnalytics(app);
      session.track = (name, params = {}) => { try { logEvent(ga, name, params); } catch {} };
      setUserProperties(ga, { signed_in: auth.currentUser?.isAnonymous ? "guest" : "google" });
    }).catch(() => {});
    // Live updates (Firestore) load after sign-in without holding up the first screen; until then the app polls.
    session.fsReady = import(`${FB}/firebase-firestore.js`).then(mod => {
      const { initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where, onSnapshot } = mod;
      // Offline cache: the installed app shows conversations and inbox items with no network, and catches up after.
      let db;
      try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
      catch { db = getFirestore(app); }
      session.fs = {
        engagements: cb => onSnapshot(query(collection(db, "engagements"), where("participants", "array-contains", session.uid)), s => cb(s.docs.map(d => d.data())), () => {}),
        inbox: cb => onSnapshot(query(collection(db, "inbox"), where("owner", "==", session.uid), where("status", "==", "open")), s => cb(s.docs.map(d => d.data())), () => {}),
        engagement: (id, cb) => onSnapshot(doc(db, "engagements", id), s => s.exists() && cb(s.data()), () => {}),
        // The SDK itself, for My devices (users/{uid}/devices and /jobs: the owner's own, end-to-end encrypted).
        raw: { db, mod },
      };
      return session.fs;
    }).catch(() => null);
  } else if (session.config.devAuth) {
    // Local test accounts: ?as=<name> switches, so two tabs can be two people.
    const as = new URLSearchParams(location.search).get("as");
    let uid = as ? `dev-${as}` : localStorage.getItem("collab.dev");
    if (!uid) { uid = "dev-" + Math.random().toString(36).slice(2, 8); }
    try { if (!as) localStorage.setItem("collab.dev", uid); } catch {}
    session.uid = uid;
    session.token = async () => `dev:${uid}`;
    session.signOut = async () => { try { localStorage.removeItem("collab.dev"); } catch {} location.href = "/"; };
  }
}

/**
 * A read shared by everything that asks for it within a few seconds (screens repaint on every live update, and several
 * parts of a screen want the same list). Any write clears it.
 */
const reads = new Map(), kept = new Map();
let onNewer = () => {};
/** Called when a read shown from what was kept turns out to have changed (the app repaints). */
export const onFreshRead = fn => { onNewer = fn; };
export function cached(path, ttl = 10_000) {
  const hit = reads.get(path);
  if (hit && Date.now() - hit.at < ttl) return hit.p;
  const p = api(path).then(v => {
    const before = kept.get(path); kept.set(path, v);
    if (before !== undefined && JSON.stringify(before) !== JSON.stringify(v)) onNewer();
    return v;
  }).catch(e => { reads.delete(path); throw e; });
  reads.set(path, { at: Date.now(), p });
  // Opened again: drawn at once from what was shown last, and repainted if the server's answer is different. After any
  // write nothing is kept (what's shown is never older than the person's own change).
  return kept.has(path) ? Promise.resolve(kept.get(path)) : p;
}

export async function api(path, body) {
  const headers = { "content-type": "application/json" };
  if (session.token) headers.authorization = `Bearer ${await session.token()}`;
  const limited = body !== undefined && (path === "/api/price-check"
    || /^\/api\/engagements\/[^/]+\/pay$/.test(path)
    || /^\/api\/pickup\/[^/]+\/collect$/.test(path)
    || /^\/api\/engagements\/[^/]+\/(report(\/reply)?|payment-check)$/.test(path));
  // Plain reads (not goals, which can run the model) go out at once with the current token, if it's still good.
  // Everything else waits up to 5 s for one; a browser that can't get one (a content blocker, a private window, the
  // SDK throttling itself) still sends — the server limits unverified calls and refuses only payments, pickups,
  // reports, payment checks and price checks, and says why.
  const plainRead = body === undefined && !/^\/api\/goals(\/|$)/.test(path);
  const tokenFor = async force => {
    if (plainRead) { const t = usableToken(session.appCheckNow(), Date.now()); if (!t) session.appCheckRefresh(); return t; }
    if (!session.appCheck) return null;
    return Promise.race([session.appCheck(limited, force), new Promise(r => setTimeout(() => r(null), 5000))]).catch(() => null);
  };
  // A write may change anything a cached read shows — except chat-history syncs and push registration, which don't.
  if (body !== undefined && !/^\/api\/(chats|push\/token)(\/|$)/.test(path)) { reads.clear(); kept.clear(); }
  const send = async force => {
    const t = await tokenFor(force);
    return fetch(path, { method: body === undefined ? "GET" : "POST", headers: t ? { ...headers, "x-firebase-appcheck": t } : headers, body: body === undefined ? undefined : JSON.stringify(body) });
  };
  let res = await send(false);
  let data = await res.json().catch(() => ({}));
  // Refused by the browser check (before the request was handled, so nothing ran): once more with a fresh token.
  if (res.status === 401 && data.code === "APP_CHECK" && !plainRead) { res = await send(true); data = await res.json().catch(() => ({})); }
  if (!res.ok) { const e = new Error(data.error ?? `Request failed (${res.status})`); e.status = res.status; e.code = data.code; e.data = data; throw e; }
  return data;
}

/** "What similar deals closed at" lines; empty when fewer than 3 comparable deals exist. */
export async function insightsLines({ side, category, area, price, limit, unit, item }) {
  try {
    const q = new URLSearchParams({ category: category ?? "", side });
    if (area) q.set("area", area);
    if (item) q.set("item", item);
    if (price) q.set("price", String(price));
    if (limit) q.set("limit", String(limit));
    if (unit !== undefined) q.set("unit", unit ?? "");
    return (await api(`/api/insights?${q}`)).lines ?? [];
  } catch { return []; }
}
