// The front page at collab-55.web.app: the Collab site (web/home.html), shown whenever the plain address is opened
// in a browser. Its "Try it now" / "Open Collab" come back as /?try: the sign-in screen, or Collab itself for someone
// signed in. It shows before sign-in, so looking at it creates no account. The installed app, links (a QR's ?to=, a
// notification's ?screen=) and a reload of Collab in the same tab go straight in.

const IN_APP = "collab.inapp";

/** Collab already opened in this tab (a reload, an update, signing out): it stays Collab. */
export function inApp(store = globalThis.sessionStorage) {
  try { return store.getItem(IN_APP) === "1"; } catch { return false; }
}

/** Whether this visit opens on the front page. `?landing` always does; `?install` is the QR on it. */
export function shouldLand(query, { installed = false, opened = false } = {}) {
  const q = new URLSearchParams(query);
  if (q.has("landing")) return true;
  if (installed || opened || q.has("try")) return false;
  return [...q.keys()].every(k => k === "install");
}

/** Collab opens in this tab (from the site's Try, a link, the installed app): remembered for the tab's reloads, and
 *  the site's ?try leaves the address. */
export function opening() {
  try { sessionStorage.setItem(IN_APP, "1"); } catch {}
  if (new URLSearchParams(location.search).has("try")) history.replaceState(history.state, "", "/");
}

/** Shows the site in place of the app, at the same address. Offline (the site can't be fetched): Collab opens. */
export async function landing() {
  const res = await fetch("/home.html").catch(() => null);
  if (!res?.ok) return;
  const html = await res.text();
  document.open(); document.write(html); document.close();
  await new Promise(() => {}); // the site's links reload into Collab
}
