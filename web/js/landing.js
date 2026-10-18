// The front page at collab-55.web.app for someone who hasn't used Collab in this browser: the Collab site
// (web/home.html), whose "Try it now" / "Open Collab" come back as /?try. It shows before sign-in, so looking at it
// creates no account. The installed app, links (a QR's ?to=, a notification's ?screen=) and anyone who has used
// Collab here go straight in.

const TRIED = "collab.tried";

/** Used Collab in this browser before: a profile kept here, or "Try" tapped once. */
export function returning(store = globalThis.localStorage) {
  try {
    if (store.getItem(TRIED) === "1") return true;
    for (let i = 0; i < store.length; i++) { const k = store.key(i); if (k?.startsWith("collab.me.") && store.getItem(k) !== "null") return true; }
  } catch {}
  return false;
}

/** Whether this visit opens on the front page. `?landing` always does; `?install` is the QR on it. */
export function shouldLand(query, { installed = false, before = false } = {}) {
  const q = new URLSearchParams(query);
  if (q.has("landing")) return true;
  if (installed || before || q.has("try")) return false;
  return [...q.keys()].every(k => k === "install");
}

/** Arriving from the site's "Try": remembered, so this browser opens Collab from now on, and the address is plain. */
export function tried() {
  if (!new URLSearchParams(location.search).has("try")) return;
  try { localStorage.setItem(TRIED, "1"); } catch {}
  history.replaceState(history.state, "", "/");
}

/** Shows the site in place of the app, at the same address. Offline (the site can't be fetched): Collab opens. */
export async function landing() {
  const res = await fetch("/home.html").catch(() => null);
  if (!res?.ok) return;
  const html = await res.text();
  document.open(); document.write(html); document.close();
  await new Promise(() => {}); // the site's links reload into Collab
}
