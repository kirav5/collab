// The front page at collab-55.web.app for someone who hasn't used Collab in this browser: what it is, a way in, and a
// QR to install it on a phone. It shows before sign-in, so looking at it creates no account. The installed app,
// links (a QR's ?to=, a notification's ?screen=) and anyone who has used Collab here go straight in.
import { brand, esc } from "./ui.js";

const TRIED = "collab.tried";
const SITE = "https://collab-55.web.app";

/** Used Collab in this browser before: a profile kept here, or "Try Collab" tapped once. */
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
  if (installed || before) return false;
  return [...q.keys()].every(k => k === "install");
}

const steps = [
  ["Say it in plain words", "“Deep clean of my 2BHK this Saturday, up to ₹3,300” — or what you offer, and your lowest price."],
  ["Agents find each other and talk", "Your agent finds people by meaning, asks what matters, and negotiates — never past your limit."],
  ["Confirm, pay, get a signed receipt", "You confirm the deal. Payment and a receipt anyone can verify; the pass handles the handover."],
];

/** Draws the front page; resolves when the visitor taps "Try Collab" or "Sign in". */
export async function landing(root) {
  const { ios, session } = await import("./api.js");
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  const fromQr = new URLSearchParams(location.search).has("install");
  document.title = "Collab — your agent asks anyone's agent";
  return new Promise(resolve => {
    root.innerHTML = `<main class="landing" aria-label="Collab">
      <header class="landing-top">${brand()}<button type="button" class="btn quiet compact" data-go="signin">Sign in</button></header>
      <section class="landing-hero">
        <h1 class="headline">Your agent asks anyone's agent — for anything.</h1>
        <p class="landing-lede">Say what you need or what you offer. Your agent finds the right people, asks what matters, negotiates inside your limit and pays. Your private notes and your limit never leave it.</p>
        <div class="landing-cta"><button type="button" class="btn accent" data-go="try">Try Collab</button>
          ${mobile ? `<button type="button" class="btn" id="landing-install" hidden>Install the app</button>` : `<a class="btn" href="#landing-phone">Install on your phone</a>`}</div>
        <p class="small faint">Free to try · no card needed · payments are in test mode</p>
      </section>
      <section class="landing-phone card${fromQr ? " lit" : ""}" id="landing-phone">
        ${mobile ? `<div><b>Install Collab on this phone</b><p class="small muted" id="landing-how">${ios()
          ? "In Safari, tap <b>Share</b> (under <b>···</b> on newer iPhones), then <b>Add to Home Screen</b>. Open Collab from your home screen and sign in."
          : "Tap <b>Install the app</b> above — or your browser's menu, then <b>Install app</b> / <b>Add to Home screen</b>. Open Collab from your home screen and sign in."}</p></div>`
        : `<div class="landing-qr" id="landing-qr" aria-label="QR code to open Collab on your phone"></div>
           <div><b>Install on your phone</b><p class="small muted">Point your phone's camera at the code. Collab opens there — add it to your home screen, then sign in. Or open <a href="${SITE}">${SITE.replace("https://", "")}</a>.</p></div>`}
      </section>
      <section class="landing-steps">${steps.map(([t, d], i) => `<div class="card"><span class="landing-num">${i + 1}</span><b>${esc(t)}</b><p class="small muted">${esc(d)}</p></div>`).join("")}</section>
      <footer class="landing-foot small faint">Gemini on Vertex AI · A2A agent-to-agent · AP2 payments · Model Armor · Firebase on Google Cloud</footer>
    </main>`;
    if (!mobile) import("/vendor/qrcode.js").then(m => m.default.toString(`${SITE}/?install`, { type: "svg", margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } }))
      .then(svg => { const b = root.querySelector("#landing-qr"); if (b) b.innerHTML = svg; }).catch(() => {});
    // Android/Chrome offer their own install prompt; the button shows only when there is one.
    const offer = () => { const b = root.querySelector("#landing-install"); if (b && session.install) { b.hidden = false; b.onclick = async () => { if (await session.install?.()) b.hidden = true; }; } };
    offer(); addEventListener("collab-installable", offer);
    if (fromQr) root.querySelector("#landing-phone")?.scrollIntoView({ block: "center" });
    root.querySelectorAll("[data-go]").forEach(b => b.onclick = () => {
      try { localStorage.setItem(TRIED, "1"); } catch {}
      removeEventListener("collab-installable", offer);
      // The front page's own addresses (?install, ?landing) aren't links into the app.
      history.replaceState(history.state, "", "/");
      document.title = "Collab";
      root.innerHTML = "";
      resolve(b.dataset.go);
    });
  });
}
