// Sign-in (Firebase Auth) and the server API. On Firebase Hosting the config comes from /__/firebase/init.json; a
// local server without Firebase uses test accounts (DEV_AUTH).
const FB = "https://www.gstatic.com/firebasejs/12.4.0";
export const session = { uid: null, user: null, token: null, fs: null, config: {}, google: null, signOut: null, appCheck: null };

export async function signIn() {
  const hosted = await fetch("/__/firebase/init.json").then(r => (r.ok ? r.json() : null)).catch(() => null);
  session.config = await fetch("/api/config").then(r => r.json()).catch(() => ({}));
  const config = hosted ?? session.config.firebase;
  if (config) {
    const { initializeApp } = await import(`${FB}/firebase-app.js`);
    const { getAuth, onAuthStateChanged, signInAnonymously, GoogleAuthProvider, linkWithPopup, signInWithPopup, signOut } = await import(`${FB}/firebase-auth.js`);
    const app = initializeApp(config);
    // App Check (reCAPTCHA Enterprise): the server can tell its own web app from scripts calling the API.
    if (session.config.appCheckSiteKey) {
      try {
        const { initializeAppCheck, ReCaptchaEnterpriseProvider, getToken } = await import(`${FB}/firebase-app-check.js`);
        const ac = initializeAppCheck(app, { provider: new ReCaptchaEnterpriseProvider(session.config.appCheckSiteKey), isTokenAutoRefreshEnabled: true });
        session.appCheck = async () => (await getToken(ac, false)).token;
      } catch { /* the server decides whether calls without it are allowed */ }
    }
    const auth = getAuth(app);
    await new Promise(resolve => onAuthStateChanged(auth, async u => {
      if (!u) { await signInAnonymously(auth); return; }
      session.uid = u.uid; session.user = u;
      session.token = () => u.getIdToken();
      resolve();
    }));
    session.google = async () => {
      const provider = new GoogleAuthProvider();
      try { await linkWithPopup(auth.currentUser, provider); }
      catch (e) { if (e.code === "auth/credential-already-in-use") { await signInWithPopup(auth, provider); location.reload(); } else throw e; }
    };
    session.signOut = async () => { await signOut(auth); location.reload(); };
    try {
      const { getFirestore, collection, doc, query, where, onSnapshot } = await import(`${FB}/firebase-firestore.js`);
      const db = getFirestore(app);
      session.fs = {
        engagements: cb => onSnapshot(query(collection(db, "engagements"), where("participants", "array-contains", session.uid)), s => cb(s.docs.map(d => d.data())), () => {}),
        inbox: cb => onSnapshot(query(collection(db, "inbox"), where("owner", "==", session.uid), where("status", "==", "open")), s => cb(s.docs.map(d => d.data())), () => {}),
        engagement: (id, cb) => onSnapshot(doc(db, "engagements", id), s => s.exists() && cb(s.data()), () => {}),
      };
    } catch { /* polling instead */ }
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
  if (session.appCheck) { try { headers["x-firebase-appcheck"] = await session.appCheck(); } catch { /* sent without */ } }
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.error ?? `Request failed (${res.status})`); e.status = res.status; throw e; }
  return data;
}

/** "What similar deals closed at" lines; empty when fewer than 3 comparable deals exist. */
export async function insightsLines({ side, category, area, price, limit, unit }) {
  try {
    const q = new URLSearchParams({ category: category ?? "", side });
    if (area) q.set("area", area);
    if (price) q.set("price", String(price));
    if (limit) q.set("limit", String(limit));
    if (unit !== undefined) q.set("unit", unit ?? "");
    return (await api(`/api/insights?${q}`)).lines ?? [];
  } catch { return []; }
}
