// Sign-in (Firebase Auth) and the server API. On Firebase Hosting the config comes from /__/firebase/init.json; a
// local server without Firebase uses test accounts (DEV_AUTH).
export const FB = "https://www.gstatic.com/firebasejs/12.14.0";
export const session = { pushOn: false, install: null, fsReady: null, uid: null, user: null, token: null, fs: null, config: {}, google: null, signOut: null, appCheck: null, app: null, push: null };

// The app works offline and installs as an app (PWA); the same service worker receives push notifications.
export const worker = "serviceWorker" in navigator ? navigator.serviceWorker.register("/sw.js").catch(() => null) : Promise.resolve(null);

const CONFIG_KEY = "collab.config";

/** The server's and Firebase's config, fetched together; null when the server can't be reached. */
const fetchConfig = () => Promise.all([
  fetch("/__/firebase/init.json").then(r => (r.ok ? r.json() : null)).catch(() => null),
  fetch("/api/config").then(r => (r.ok ? r.json() : null)).catch(() => null),
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
    const appCheck = session.config.appCheckSiteKey ? import(`${FB}/firebase-app-check.js`).then(({ initializeAppCheck, ReCaptchaEnterpriseProvider, getToken, getLimitedUseToken }) => {
      const ac = initializeAppCheck(initializeApp(config, `check-${as ?? "main"}`), { provider: new ReCaptchaEnterpriseProvider(session.config.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
      getToken(ac, false).catch(() => {});
      return async (limited = false) => (await (limited ? getLimitedUseToken(ac) : getToken(ac, false))).token;
    }).catch(() => null) : null;
    if (appCheck) session.appCheck = async (limited = false) => { const get = await appCheck; return get ? get(limited) : null; };
    const auth = getAuth(app);
    // Returning from a Google redirect (used where pop-ups don't work, like some installed apps).
    await getRedirectResult(auth).catch(async e => {
      const cred = GoogleAuthProvider.credentialFromError(e);
      if (e.code === "auth/credential-already-in-use" && cred) await signInWithCredential(auth, cred);
    });
    await new Promise(resolve => onAuthStateChanged(auth, async u => {
      if (!u) { await signInAnonymously(auth); return; }
      session.uid = u.uid; session.user = u;
      session.token = () => u.getIdToken();
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
        return "linked";
      } catch (e) {
        const cred = GoogleAuthProvider.credentialFromError(e);
        if (e.code === "auth/credential-already-in-use" && cred) { await signInWithCredential(auth, cred); return "switched"; }
        if (/popup-blocked|operation-not-supported|web-storage-unsupported/.test(e.code ?? "")) { await (auth.currentUser?.isAnonymous ? linkWithRedirect(auth.currentUser, provider) : signInWithRedirect(auth, provider)); return "redirect"; }
        if (/popup-closed|cancelled-popup/.test(e.code ?? "")) return "cancelled";
        throw e;
      }
    };
    session.signOut = async () => { await signOut(auth); location.reload(); };
    // Live updates (Firestore) load after sign-in without holding up the first screen; until then the app polls.
    session.fsReady = import(`${FB}/firebase-firestore.js`).then(({ initializeFirestore, getFirestore, persistentLocalCache, persistentMultipleTabManager, collection, doc, query, where, onSnapshot }) => {
      // Offline cache: the installed app shows conversations and inbox items with no network, and catches up after.
      let db;
      try { db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) }); }
      catch { db = getFirestore(app); }
      session.fs = {
        engagements: cb => onSnapshot(query(collection(db, "engagements"), where("participants", "array-contains", session.uid)), s => cb(s.docs.map(d => d.data())), () => {}),
        inbox: cb => onSnapshot(query(collection(db, "inbox"), where("owner", "==", session.uid), where("status", "==", "open")), s => cb(s.docs.map(d => d.data())), () => {}),
        engagement: (id, cb) => onSnapshot(doc(db, "engagements", id), s => s.exists() && cb(s.data()), () => {}),
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

export async function api(path, body) {
  const headers = { "content-type": "application/json" };
  if (session.token) headers.authorization = `Bearer ${await session.token()}`;
  const limited = body !== undefined && (path === "/api/price-check"
    || /^\/api\/engagements\/[^/]+\/pay$/.test(path)
    || /^\/api\/pickup\/[^/]+\/collect$/.test(path));
  if (session.appCheck) {
    try {
      const t = await session.appCheck(limited);
      if (!t && limited) throw new Error("No limited-use token was returned.");
      if (t) headers["x-firebase-appcheck"] = t;
    }
    catch (e) { if (limited) throw new Error("Could not verify this app for the action. Please try again.", { cause: e }); }
  }
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error ?? `Request failed (${res.status})`); e.status = res.status; throw e; }
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
