// Collab on the web: one chat with your agent (it remembers, answers from your notes, shapes requests with Gemini and
// publishes what you offer), every conversation your agent has with other people's agents as live cards, and the
// screens Collab has: what your agents are doing (Activity), your QR and public card (My card), what your agent knows (About me),
// who sees what and what was shared (Privacy), and Settings.
import { shouldReload } from "./version.js";
import { api, cached, insightsLines, ios, onFreshRead, session, signIn, standalone } from "./api.js";
import { answerBrief, applyRecalled, autonomyOf, cachedNotes, chat, detectEngine, engine, itemOf, offerReply, refreshNotesCache, rememberAll, startDevice, drafts } from "./agent.js";
import { onDevices, refreshServing, startDevices } from "./mydevices.js";
import { warmGemma } from "./gemma.js";
import { replayOutbox } from "./outbox.js";
import { local, setOwner } from "./local.js";
import { live, needsYou, needsYouCount, onChange, refresh, start } from "./live.js";
import { checkoutHTML, dealAmount, priceChecks, priceKey, defaultHours, engagementCard, hoursOk, messageHTML, nearbyHTML, receiptHTML, rulesList, setNotesHere, storeCard } from "./cards.js";
import { gpay, openGooglePay, preload as preloadGooglePay } from "./gpay.js";
import { passHTML, passKind, passQR } from "./pass.js";
import { clearPanel, closePanel, openPanel, panelDetail, startPanel } from "./panel.js";
import { screens } from "./screens.js";
import { privacyFacts } from "./processing.js";
import { ask, avatarHTML, brand, $, busy, esc, id, label, money, notice, now, shortName, tag, toast, logo, icon } from "./ui.js";
import { limitPast, offerWords, ownerPays, partyRoles } from "./roles.js";

const S = { profile: null, sessions: [], current: null, screen: "chat", focus: null, sending: false };
// Incognito (Settings): remembered on this device only as the on/off choice itself.
try { S.incognito = localStorage.getItem("collab-incognito") === "on"; } catch { S.incognito = false; }
session.incognito = S.incognito;

const root = $("#root");

// MARK: - Boot

async function setup() {
  const to = new URLSearchParams(location.search).get("to")?.replace(/[^\w-]/g, "").slice(0, 24);
  const google = session.user && !session.user.isAnonymous;
  const suggest = (session.user?.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return new Promise(resolve => {
    timing("start_screen");
    root.innerHTML = `<div class="setup"><form class="card" id="setup">
      ${brand()}
      <h1 class="headline">Your agent. <span class="soft">It answers from your context. Your limits never leave.</span></h1>
      ${to ? `<div class="card slim" id="setup-to"><span class="small">You're about to ask <b>@${esc(to)}</b>'s agent.</span></div><p class="small muted">Start your own agent first — just your name. It asks for you, and keeps what's private to you.</p>` : ""}
      ${session.google ? (google
        ? `<p class="small muted">Signed in as <b>${esc(session.user.email ?? session.user.displayName ?? "Google")}</b> — this identity follows you to any device.</p>`
        : `<button type="button" class="btn google" id="google"><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg> Continue with Google</button>
           <p class="small faint">Keeps your handle, context and deals on every device. Already have Collab? This signs you back in.</p>
           <div class="or"><span>or start as a guest</span></div>`) : ""}
      <input class="field" name="name" placeholder="Your name" required maxlength="60" autocomplete="given-name" value="${esc(session.user?.displayName ?? "")}">
      <details class="more"><summary>Your Collab address (optional)</summary>
        <p class="small muted">Other people's agents reach yours at this handle. Leave it empty and one is made from your name.</p>
        <div class="row" style="flex-wrap:nowrap"><span class="faint">@</span><input class="field" name="handle" placeholder="handle" minlength="3" maxlength="24" autocapitalize="none" value="${esc(suggest.length >= 3 ? suggest : "")}"></div></details>
      <input class="field" name="area" placeholder="Your area (e.g. Indiranagar, Bengaluru)" value="Bengaluru">
      <p class="small faint">Only a neighbourhood is ever used — never your exact location.</p>
      <button class="btn accent">Start</button><p class="small" id="setup-err" style="color:var(--danger)"></p></form></div>`;
    // A QR visitor sees whose agent this is (public agent card: no sign-in needed), and their details load meanwhile.
    if (to) {
      fetch(`/a2a/${encodeURIComponent(to)}/.well-known/agent-card.json`).then(r => (r.ok ? r.json() : null)).then(card => {
        const box = $("#setup-to");
        if (!card || !box) return;
        const offers = (card.skills ?? []).filter(s => s.id?.startsWith("offer-")).slice(0, 3);
        box.innerHTML = `<span class="small">You're about to ask <b>${esc(card.name.replace(/'s agent.*$/, ""))}</b>'s agent (@${esc(to)}).</span>${offers.length ? `<span class="small muted">${offers.map(s => esc(s.name)).join(" · ")}</span>` : ""}`;
      }).catch(() => {});
      session.ready?.then(() => person(to));
    }
    const g = $("#google");
    if (g) g.onclick = async () => {
      busy(g, true, "Opening Google");
      try {
        if (!session.uid) await session.ready;
        const r = await session.google();
        if (r === "switched") { location.reload(); return; }
        if (r === "linked") {
          // A Google account that already has Collab elsewhere comes back with its identity.
          S.profile = await api("/api/me").catch(() => null);
          if (S.profile) { resolve(); return; }
          resolve(setup());
          return;
        }
        busy(g, false);
      } catch (err) { $("#setup-err").textContent = err.message; busy(g, false); }
    };
    $("#setup").onsubmit = async e => {
      e.preventDefault();
      const f = new FormData(e.target), b = e.submitter;
      busy(b, true, "Setting up");
      try {
        await session.ready;
        const typed = String(f.get("handle") ?? "").toLowerCase().trim();
        // No handle typed: one from the name, with a few digits; tried again with others if it's taken.
        const base = String(f.get("name")).toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "").slice(0, 16) || "me";
        for (let i = 0; ; i++) {
          const handle = typed || `${base}${Math.floor(100 + Math.random() * 900)}`;
          try { S.profile = await api("/api/me", { name: f.get("name"), handle, areaName: f.get("area") }); break; }
          catch (err) { if (typed || i >= 3 || !/taken/.test(err.message)) throw err; }
        }
        session.track("sign_up", { method: session.user?.isAnonymous ? "guest" : "google" });
        resolve();
      } catch (err) { $("#setup-err").textContent = err.message; busy(b, false); }
    };
  });
}

async function boot() {
  // Gemma on this device (and whether it can run here); then this device joins the account's devices.
  detectEngine().then(() => {
    paintSidebar(); startDevices().then(refreshServing).catch(() => {});
    // Gemma downloaded here: load and warm it in the background, once the app has settled.
    if (engine.here) setTimeout(() => warmGemma().then(() => { detectEngine().then(paintSidebar); }), 8000);
  });
  onDevices(() => { if (S.screen === "settings") paintContent(true); });
  // Offline: a banner, cached conversations, and (with the on-device model) answers from the notes on this device.
  refreshNotesCache();
  loadPolicy();
  // Back online: what was saved on this device while offline goes up (notes, chats), then everything refreshes.
  const catchUp = async () => { const n = await replayOutbox(api).catch(() => 0); if (n) toast(`Synced ${n} change${n === 1 ? "" : "s"} made offline.`); refreshNotesCache(); syncChats(); };
  addEventListener("online", () => { toast("Back online — syncing what you did offline."); catchUp().then(() => paint()); });
  addEventListener("offline", () => { toast(engine.here ? "Offline — Gemma answers questions about your notes on this device. New notes are saved here and sync later." : "Offline — showing what's saved on this device. New notes sync when you're back."); paint(); });
  if (navigator.onLine) catchUp();
  S.sessions = (await local.all("sessions")).map(s => ({ ...s, persisted: true })).sort((a, b) => b.updatedAt - a.updatedAt);
  S.current = S.sessions[0]?.id ?? null;
  syncChats();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncChats(); });
  root.innerHTML = `<div class="app" id="app">
    <aside class="sidebar" id="sidebar"></aside>
    <section class="main"><div class="topbar" id="topbar"></div><div class="content" id="content"></div>
      <div class="composer" id="composer"><form class="box" id="compose">
        <div class="bar"><input id="input" autocomplete="off" placeholder="Ask, find or offer anything…" aria-label="Message your agent"><label class="mic" for="photo-in" title="List something from a photo" aria-label="List something from a photo"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M9 4 7.2 6H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-3.2L15 4H9Zm3 5a4 4 0 1 1 0 8 4 4 0 0 1 0-8Z"/></svg></label><input type="file" id="photo-in" accept="image/*" hidden><button type="button" class="mic" id="mic" hidden aria-label="Speak instead of typing" title="Speak"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="currentColor" d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.9V21h2v-3.1A7 7 0 0 0 19 11h-2Z"/></svg></button><button class="send" id="send" aria-label="Send">↑</button></div>
        <div class="row" id="composer-note"></div></form></div></section>
      <aside class="panel" id="panel" hidden><div class="resizer" id="resizer" role="separator" aria-orientation="vertical" aria-label="Drag to resize" tabindex="0" title="Drag to resize · double-click to reset"></div><div class="topbar panel-top"><span id="panel-title"></span><button class="btn quiet compact close" data-act="screen" data-screen="chat" aria-label="Back to chat">✕</button></div><div class="content" id="panel-body"></div></aside></div>`;
  startPanel(paint);
  startResizer();
  // Sending stops the microphone first, so nothing it still hears is written back into the cleared box.
  $("#compose").onsubmit = e => { e.preventDefault(); const text = $("#input").value; stopVoice(); $("#input").value = ""; send(text); };
  voiceInput();
  $("#photo-in").onchange = e => { const f = e.target.files?.[0]; e.target.value = ""; if (f) sellFromPhoto(f); };
  // Google Pay opens inside the tap, before anything else runs (see openGooglePay); the rest of the payment follows.
  document.addEventListener("click", e => {
    const el = e.target.closest?.('[data-act="eng-pay"][data-gpay]');
    if (!el || el.disabled) return;
    e.stopPropagation(); e.preventDefault();
    const sheet = openGooglePay(Number(el.dataset.amount), el.dataset.item ?? "Collab", el.dataset.currency ?? "INR");
    sheet.then(googlePay => googlePay && payDeal(el, googlePay)).catch(err => toast(err.message, null, "error"));
  }, true);
  // The menu (phones) closes on a tap anywhere outside it, and that tap does nothing else; Escape closes it too.
  document.addEventListener("click", e => {
    const app = $("#app");
    if (!app?.classList.contains("nav-open") || e.target.closest?.(".sidebar, [data-act=\"nav\"]")) return;
    e.stopPropagation(); e.preventDefault();
    app.classList.remove("nav-open");
  }, true);
  document.addEventListener("keydown", e => { if (e.key === "Escape") $("#app")?.classList.remove("nav-open"); });
  document.addEventListener("click", onClick);
  document.addEventListener("change", onEdit);
  document.addEventListener("input", onEdit);
  document.addEventListener("keydown", e => {
    const f = e.target.dataset?.followup;
    if (f && e.key === "Enter") { e.preventDefault(); document.querySelector(`[data-act="eng-ask"][data-id="${CSS.escape(f)}"]`)?.click(); }
  });
  start(openScreen);
  startDevice();
  onChange(() => { paintSidebar(); paintContent(true); driveRequester(); if (toPay() && gpay.available === null) preloadGooglePay().then(ok => { if (!ok) paintContent(true); }); });
  // Notifications: a device that already allowed them registers again quietly (asking needs a tap — see Settings).
  session.push?.(false).then(() => paintSidebar()).catch(() => {});
  addEventListener("collab-installable", () => paintSidebar());
  paint();
}

// MARK: - Painting

function paint() { paintSidebar(); paintTop(); paintContent(); }

function paintSidebar() {
  const el = $("#sidebar");
  if (!el) return;
  const n = needsYouCount();
  const groups = groupSessions(S.sessions);
  const html = `<header>${brand()}<span class="end"><button class="engine-chip ${!navigator.onLine ? "offline" : engine.here ? "peri" : "accent"}" data-act="screen" data-screen="settings"
      title="Which AI runs your agent — tap for details">${!navigator.onLine ? `● Offline${engine.here ? " · Gemma on this device" : ""}` : `✦ ${engine.here && engine.mode !== "cloud-only" ? "Gemma · on this device" : "Powered by Gemini"}`}</button></span></header>
    <div class="scroll">
      ${n ? `<button class="btn accent needs" data-act="screen" data-screen="requests"><span class="dot pulse"></span> ${n} need${n === 1 ? "s" : ""} you »</button>` : ""}
      <button class="btn" data-act="new-chat">+ New chat</button>
      <div class="nav">
        ${navRow("requests", icon("activity"), "Activity", n ? String(n) : "")}
        ${navRow("receipts", icon("receipt"), "Receipts", "")}
        ${navRow("people", icon("card"), "My card", "")}
        ${navRow("context", icon("user"), "About me", "")}
        ${navRow("sharing", icon("shield"), "Privacy", "")}
        ${navRow("settings", icon("settings"), "Settings", "")}
      </div>
      ${groups.map(g => `<div class="stack" style="gap:4px">${label(g.title)}${g.items.map(s => `<button class="session ${S.screen === "chat" && s.id === S.current ? "on" : ""}" data-act="open-session" data-id="${esc(s.id)}">${esc(s.title)}</button>`).join("")}</div>`).join("") || `<p class="small faint">No chats yet. Every chat is kept here, on this device.</p>`}
    </div>
    <footer class="side-foot">
      <button class="linkish small" data-act="agent-card" style="text-align:left">@${esc(S.profile.handle)} · agent card ›</button>
      ${session.google && session.user?.isAnonymous ? `<button class="btn quiet compact" data-act="screen" data-screen="settings">Guest · keep it with Google</button>` : session.user?.email ? `<span class="small faint">${esc(session.user.email)}</span>` : ""}
      ${!standalone() ? `<button class="btn secondary compact" data-act="install">Install app</button>` : ""}
    </footer>`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

const navRow = (screen, ico, title, trail) => `<button class="${S.screen === screen ? "on" : ""}" data-act="screen" data-screen="${screen}"><span class="ico">${ico}</span>${title}<span class="trail">${esc(trail)}</span></button>`;

function groupSessions(list) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = today.getTime() / 1000;
  // A chat started with "Don't keep history" on is never listed: it lives only while it's open.
  list = list.filter(s => !s.incognito || s.id === S.current);
  const g = [{ title: "Today", items: list.filter(s => s.updatedAt >= t) }, { title: "Earlier", items: list.filter(s => s.updatedAt < t) }];
  return g.filter(x => x.items.length);
}

function paintTop() {
  const cur = S.sessions.find(s => s.id === S.current);
  const titles = { receipts: "Receipts", context: "About me", people: "My card", sharing: "Privacy", requests: "Activity", activity: "What your agent shared", settings: "Settings", communities: "Communities" };
  const detail = panelDetail();
  $("#topbar").innerHTML = `<button class="btn quiet compact menu" data-act="nav">☰</button>${label(cur?.title ?? "New chat", "sq ink")}
    <span class="end small faint">${S.incognito ? `<span class="tag ink" title="New chats aren't kept; nothing is remembered">◐ Not kept</span> ` : ""}@${esc(S.profile.handle)}</span>`;
  // The right panel shows a screen, or something opened from it (a deal, a pass, a log…) with a way back.
  $("#panel-title").innerHTML = detail ? `<button class="btn quiet compact" data-act="panel-close">‹ ${S.screen === "chat" ? "Close" : "Back"}</button>${label(detail.title, "sq ink")}`
    : S.screen === "chat" ? "" : `<button class="btn quiet compact menu" data-act="nav">☰</button>${label(titles[S.screen] ?? "", "sq ink")}`;
  $("#app").classList.toggle("split", S.screen !== "chat" || !!detail);
  $("#panel").hidden = S.screen === "chat" && !detail;
  $("#input").placeholder = cur?.to ? `Ask ${cur.toName ?? "their"}'s agent…` : "Ask, find or offer anything…";
  $("#composer-note").innerHTML = label("Your agent answers from your context · never your limits or contacts");
}

let painting = false, lastHTML = "", lastChat = undefined, lastCount = 0;
let again = null;
// A live repaint while a finger or mouse is down would replace the button being pressed, and the tap would be lost.
let pointerDown = false, afterPointer = false;
document.addEventListener("pointerdown", () => { pointerDown = true; }, true);
for (const ev of ["pointerup", "pointercancel"]) document.addEventListener(ev, () => { pointerDown = false; if (afterPointer) { afterPointer = false; setTimeout(() => paintContent(true), 0); } }, true);
/** Motion that means something: a new message or card rises in, one that changed (a counter, a payment) flashes once,
 *  and a screen opens in a short stagger. Animations are off (index.html sets data-motion="off"), so this marks nothing today. */
const seenAnim = new Map();
let lastScreen = null;
function animate(root, opened) {
  const on = document.documentElement.dataset.motion !== "off";
  if (on && opened) { root.classList.remove("screen-enter"); void root.offsetWidth; root.classList.add("screen-enter"); }
  for (const n of root.querySelectorAll("[data-anim]")) {
    const k = n.dataset.anim, sig = n.dataset.animSig ?? "";
    if (on && !opened && !seenAnim.has(k) && seenAnim.size) n.classList.add("enter");
    else if (on && seenAnim.has(k) && seenAnim.get(k) !== sig) n.classList.add("flash");
    seenAnim.set(k, sig);
  }
}

async function paintContent(soft = false) {
  const el = $("#content"), panel = $("#panel-body");
  if (!el) return;
  // One paint at a time; a paint asked for meanwhile runs right after (a hard one wins over a soft one).
  if (painting) { again = again === false ? false : soft; return; }
  // A live refresh never rewrites what the owner is typing, nor what's under a pressed pointer.
  if (soft && (el.contains(document.activeElement) || panel.contains(document.activeElement)) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  if (soft && pointerDown) { afterPointer = true; return; }
  painting = true;
  try {
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    const detail = panelDetail();
    // The chat and the screen beside it are drawn together; a screen that's slow to load (it reads from the server)
    // shows its frame at once when it was just opened, and fills in when its data arrives.
    const chatP = chatHTML().then(h => `<div class="inner">${h}</div>`);
    const sideP = detail ? Promise.resolve(`<div class="inner panel-body">${detail.render ? detail.render() : detail.html}</div>`)
      : S.screen === "chat" ? Promise.resolve("") : screens[S.screen].html(S).then(h => `<div class="inner">${h}</div>`);
    if (!soft && !detail && S.screen !== "chat" && S.screen !== lastScreen
      && !(await Promise.race([sideP.then(() => true, () => true), new Promise(r => setTimeout(() => r(false), 120))]))) {
      panel.innerHTML = `<div class="inner">${screenLoading(S.screen)}</div>`; lastHTML = "";
    }
    const [chat, side] = await Promise.all([chatP, sideP]);
    const html = chat + "\u0000" + side;
    // Nothing changed: leave the page as it is (no flicker, nothing under the pointer replaced).
    if (soft && html === lastHTML) return;
    const chatChanged = chat !== lastHTML.split("\u0000")[0];
    lastHTML = html;
    if (chatChanged || !soft) el.innerHTML = chat;
    panel.innerHTML = side;
    animate(S.screen === "chat" ? el : panel, S.screen !== lastScreen && !panelDetail()); lastScreen = S.screen;
    // The chat follows a new message (or a newly opened chat) to the bottom; a card being filled in, answered or updated
    // stays where the owner is looking.
    const cur = S.sessions.find(x => x.id === S.current), count = cur?.messages?.length ?? 0, newChat = S.current !== lastChat;
    if (chatChanged && (newChat || count > lastCount || (nearBottom && soft && count === lastCount && !el.contains(document.activeElement)))) el.scrollTop = el.scrollHeight;
    lastChat = S.current; lastCount = count;
    if (!soft && (S.screen !== "chat" || panelDetail())) panel.scrollTop = 0;
    if (S.focus) { document.querySelector(`[data-engagement="${CSS.escape(S.focus)}"]`)?.scrollIntoView({ block: "center" }); S.focus = null; }
  } finally {
    painting = false;
    if (again !== null) { const next = again; again = null; paintContent(next); }
  }
}

const SCREEN_TITLES = { receipts: "Receipts", context: "About me", people: "My card", sharing: "Privacy", requests: "Activity", activity: "What your agent shared", settings: "Settings", communities: "Communities" };
/** A screen's frame while its data loads: the same title and blocks where its cards will be. */
const screenLoading = screen => `<div class="stack" style="gap:6px">${label(SCREEN_TITLES[screen] ?? "", "sq")}<div class="skel-line" style="width:62%;height:34px"></div></div>
  <div class="stack">${[96, 160, 120].map(h => `<div class="card skel-card" style="height:${h}px"></div>`).join("")}</div>`;

// Saved-note cards show the note as it is now (it may have moved tier on another screen); fetched at most every 20 s.
let factsCache = null;
function savedFacts() {
  if (!factsCache || Date.now() - factsCache.at > 20_000) factsCache = { at: Date.now(), map: cached("/api/facts").then(fs => new Map(fs.map(f => [f.id, f]))).catch(() => new Map()) };
  return factsCache.map;
}

async function chatHTML() {
  const cur = S.sessions.find(s => s.id === S.current);
  if (!cur || !cur.messages.length) return emptyChat();
  refreshStoreCard(cur);
  // A listing being made gets its terms suggested at once, in the background (see prefillTerms).
  cur.messages.forEach(m => (m.cards ?? []).forEach((c, i) => {
    if (c.type === "offer" && c.step === "review" && c.offer && !c.termsTried && !c.terms?.length) prefillTerms(cur.id, m.id, i);
    if (c.type === "offer" && c.step === "review" && c.missing?.length && c.answersTried !== ANSWERS_V && c.answersTried !== "draft") prefillAnswers(cur.id, m.id, i);
  }));
  if (cur.messages.some(m => m.cards?.some(c => c.type === "saved"))) {
    const facts = await savedFacts();
    for (const m of cur.messages) for (const c of m.cards ?? []) if (c.type === "saved") c.fact = facts.get(c.factId) ?? c.fact;
  }
  // Matches: "Fits you" reasons come from the private notes kept on this device, read here and never sent anywhere.
  if (cur.messages.some(m => m.cards?.some(c => c.type === "brief" && c.step === "matches"))) setNotesHere(await cachedNotes());
  for (const m of cur.messages) for (const c of m.cards ?? []) if (c.type === "offer" && c.basics && !c.offer) priceHintsFor(c, cur);
  return cur.messages.map(messageHTML).join("");
}

/** First visit: three lines on how it works, dismissed with one tap (kept on this device). */
function howItWorks() {
  try { if (localStorage.getItem("collab.intro") === "done") return ""; } catch {}
  return `<div class="card intro"><div class="row">${label("How it works", "sq accent")}<button class="linkish small faint end" data-act="intro-done">Got it</button></div>
    <div class="steps-plain"><div><b>1</b><span>Say what you need</span></div><div><b>2</b><span>Agents ask and bargain</span></div><div><b>3</b><span>You confirm, pay, collect</span></div></div></div>`;
}

/** The start of a chat: one question, your words, and a few things your agent thinks you might want next. */
let startIdeas = null;
function emptyChat() {
  // Shown at once from this device's last copy, then refreshed in the background.
  if (startIdeas === null) {
    try { startIdeas = JSON.parse(localStorage.getItem(`collab.start.${session.uid}`) ?? "[]"); } catch { startIdeas = []; }
    cached("/api/start", 120_000).then(r => { const fresh = r.ideas ?? []; try { localStorage.setItem(`collab.start.${session.uid}`, JSON.stringify(fresh)); } catch {}
      const changed = JSON.stringify(fresh) !== JSON.stringify(startIdeas); startIdeas = fresh; if (changed && S.screen === "chat") paintContent(true); }).catch(() => {});
  }
  const ideas = startIdeas ?? [];
  return `${howItWorks()}<div class="start">
    <span class="label sq">step 1 of 2 · say it in your words</span>
    <div class="row start-who">${avatarHTML(S.profile.name, S.profile.handle, 36)}<span class="label">your agent</span></div>
    <h1 class="headline">What are you looking for right now?</h1>
    <p class="muted">Something you need, something you offer, or a note to remember. Your agent takes it from there.</p>
    ${ideas.length ? `<div class="start-ideas">${ideas.map(i => `<button class="chip" data-act="send-text" data-text="${esc(i.text)}" title="${esc(i.text)}">${esc(i.label)}</button>`).join("")}</div>` : `<div class="start-ideas loading" aria-label="Finding ideas for you">${[92, 128, 110, 140].map(w => `<span class="chip skel" style="width:${w}px"></span>`).join("")}</div>`}
    ${privacyCard()}</div>`;
}

/**
 * Sell from a photo: made small on the phone (longest side 1024 px, JPEG), read by Gemini into a listing sentence,
 * then the usual listing card (with the photo on it) — the seller still sets the price and publishes. What's typed in
 * the box goes with it as a caption ("₹450, two available").
 */
async function sellFromPhoto(file) {
  const input = $("#input"), caption = input.value.trim();
  // Some phone galleries send no type at all: the name decides then, and decoding it is the real test.
  if (file.type ? !/^image\//.test(file.type) : !/\.(jpe?g|png|webp|heic|heif|gif|bmp)$/i.test(file.name)) return toast("That isn't a photo. Choose a JPEG, PNG or WebP.", null, "error");
  // The photo shows at once, with what's happening to it, in the chat — not a toast that vanishes.
  let cur = S.sessions.find(s => s.id === S.current && !s.to);
  if (!cur) { cur = { id: id(), title: "From a photo", messages: [], updatedAt: now() }; S.current = cur.id; }
  const preview = URL.createObjectURL(file);
  const msg = { id: id(), role: "agent", text: "", at: now(), pending: "calibrating", photo: preview, cards: [] };
  cur.messages.push(msg); toChat(); paint();
  const fail = async why => { msg.pending = null; msg.text = `${why} Type what it is instead, or try a closer, brighter photo.`; msg.cards = [{ type: "suggest", options: [{ label: "Try another photo", text: "" }], hint: "" }]; await saveSession(cur); paint(); };
  try {
    const bmp = await decodePhoto(file), w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight, k = Math.min(1, 1024 / Math.max(w, h));
    const cv = Object.assign(document.createElement("canvas"), { width: Math.round(w * k), height: Math.round(h * k) });
    cv.getContext("2d").drawImage(bmp, 0, 0, cv.width, cv.height);
    const image = cv.toDataURL("image/jpeg", 0.82);
    const r = await api("/api/offers/photo", { image, mimeType: "image/jpeg", caption });
    input.value = "";
    cur.messages = cur.messages.filter(m => m !== msg); await saveSession(cur);
    // The preview is the copy on this phone: the server shows the photo to others only once it's on a public listing.
    const small = URL.createObjectURL(await new Promise(ok => cv.toBlob(ok, "image/jpeg", 0.82)));
    if (!(await publicIntake(r.text, null, { id: r.photo.id, url: small, condition: r.condition }))) await fail("Couldn't make a listing from that.");
  } catch (err) { await fail(err.status === 422 ? "Couldn't tell what's in the photo." : err.status === 413 ? "That photo is too large." : (err.message || "Couldn't read that photo.")); }
}

/** A phone photo as something a canvas can draw: upright (as the camera held it), and through the browser's own image
 *  decoder when the quick one can't read the format (some phones' HEIC). */
async function decodePhoto(file) {
  try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* try the image decoder */ }
  const url = URL.createObjectURL(file);
  try { const img = new Image(); img.src = url; await img.decode(); return img; }
  catch { throw Object.assign(new Error("This phone saved the photo in a format the browser can't open — try a screenshot of it, or a JPEG."), { status: 415 }); }
  finally { setTimeout(() => URL.revokeObjectURL(url), 5000); }
}

/** Stops listening and drops whatever the recogniser still sends (set by voiceInput). */
let stopVoice = () => {};
/** Speak instead of typing: the browser's own speech recognition (Indian English, or Hindi when the device is set to
 *  Hindi) fills the message box; nothing is sent until the owner taps send. Hidden where the browser can't. */
function voiceInput() {
  const Rec = window.SpeechRecognition || window.webkitSpeechRecognition, mic = $("#mic"), input = $("#input");
  if (!Rec || !mic) return;
  mic.hidden = false;
  let rec = null;
  stopVoice = () => { if (!rec) return; const r = rec; rec = null; r.onresult = null; mic.classList.remove("on"); try { r.abort(); } catch { /* already stopped */ } };
  mic.onclick = () => {
    if (rec) { rec.stop(); return; }
    const r = rec = new Rec();
    r.lang = /^hi\b/i.test(navigator.language) ? "hi-IN" : "en-IN";
    r.interimResults = true;
    const before = input.value.trim();
    r.onresult = ev => { if (rec !== r) return; input.value = [before, [...ev.results].map(x => x[0].transcript).join(" ")].filter(Boolean).join(" "); };
    r.onerror = ev => {
      if (ev.error === "aborted" || ev.error === "no-speech") return;
      toast(ev.error === "not-allowed" ? "Allow the microphone to speak your message."
        : ev.error === "service-not-allowed" ? "Voice isn't available in this app here — tap the text box and use your keyboard's mic."
        : ev.error === "network" ? "Voice needs a connection — try again, or type it."
        : ev.error === "audio-capture" ? "No microphone found." : "Couldn't hear that — try again.", null, "error");
    };
    r.onend = () => { if (rec === r) { rec = null; mic.classList.remove("on"); input.focus(); } };
    mic.classList.add("on");
    try { r.start(); } catch { rec = null; mic.classList.remove("on"); toast("Voice isn't available here — type it, or use your keyboard's mic.", null, "error"); }
  };
}

/** Stored / read by / shared — three lines, with the levels one tap away. */
function privacyCard() {
  return `<div class="card slim privacy-facts"><dl class="kv">${privacyFacts(engine.mode).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl>
    <details class="more"><summary>Who sees what</summary><dl class="kv small"><dt>${tag("Private", "peri")}</dt><dd>Only your agent uses it.</dd>
      <dt>${tag("Protected", "accent")}</dt><dd>People your rules name, on their topics.</dd><dt>${tag("Public", "fresh")}</dt><dd>Anyone's agent. What you offer.</dd></dl></details></div>`;
}

// MARK: - Direct chats (QR codes and links)

/** A chat with one person's or shop's agent, opened by scanning their QR code (or a /?to=handle link). */
const people = new Map();
/** Someone's public profile, offerings (with stock and free times) and questions — one request per 30 s however many ask. */
function person(handle, fresh = false) {
  handle = String(handle).replace(/^@/, "").toLowerCase();
  const hit = people.get(handle);
  if (hit && !fresh && Date.now() - hit.at < 30_000) return hit.p;
  const p = api(`/api/people/${encodeURIComponent(handle)}`).catch(() => { people.delete(handle); return null; });
  people.set(handle, { at: Date.now(), p });
  return p;
}
const storeCardOf = p => ({ type: "store", profile: p.profile, facts: p.facts, suggestions: p.suggestions ?? [], shop: p.shop ?? null, paused: !!p.paused, record: p.record ?? null });

/** A conversation's saved card shows what they offer now (stock, free times): refreshed whenever the chat is shown. */
const refreshedCards = new Set();
function refreshStoreCard(cur) {
  if (!cur?.to || refreshedCards.has(cur.id)) return;
  refreshedCards.add(cur.id);
  setTimeout(() => refreshedCards.delete(cur.id), 30_000);
  person(cur.to).then(async p => {
    if (!p) return;
    const m = cur.messages.find(x => x.cards?.some(c => c.type === "store"));
    if (!m) return;
    m.cards = m.cards.map(c => (c.type === "store" ? storeCardOf(p) : c));
    await saveSession(cur);
    if (S.current === cur.id) paintContent(true);
  });
}

/** Still waiting for suggested terms (a request older than a minute, say from before a reload, has ended). */
const termsBusy = c => !!c.termsLoading && Date.now() - c.termsLoading < 60_000;

/** A card as it is now (the session may have been saved or synced since a request started). */
function cardAt(sid, mid, i) { const s = S.sessions.find(x => x.id === sid), m = s?.messages.find(x => x.id === mid); return m?.cards?.[i] ? { s, m, c: m.cards[i] } : null; }

/**
 * Terms for a listing, suggested from what others offering the same thing state on the web — started as soon as the
 * listing card appears (or again on request), and written to the card whatever the owner opens or closes meanwhile.
 * Never over terms the owner already wrote.
 */
async function prefillTerms(sid, mid, i, again = false) {
  const f = cardAt(sid, mid, i);
  if (!f || termsBusy(f.c) || (!again && (f.c.termsTried || f.c.terms?.length))) return;
  Object.assign(f.c, { termsTried: true, termsLoading: Date.now() });
  await saveSession(f.s); paintContent(true);
  const r = await api("/api/terms/suggest", { category: f.c.offer?.category ?? "", text: f.c.publicText ?? f.c.text, ownerPays: ownerPays(f.c) }).catch(() => null);
  const now_ = cardAt(sid, mid, i);
  if (!now_) return;
  now_.c.termsLoading = false;
  if (r?.terms?.length && (again || !now_.c.terms?.length)) now_.c.terms = r.terms;
  // The common terms for this kind of offering, to tap in — minus any already there.
  const have = new Set((now_.c.terms ?? []).map(t => t.label.trim().toLowerCase()));
  if (r) now_.c.starters = (r.starters ?? []).filter(t => !have.has(t.label.toLowerCase()));
  if (again && r && !r.terms?.length && !now_.c.starters?.length) toast("Couldn't suggest terms just now — write your own.");
  await saveSession(now_.s); paintContent(true);
}

/** Bumped when suggestions change, so cards made earlier (whose first try came back empty) ask once more. */
const ANSWERS_V = 2;

/** Likely answers to the listing's common questions, suggested by Gemini from its words; the owner accepts them. */
async function prefillAnswers(sid, mid, i) {
  const f = cardAt(sid, mid, i);
  if (!f || f.c.answersTried === ANSWERS_V) return;
  f.c.answersTried = ANSWERS_V; await saveSession(f.s);
  const r = await api("/api/offers/answers", { text: f.c.publicText ?? f.c.text, questions: f.c.missing.map(m => ({ label: m.label, ask: m.ask, options: m.options ?? [] })) }).catch(() => null);
  const now_ = cardAt(sid, mid, i);
  if (!now_ || !r?.answers) return;
  // "answer\u0000guess" marks a guess (the words said nothing); otherwise the words implied it.
  const remembered = Object.fromEntries(Object.entries(now_.c.suggestedAnswers ?? {}).filter(([k]) => now_.c.fromMemory?.[k]));
  now_.c.suggestedAnswers = { ...Object.fromEntries(Object.entries(r.answers).map(([k, v]) => [k, String(v).split("\u0000")[0]])), ...remembered };
  now_.c.guessedAnswers = Object.fromEntries(Object.entries(r.answers).filter(([, v]) => String(v).includes("\u0000")).map(([k]) => [k, true]));
  await saveSession(now_.s); paintContent(true);
}

/** A pass (from its link: "/pickup.html#<id>.<code>") in a modal: the buyer sees the code to show, the seller marks it done. */
async function openPass(path) {
  const [pid, code] = new URL(path, location.origin).hash.slice(1).split(".");
  const link = `${location.origin}/pickup.html#${pid}.${code}`, missing = "This pass doesn't exist or its link is incomplete.";
  const load = async () => {
    if (!pid || !code) throw new Error(missing);
    const r = await fetch(`/public/pickup/${encodeURIComponent(pid)}?code=${encodeURIComponent(code)}`, { cache: "no-store" });
    const d = await r.json().catch(() => ({ error: "pass not found" }));
    if (!r.ok) throw new Error(d.error === "pass not found" ? missing : d.error);
    return d;
  };
  let d;
  try { d = await load(); } catch (err) { return toast(err.message, null, "error"); }
  // The seller by account, not handle (a handle can change after the deal); a pass scanned from someone else's deal
  // falls back to the handle the server reports as the seller's current one.
  const eng = live.engagements.get(pid);
  const seller = eng ? eng[eng.seller ?? "provider"].uid === session.uid : d.sellerHandle === S.profile.handle;
  const qr = seller ? "" : await passQR(link);
  const body = () => passHTML(d, { qr, seller, link, manage: !!eng });
  const o = { querySelector: s => document.querySelector(`#panel ${s}`), remove: closePanel };
  const draw = () => paintContent(true);
  // Changing or cancelling a booking, from the pass: the result is the same pass, redrawn.
  const booking = async body => {
    const x = await api(`/api/engagements/${encodeURIComponent(pid)}/booking`, body);
    live.engagements.set(x.id, x); d = await load(); draw(); refresh(openScreen);
  };
  openPanel({ title: passKind(d).name, render: body, handle: async e => {
    if (e.target.closest('[data-act="pass-move"]')) {
      const box = o.querySelector(".pass-times");
      box.innerHTML = `${logo("live spinner")}`;
      const r = await api(`/api/engagements/${encodeURIComponent(pid)}/slots`).catch(err => ({ slots: [], error: err.message }));
      const label_ = sl => new Date(sl.start * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: r.timezone ?? undefined });
      box.innerHTML = r.slots?.length ? r.slots.slice(0, 8).map(sl => `<button class="chip" data-act="pass-move-to" data-slot="${esc(sl.id)}">${esc(label_(sl))}</button>`).join("") : `<span class="small muted">${esc(r.error ?? "No other free times right now.")}</span>`;
      return;
    }
    const to = e.target.closest('[data-act="pass-move-to"]');
    if (to) { busy(to, true); try { await booking({ action: "move", slotId: to.dataset.slot }); toast("Booking moved. They've been told."); } catch (err) { busy(to, false); toast(err.message, null, "error"); } return; }
    if (e.target.closest('[data-act="pass-cancel"]')) {
      if ((await ask({ title: "Cancel this booking?", detail: "The time is freed for others, and they're told.", ok: "Cancel booking", cancel: "Keep it", danger: true })) === null) return;
      try { await booking({ action: "cancel" }); toast("Booking cancelled."); } catch (err) { toast(err.message, null, "error"); }
      return;
    }
    const copy = e.target.closest('[data-act="pass-copy"]');
    if (copy) { await navigator.clipboard.writeText(copy.dataset.link).catch(() => {}); return toast("Link copied — keep it private."); }
    const b = e.target.closest('[data-act="pass-collect"]');
    if (!b) return;
    busy(b, true);
    try { await api(`/api/pickup/${encodeURIComponent(pid)}/collect`, { code }); d = await load(); draw(); toast(`${passKind(d).done}. They're asked to confirm.`); refresh(openScreen); }
    catch (err) {
      d = await load().catch(() => d); draw();
      o.querySelector(".pass")?.insertAdjacentHTML("afterend", `<p class="small" role="alert" style="color:var(--danger);margin:0">${esc(err.message)}</p>`);
      refresh(openScreen);
    }
  } });
}

/** A conversation in the side panel (its card, live: redrawn on every refresh while it's open). */
function showEngagement(id) {
  const e = live.engagements.get(id);
  if (!e) return toast("That conversation isn't loaded yet.");
  const them = e.requester.uid === session.uid ? e.provider : e.requester;
  S.panelEng = id; S.panelLog = null;
  openPanel({ title: `Your agent ⇄ ${them.name}'s agent`, render: () => { const x = live.engagements.get(id); return x ? `<span class="small faint">The two agents work it out between them. This isn't a chat with ${esc(them.name)}.</span>${engagementCard(x, x.id)}` : ""; } });
}

/** What the agents said, as a stream: one conversation, or every conversation, newest last, with filters. */
function logStream(ids, filter = "all") {
  const mine = e => (e.requester.uid === session.uid ? "requester" : "provider");
  const rows = [];
  for (const id of ids) {
    const e = live.engagements.get(id); if (!e) continue;
    const side = mine(e), them = side === "requester" ? e.provider : e.requester;
    const state = e.phase === "agreed" ? "won" : ["closed", "declined"].includes(e.phase) ? "lost" : "open";
    if (filter !== "all" && filter !== state) continue;
    for (const ev of e.events) rows.push({ at: ev.at, who: ev.who, text: ev.text, by: ev.by, them: them.name, id: e.id, side, state });
  }
  rows.sort((a, b) => a.at - b.at);
  const who = r => (r.who === "system" ? "" : r.who.startsWith(r.side) ? (r.who.endsWith("_agent") ? "your agent" : "you") : `${r.them.split(" ")[0]}'s agent`);
  const kind = r => (r.who === "system" ? "note" : /offer|counter|\₹|price/i.test(r.text) ? "propose" : /confirm|agreed|accept/i.test(r.text) ? "accept" : /declin|walk|no deal|end/i.test(r.text) ? "decline" : "say");
  return rows.length ? rows.map(r => `<div class="lg ${r.who === "system" ? "sys" : r.who.startsWith(r.side) ? "me" : "them"}"><span class="lg-t">${new Date(r.at * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false })}</span>
    <span class="lg-who">${ids.length > 1 ? `<span class="lg-name">${esc(r.them.split(" ")[0])}</span> ` : ""}${esc(who(r))}${r.who === "system" ? "" : ` → <span class="lg-kind ${kind(r)}">${kind(r)}</span>`}</span>
    <span class="lg-text">${esc(r.text)}</span></div>`).join("") : `<p class="small muted">Nothing here yet.</p>`;
}
function showLog(id = null) {
  const ids = id ? [id] : [...live.engagements.keys()];
  S.panelLog = { id, filter: S.panelLog?.id === id ? S.panelLog.filter ?? "all" : "all" }; S.panelEng = null;
  const draw = () => {
    const f = S.panelLog.filter, n = ids.map(x => live.engagements.get(x)).filter(Boolean);
    const won = n.filter(e => e.phase === "agreed").length, lost = n.filter(e => ["closed", "declined"].includes(e.phase)).length, open = n.length - won - lost;
    return `<div class="row small"><span class="muted"><b>${n.length}</b> conversation${n.length === 1 ? "" : "s"} · ${won} ✓ · ${lost} ✕ · ${open} open</span>
      <span class="seg end">${[["all", "all"], ["won", "won"], ["lost", "lost"], ["open", "open"]].map(([k, t]) => `<button class="${f === k ? "on" : ""}" data-act="log-filter" data-k="${k}">${t}</button>`).join("")}</span></div>
      <div class="lg-stream">${logStream(ids, f)}</div>`;
  };
  const e = id ? live.engagements.get(id) : null, them = e ? (e.requester.uid === session.uid ? e.provider : e.requester).name : null;
  openPanel({ title: them ? `Agent log · ${them}` : "Agent log", render: draw, handle: ev => { const b = ev.target.closest('[data-act="log-filter"]'); if (b) { S.panelLog.filter = b.dataset.k; paintContent(true); } } });
  const body = document.querySelector("#panel .lg-stream"); if (body) body.scrollTop = body.scrollHeight;
}

/** The owner's own card, as customers see it — nothing can be sent from it. */
async function previewCard(el = null) {
  if (el) busy(el, true, "Loading");
  const p = await person(S.profile.handle, true);
  if (el) busy(el, false);
  if (!p) return toast("Couldn't load your card.");
  openPanel({ title: "Your card, as others see it", html: storeCard(storeCardOf(p), { preview: true }) });
}

/** Your A2A agent card — how any agent finds and talks to yours — shown readably, with the JSON one tap away. */
/**
 * Install Collab as an app: the browser's own prompt where there is one (Chrome, Edge, Android); otherwise the steps for
 * this device, since an iPhone never offers a prompt — Safari's Share › Add to Home Screen is the only way.
 */
async function installApp() {
  if (standalone()) return toast("Collab is already installed — you're in the app.", null, "success");
  if (session.install) { if (await session.install()) toast("Installed — open Collab from your home screen or apps.", null, "success"); return paint(); }
  const ua = navigator.userAgent, iphone = ios(), android = /android/i.test(ua), crios = /crios|fxios|edgios/i.test(ua);
  const share = `<svg class="icon" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v13"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>`;
  const steps = iphone ? [crios ? `Tap ${share} <b>Share</b> (top right in Chrome, or open this page in Safari)` : `Tap ${share} <b>Share</b> — in Safari it's under <b>⋯</b> at the bottom`, "Scroll and choose <b>Add to Home Screen</b>", "Keep <b>Open as Web App</b> on, then tap <b>Add</b>", "Open Collab from your home screen — notifications on iPhone only work there"]
    : android ? ["Tap <b>⋮</b> at the top right of Chrome", "Choose <b>Install app</b> (or <b>Add to Home screen</b>)", "Tap <b>Install</b>, then open Collab from your home screen"]
    : ["Click the install icon at the right of the address bar — or <b>⋮</b> › <b>Cast, save and share</b> › <b>Install page as app</b>", "Click <b>Install</b>", "Collab opens in its own window and in your apps"];
  openPanel({ title: "Install Collab", html: `<div class="card install-card"><div class="row" style="gap:12px">${logo()}<div class="stack" style="gap:2px"><b>Collab on your ${iphone ? "iPhone" : android ? "phone" : "computer"}</b><span class="small muted">Opens like an app, works offline, and tells you when your agent needs you.</span></div></div>
    <ol class="install-steps">${steps.map(x => `<li>${x}</li>`).join("")}</ol></div>` });
}

async function showAgentCard() {
  const url = `${location.origin}/a2a/${S.profile.handle}/.well-known/agent-card.json`, link = `${location.origin}/?to=${encodeURIComponent(S.profile.handle)}`;
  const [c, rec, facts] = await Promise.all([fetch(url).then(r => r.json()).catch(() => null),
    cached(`/public/people/${encodeURIComponent(S.profile.handle)}/record`, 60_000).catch(() => null), cached("/api/facts").catch(() => [])]);
  if (!c) return toast("Couldn't load your agent card.");
  // What any agent reading the card learns, said plainly: who, its record, what it can do, what's on offer, what it never says.
  const offers = facts.filter(f => f.tier === "public" && f.offer && f.offer.status !== "sold");
  const examples = (c.skills ?? []).find(x => x.id === "engage")?.examples ?? [];
  const ap2 = (c.capabilities?.extensions ?? []).some(x => /AP2/.test(x.uri ?? ""));
  const caps = ["Answers questions from what you share", "Asks you what it can't answer", "Negotiates inside your private limits",
    offers.some(f => f.offer.instant) ? "Takes bookings at your price" : null, ap2 ? "Test payments (AP2)" : null, c.capabilities?.streaming ? "Live updates" : null].filter(Boolean);
  const since = rec?.since ? new Date(rec.since * 1000).toLocaleDateString([], { month: "short", year: "numeric" }) : null;
  openPanel({ title: "Your agent card", html: `
    <div class="card"><div class="ac-head">${avatarHTML(S.profile.name, S.profile.handle, 48)}<div class="stack" style="gap:2px;min-width:0"><b style="font-size:18px">${esc(S.profile.name)}'s agent</b>
      <span class="small faint">@${esc(S.profile.handle)}${S.profile.area?.name ? ` · ${esc(S.profile.area.name)}` : ""} · A2A ${esc(c.supportedInterfaces?.[0]?.protocolVersion ?? "1.0")}${c.signatures?.length ? " · signed" : ""}</span></div></div>
      ${S.profile.bio ? `<span class="small muted">${esc(S.profile.bio)}</span>` : ""}
      <div class="share-stats"><div><b>${rec?.verified ?? 0}</b><span>verified deals</span></div><div><b>${rec?.handedOver ?? 0}</b><span>handed over</span></div><div><b>${rec?.problems ?? 0}</b><span>problems</span></div></div>
      ${since ? `<span class="small faint">On Collab since ${esc(since)} · from signed receipts — no names or prices</span>` : `<span class="small faint">Your record grows with every signed receipt.</span>`}
      <div class="row"><button class="btn accent compact" data-act="share-link" data-link="${esc(link)}">Share</button><button class="btn secondary compact" data-act="copy" data-text="${esc(url)}">Copy card link</button><button class="btn quiet compact" data-act="copy" data-text="${esc(JSON.stringify(c, null, 2))}">Copy JSON</button></div></div>
    ${label("What it can do", "sq")}<div class="ac-caps">${caps.map(x => `<span>${esc(x)}</span>`).join("")}</div>
    ${offers.length ? `${label(`On offer · ${offers.length}`, "sq")}<div class="card slim">${offers.slice(0, 8).map(f => `<div class="ac-offer"><b class="small">${esc(f.offer.title.split(" · ")[0].replace(/\bI(phone|pad)\b/gi, (_, w) => "i" + w[0].toUpperCase() + w.slice(1).toLowerCase()))}</b><span class="small">${f.offer.price?.amount != null ? money(f.offer.price.amount, f.offer.price.period, f.offer.price.currency) : ""}</span></div>`).join("")}</div>` : ""}
    ${examples.length ? `${label("Other agents can ask", "sq")}<div class="ac-caps">${examples.slice(0, 4).map(x => `<span>“${esc(x)}”</span>`).join("")}</div>` : ""}
    <div class="card slim">${label("Never shares", "peri")}<span class="small muted">Your lowest price or budget, money in your private notes, your phone, e-mail or exact address, and any note you set to “never use”.</span></div>
    <details class="more"><summary>For developers · agent card JSON</summary><span class="small faint">Any A2A agent reads it at <a href="${esc(url)}" target="_blank" rel="noopener">this address</a>.</span><pre>${esc(JSON.stringify(c, null, 2))}</pre></details>` });
}

async function openDirect(handle) {
  handle = String(handle).replace(/^@/, "").toLowerCase();
  const p = await person(handle);
  if (!p) return toast(`No one is called @${handle}.`);
  if (p.profile.uid === session.uid) return previewCard();
  const card = storeCardOf(p);
  let cur = S.sessions.find(x => x.to === handle);
  if (!cur) {
    cur = { id: id(), title: `${p.profile.name} (@${handle})`, to: handle, toName: p.profile.name, updatedAt: now(),
      messages: [{ id: id(), role: "agent", text: "", at: now(), cards: [card] }] };
    await saveSession(cur);
  } else {
    // Scanned again: their card shows what they offer now.
    const m = cur.messages.find(x => x.cards?.some(c => c.type === "store"));
    if (m) { m.cards = m.cards.map(c => (c.type === "store" ? card : c)); await saveSession(cur); }
  }
  S.current = cur.id;
  openScreen("chat");
  timing("qr_card");
}

/**
 * Load times from real devices: how long after the page started the start screen, the app or a QR card showed.
 * Sent to Analytics once each per visit (event "load_timing", milliseconds), so slow phones and networks show up.
 */
const timed = new Set();
function timing(what) {
  if (timed.has(what)) return;
  timed.add(what);
  const ms = Math.round(performance.now());
  try { performance.mark(`collab:${what}`); } catch {}
  setTimeout(() => session.track("load_timing", { what, ms, first_visit: !!session.fresh, installed: standalone() }), 0);
}

/** In a direct chat, what you type goes to their agent (the first message opens the conversation). */
async function sendDirect(cur, text, offerFactId = null) {
  const open = cur.engagementId ? live.engagements.get(cur.engagementId) : null;
  const sameOffer = !offerFactId || !open || open.offer?.factId === offerFactId;
  const e = open && sameOffer && !["agreed", "closed", "declined"].includes(open.phase)
    ? await api(`/api/engagements/${open.id}/ask`, { text })
    : await api(`/api/people/${encodeURIComponent(cur.to)}/ask`, { text, ...(offerFactId ? { offerFactId } : {}) });
  cur.engagementId = e.id;
  live.engagements.set(e.id, e);
  // One live card per conversation: it moves to the latest message.
  for (const m of cur.messages) m.cards = (m.cards ?? []).filter(c => !(c.type === "engagement" && c.id === e.id));
  run(e.id);
  // Say what happened: an offer made, a counter back, a deal done — not just "asked".
  const who = cur.toName ?? "their", mine = e.requester.uid === session.uid ? "requester" : "provider", d = e.negotiation?.deal;
  const said = e.phase === "agreed" ? `Done — ${dealAmount(e)}, confirmed by both of you. Pay below to get your pass.`
    : e.phase === "deal" && d && e.negotiation.dealBy === mine ? `Offered ${dealAmount(e)} — ${who}'s agent answers within their limits, or ${who} does.`
    : e.phase === "deal" && d ? `${who}'s agent countered: ${dealAmount(e)}. Take it, offer another price, or walk away.`
    : `Asked ${who}'s agent.`;
  return { text: said, cards: [{ type: "engagement", id: e.id }] };
}

/** Rules read from words in a conversation, waiting for the owner's confirmation (by conversation). */
const pendingRules = new Map();

/** The AP2 payment step (after Google Pay's sheet, when used). One idempotency key per button: a retry can't pay twice. */
async function payDeal(el, googlePay, a = "eng-pay") {
  busy(el, true, a === "eng-pay" ? "Paying" : "Saving");
  try {
    const body = a === "eng-pay" ? { idempotencyKey: el.dataset.key ??= crypto.randomUUID(), ...(googlePay ? { googlePay } : {}) } : {};
    const e = await api(`/api/engagements/${el.dataset.id}/${a === "eng-pay" ? "pay" : "paid-outside"}`, body);
    live.engagements.set(e.id, e);
    session.track(a === "eng-pay" ? "paid_test" : "paid_outside", { google_pay: !!googlePay });
    toast(a === "eng-pay" ? `Paid${googlePay ? " with Google Pay" : ""}. Your pass is ready.` : "Marked as paid outside the app.");
  } catch (err) { toast(err.message, null, "error"); busy(el, false); }
  return refresh(openScreen);
}

// MARK: - Ordering from someone's card

/** The stepper, the time chips and the offer box only change what the card's main button says. */
function shopControl(a, el) {
  const item = el.closest("[data-shop-item]");
  if (!item) return;
  if (a === "qty") {
    const input = item.querySelector(".qty"), max = Number(item.dataset.max) || 20;
    input.value = String(Math.min(max, Math.max(1, (Number(input.value) || 1) + Number(el.dataset.d))));
  }
  if (a === "shop-slot") {
    item.querySelectorAll('[data-act="shop-slot"]').forEach(c => c.classList.toggle("on", c === el));
    item.dataset.slot = el.dataset.slot; item.dataset.slotLabel = el.dataset.label;
  }
  if (a === "store-offer-open") { const box = item.querySelector(".offer-box"); box.hidden = !box.hidden; if (!box.hidden) box.querySelector("input")?.focus(); }
  shopLabels(item);
}
function shopLabels(item) {
  const price = Number(item.dataset.price), cur = item.dataset.currency || "INR", buy = item.querySelector('[data-act="store-order"]');
  if (!buy) return;
  if (buy.dataset.kind === "buy") {
    const max = Number(item.dataset.max) || 20, input = item.querySelector(".qty"), note = item.querySelector(".qty-note");
    // More than they have is set to what's there, and said — the box never shows a number the button won't order.
    if (Number(input.value) > max) { input.value = String(max); if (note) { note.hidden = false; note.textContent = item.dataset.stock ? `Only ${max} in stock.` : `Up to ${max} at a time.`; } }
    else if (note) note.hidden = true;
    const n = Math.min(max, Math.max(1, Number(input.value) || 1));
    buy.textContent = n > 1 ? `Buy ${n} for ${money(price * n, null, cur)}` : `Buy for ${money(price, null, cur)}`;
    item.querySelector('[data-d="1"]')?.toggleAttribute("disabled", n >= max);
    item.querySelector('[data-d="-1"]')?.toggleAttribute("disabled", n <= 1);
  } else if (item.dataset.slot) {
    buy.disabled = false;
    buy.textContent = `Book ${item.dataset.slotLabel} · ${money(price, null, cur)}`;
  }
}
document.addEventListener("input", e => { const item = e.target.closest?.("[data-shop-item]"); if (item && e.target.matches(".qty")) shopLabels(item); });

async function orderFromCard(a, el) {
  const item = el.closest("[data-shop-item]");
  if (!item) return;
  const max = Number(item.dataset.max) || 20, qtyInput = item.querySelector(".qty");
  const handle = item.dataset.handle, body = { offerFactId: item.dataset.fact, quantity: Math.min(max, Math.max(1, Number(qtyInput?.value) || 1)) };
  if (qtyInput) qtyInput.value = String(body.quantity); // what was sent is what the card shows
  if (item.dataset.slot) body.slotId = item.dataset.slot;
  if (a === "store-offer-send") {
    const v = Number(item.querySelector("[data-offer-price]")?.value), max = Number(item.querySelector("[data-offer-max]")?.value);
    if (!(v > 0)) return toast("Type the price you'd like to pay.");
    body.price = v;
    if (max > 0) { if (max < v) return toast("“Up to” is the most you'd pay — at least your offer."); body.max = max; }
  }
  busy(el, true, "Sending");
  try {
    const e = await api(`/api/people/${encodeURIComponent(handle)}/order`, body);
    let cur = S.sessions.find(s => s.to === handle);
    if (!cur) { cur = { id: id(), title: `${e.provider.name} (@${handle})`, to: handle, toName: e.provider.name, messages: [], updatedAt: now() }; S.current = cur.id; }
    cur.engagementId = e.id;
    live.engagements.set(e.id, e);
    for (const m of cur.messages) m.cards = (m.cards ?? []).filter(c => !(c.type === "engagement" && c.id === e.id));
    cur.messages.push({ id: id(), role: "user", text: e.brief.summary, at: now() },
      { id: id(), role: "agent", text: e.phase === "agreed" ? `Done — ${e.provider.name}'s agent confirmed it. Pay below to get your pass.`
        : "Sent. Nothing is final until you both confirm.", at: now(), cards: [{ type: "engagement", id: e.id }] });
    await saveSession(cur);
    session.track("order_from_card", { kind: el.dataset.kind ?? "offer", quantity: body.quantity, offer: a === "store-offer-send", slot: !!body.slotId });
    toChat(); paint();
  } catch (err) {
    toast(err.message, null, "error");
    // Stock or a time may have changed: show the card as it is now.
    if (err.status === 409) {
      const cur = S.sessions.find(s => s.to === handle); refreshedCards.delete(cur?.id); await person(handle, true); refreshStoreCard(cur);
      const left = err.data?.available;
      if (left > 0 && qtyInput) { qtyInput.value = String(left); item.dataset.max = String(left); shopLabels(item); toast(`Only ${left} left — set to ${left}. Tap again to order them.`); }
    }
  } finally { busy(el, false); }
}

// MARK: - Sessions

async function saveSession(s) {
  s.updatedAt = now();
  // Incognito: a chat started while it's on lives only in memory — never on this device, never in the account.
  if (S.incognito && !s.persisted) s.incognito = true;
  if (!s.incognito) { s.persisted = true; await local.put("sessions", s); upload(s); }
  S.sessions = [s, ...S.sessions.filter(x => x.id !== s.id)];
}

// Chat history also lives in the account (owner-only), so the installed app, other browsers and other devices show
// the same chats. Uploads wait a moment so a burst of edits is one write.
const pending = new Map();
function upload(s) {
  const owner = session.uid; // a chat is only ever uploaded to the account it was written under
  clearTimeout(pending.get(s.id));
  pending.set(s.id, setTimeout(() => { pending.delete(s.id); if (owner === session.uid) api("/api/chats", { chat: s }).catch(() => {}); }, 1500));
}

/** Brings in chats saved from other devices and sends up the ones only this device has (older chats included). */
async function syncChats() {
  const owner = session.uid;
  const remote = await api("/api/chats").catch(() => null);
  if (!remote || owner !== session.uid) return;
  const mine = new Map(S.sessions.map(s => [s.id, s]));
  let changed = false;
  for (const r of remote) {
    const l = mine.get(r.id);
    if (!l || r.updatedAt > l.updatedAt) { await local.put("sessions", r); mine.set(r.id, r); changed = true; }
  }
  const there = new Map(remote.map(r => [r.id, r.updatedAt]));
  for (const l of S.sessions) if (!there.has(l.id) || l.updatedAt > there.get(l.id)) api("/api/chats", { chat: l }).catch(() => {});
  if (changed) {
    S.sessions = [...mine.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    S.current ??= S.sessions[0]?.id ?? null;
    paint();
  }
}

async function send(text, offerFactId = null) {
  text = text.trim();
  if (!text || S.sending) return;
  S.sending = true;
  $("#input").value = "";
  let cur = S.sessions.find(s => s.id === S.current);
  if (!cur) { cur = { id: id(), title: text.slice(0, 48), messages: [], updatedAt: now() }; S.current = cur.id; }
  const user = { id: id(), role: "user", text, at: now() };
  const reply = { id: id(), role: "agent", text: "", at: now(), pending: "calibrating", cards: [] };
  cur.messages.push(user, reply);
  await saveSession(cur);
  toChat();
  paint();
  try {
    const recent = cur.messages.filter(m => m.role === "user").slice(-5, -1).map(m => m.text);
    // The latest request in this chat, so "try a wider area" or "up to 600" changes it.
    const open = cur.messages.slice(0, -2).flatMap(m => (m.cards ?? []).filter(c => c.type === "brief" && c.draft)).at(-1) ?? null;
    // "Say the area you mean" was the last reply: a short answer ("delhi") completes that request.
    const asked = !cur.to && S.pendingAsk && text.split(/\s+/).length <= 4 && !/\b(need|want|find|remember|sell|book)\b/i.test(text);
    if (asked) { text = `${S.pendingAsk} in ${text}`; user.text = text; }
    S.pendingAsk = null;
    const r = cur.to ? await sendDirect(cur, text, offerFactId) : await chat(text, recent, S.profile.area, open);
    if (r.askArea) S.pendingAsk = r.askArea;
    Object.assign(reply, r, { pending: null, engine: r.engine ?? "Gemini" });
  } catch (e) {
    // A refusal (not enough in stock, over budget…) is said as it is; when there's an offer that fits, it's one tap away.
    Object.assign(reply, { pending: null, text: e.status && e.status < 500 ? e.message : `Something went wrong: ${e.message}`,
      ...(e.data?.suggest ? { cards: [{ type: "suggest", options: [{ label: e.data.suggest, text: e.data.suggest }], hint: "Sends it as your offer." }] } : {}) });
  }
  await saveSession(cur);
  S.sending = false;
  paint();
}

const findCard = el => {
  const s = S.sessions.find(x => x.id === S.current);
  const m = s?.messages.find(x => x.id === el.dataset.msg);
  return m ? { s, m, c: m.cards[Number(el.dataset.card)] } : null;
};

// MARK: - Actions

/**
 * The divider between the chat and what's open beside it: drag (or arrow keys) to give either more room; double-click
 * puts it back. The width is kept on this device.
 */
function startResizer() {
  const app = $("#app"), bar = $("#resizer");
  if (!app || !bar) return;
  const KEY = "collab.panelWidth", min = 320;
  const max = () => app.getBoundingClientRect().width - ($("#sidebar")?.getBoundingClientRect().width ?? 0) - 320;
  const set = w => { const v = Math.round(Math.max(min, Math.min(max(), w))); app.style.setProperty("--panel-w", `${v}px`); return v; };
  const save = v => { try { localStorage.setItem(KEY, String(v)); } catch { /* this session only */ } };
  try { const kept = Number(localStorage.getItem(KEY)); if (kept > 0) app.style.setProperty("--panel-w", `${kept}px`); } catch { /* none kept */ }
  bar.addEventListener("pointerdown", e => {
    e.preventDefault(); bar.setPointerCapture(e.pointerId); app.classList.add("resizing");
    const right = app.getBoundingClientRect().right;
    const move = ev => set(right - ev.clientX);
    const up = ev => { bar.releasePointerCapture(ev.pointerId); app.classList.remove("resizing"); bar.removeEventListener("pointermove", move); bar.removeEventListener("pointerup", up); save(set(right - ev.clientX)); };
    bar.addEventListener("pointermove", move); bar.addEventListener("pointerup", up);
  });
  bar.addEventListener("keydown", e => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    const now = $("#panel").getBoundingClientRect().width;
    save(set(now + (e.key === "ArrowLeft" ? 32 : -32)));
  });
  bar.addEventListener("dblclick", () => { app.style.removeProperty("--panel-w"); try { localStorage.removeItem(KEY); } catch { /* none kept */ } });
}

/** Wide enough for the chat and a screen side by side (styles.css: below 900 px what's open covers the chat). */
const sideBySide = () => matchMedia("(min-width: 900px)").matches;
/** Show the chat: on a wide screen the screen beside it (Activity…) stays open; on a phone the chat takes over. */
function toChat() { if (!sideBySide() || !screens[S.screen]) S.screen = "chat"; }

/**
 * Where a notification, a shortcut or a link points: a conversation opens itself (in the side panel; the whole screen
 * on a phone), waiting for it to load if it just arrived; a person's card, Activity or a screen open as they are.
 */
async function openLink(link) {
  const qp = new URL(link || "/", location.origin).searchParams;
  if (location.search) history.replaceState(null, "", location.pathname);
  if (qp.get("to")) return openDirect(qp.get("to"));
  if (qp.get("engagement")) return openEngagement(qp.get("engagement"));
  if (qp.get("alerts")) return openScreen("requests");
  if (qp.get("screen") && screens[qp.get("screen")]) return openScreen(qp.get("screen"));
}
async function openEngagement(id) {
  for (let i = 0; i < 12 && !live.engagements.has(id); i++) { await refresh(openScreen).catch(() => {}); if (!live.engagements.has(id)) await new Promise(r => setTimeout(r, 700)); }
  if (!live.engagements.has(id)) return openScreen("requests");
  toChat();
  showEngagement(id);
}

function openScreen(screen, focus) {
  // Notifications and alerts name a conversation: that conversation opens, not the list it's in.
  if (screen === "engagement" && focus) { openEngagement(focus); return; }
  S.screen = screen; S.focus = focus ?? null; $("#app")?.classList.remove("nav-open"); S.panelEng = null; S.panelLog = null; clearPanel(); paint(); }

function onEdit(e) {
  const el = e.target;
  const ref = el.closest("[data-msg]");
  if (el.dataset.pick !== undefined && ref) {
    const f = findCard(el); if (!f) return;
    const j = Number(el.dataset.pick);
    f.c.picked = el.checked ? [...new Set([...(f.c.picked ?? []), j])] : (f.c.picked ?? []).filter(x => x !== j);
    saveSession(f.s);
    return;
  }
  if (!el.dataset.edit || !ref || e.type === "input" && el.type === "checkbox") return;
  const f = findCard(ref); if (!f) return;
  const k = el.dataset.edit, v = el.type === "checkbox" ? el.checked : el.value;
  if (k === "autonomy") { f.c.autonomy = v; f.c.delegate = !!v; }
  if (k === "days") f.c.days = Number(v);
  if (f.c.type === "brief") {
    if (k === "title" || k === "summary") f.c.draft.shared[k] = v;
    if (k === "rulesText") { f.c.rulesText = v; if (f.c.rulesOk) f.c.rulesOk = false; }
    if (k === "about") setAbout(f.c.draft.shared, el.dataset.key, String(v).trim());
    if (k === "limit") {
      const n = Number(v);
      const paid = !!f.c.draft.need.requesterPaid;
      f.c.draft.mandate = n > 0 ? { price: { opening: Math.round(n * (paid ? 1.1 : 0.9)), limit: n }, terms: {}, maxRounds: session.policy?.negotiation?.maxRounds ?? 5 } : null;
      if (paid) f.c.draft.need.minPrice = n > 0 ? n : null; else f.c.draft.need.maxPrice = n > 0 ? n : null;
      if (e.type === "change") insightsLines({ side: "requester", category: f.c.draft.need.category, area: f.c.draft.need.place.name, limit: n > 0 ? n : null, unit: f.c.draft.need.unit, item: itemOf(f.c.draft) })
        .then(ls => { f.c.insights = ls; saveSession(f.s); paintContent(true); });
    }
  }
  if (f.c.type === "offer") {
    // Every field of the seller's card is kept on the card, so a repaint never loses what they typed.
    if (k === "floor") f.c.floor = Number(v) || null;
    else if (k === "stock") f.c.stock = v === "" ? null : Number(v);
    else if (k === "missing") { (f.c.missingAnswers ??= {})[el.dataset.key] = v; f.c.answeredMissing = (f.c.missing ?? []).every(m => (f.c.missingAnswers[m.label] ?? "").trim()); }
    else if (k === "term-label" || k === "term-text") { const t = f.c.terms?.[Number(el.dataset.j)]; if (t) t[k === "term-label" ? "label" : "text"] = v; }
    else if (k === "basic-price") f.c.basicPrice = v;
    else if (k === "basic-area") f.c.basicArea = v;
    else if (k.startsWith("hours-")) {
      const h = (f.c.hours ??= defaultHours(f.c.offer));
      if (k === "hours-on") f.c.hoursOn = v;
      else if (k === "hours-day") { const d = Number(el.dataset.day); h.days = v ? [...new Set([...h.days, d])].sort((a, b) => a - b) : h.days.filter(x => x !== d); }
      else if (k === "hours-from" || k === "hours-to") h[k.slice(6)] = v;
      else if (k === "hours-minutes") h.minutes = Number(v) || 0;
    }
    else if (k !== "autonomy" && k !== "days") f.c[k] = v;
  }
  if (e.type === "change") {
    saveSession(f.s);
    // A ticked box or a picked option changes what the card shows: let go of it and repaint. A text field doesn't —
    // its value is already on the card — and repainting as it loses focus would swallow the tap that moved focus.
    if (k === "autonomy" || (f.c.type === "offer" && /checkbox|radio|select-one/.test(el.type))) { el.blur(); paintContent(true); }
  }
}

async function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  try {
    if (a === "nav") return $("#app").classList.toggle("nav-open");
    // Anything chosen in the menu closes it (on a phone it covers the page).
    if (el.closest(".sidebar")) $("#app")?.classList.remove("nav-open");
    if (a === "screen") return openScreen(el.dataset.screen);
    if (a === "intro-done") { try { localStorage.setItem("collab.intro", "done"); } catch {} return paint(); }
    if (a === "install" || a === "install-app") return installApp();
    // A new or earlier chat replaces the chat only — Activity (or whatever is open beside it) stays on a wide screen.
    if (a === "new-chat") { S.current = null; $("#app")?.classList.remove("nav-open"); toChat(); return paint(); }
    if (a === "open-session") { S.current = el.dataset.id; $("#app")?.classList.remove("nav-open"); toChat(); return paint(); }
    if (a === "prompt") { $("#input").value = el.dataset.text; $("#input").focus(); return; }
    if (a === "send-text") return send(el.dataset.text, el.dataset.offer || null);
    if (a === "preview-card") return previewCard(el);
    if (a === "agent-card") return showAgentCard();
    if (a === "checkout") { const eid = el.dataset.id; preloadGooglePay(); openPanel({ title: "Checkout", render: () => checkoutHTML(live.engagements.get(eid)) }); return; }
    if (a === "share-link") {
      const data = { title: `${S.profile.name} on Collab`, text: `Talk to ${S.profile.name}'s agent on Collab`, url: el.dataset.link };
      if (navigator.share) await navigator.share(data).catch(() => {}); else { await navigator.clipboard.writeText(el.dataset.link).catch(() => {}); toast("Link copied."); }
      return;
    }
    if (a === "eng-open") return showEngagement(el.dataset.id);
    if (a === "eng-log") return showLog(el.dataset.id);
    if (a === "agent-stream") return showLog(null);
    if (a === "copy") { await navigator.clipboard.writeText(el.dataset.text ?? el.dataset.link ?? "").catch(() => {}); return toast("Copied."); }
    // The seller's quick moves on a request (their side of the conversation card).
    if (a === "seller-quote" || a === "seller-counter-send") {
      const price = a === "seller-quote" ? Number(el.dataset.price) : Number(document.querySelector(`[data-counter-price="${CSS.escape(el.dataset.id)}"]`)?.value);
      if (!(price > 0)) return toast("Type your price.");
      busy(el, true, "Sending");
      // Said as the side they're on, so the wording never makes the one paying the one paid ("I'll pay …" / "I'll sell
      // it for …" / "I'd accept …").
      const eng = live.engagements.get(el.dataset.id), side = eng?.requester.uid === session.uid ? "requester" : "provider";
      const each = (eng?.negotiation?.deal?.terms?.quantity ?? eng?.quantity ?? 1) > 1 ? " each" : "";
      try { const e = await api(`/api/engagements/${el.dataset.id}/ask`, { text: `${offerWords(eng, side, `₹${price}`)}${each}` }); live.engagements.set(e.id, e); toast("Offer sent — their agent answers it, or they do."); }
      catch (err) { toast(err.message, null, "error"); }
      return refresh(openScreen);
    }
    if (a === "delegate") {
      const said = String(document.querySelector(`[data-delegate-limit="${CSS.escape(el.dataset.id)}"]`)?.value ?? "").trim();
      if (!said) return toast("Name your limit, or say your rules — it's never shown to them.");
      // Rules in words: read by Gemini and shown back first; nothing applies until the owner confirms.
      if (!/^\s*(?:₹|rs\.?)?\s*\d[\d,]*\s*$/i.test(said)) {
        busy(el, true, "Reading");
        try {
          const eng = live.engagements.get(el.dataset.id), selling = eng && (eng.seller ?? "provider") === (eng.requester.uid === session.uid ? "requester" : "provider");
          const r = await api("/api/rules/read", { text: said, side: selling ? "seller" : "buyer", engagementId: el.dataset.id });
          pendingRules.set(el.dataset.id, { text: said, rules: r.rules });
          const box = document.querySelector(`[data-rules-preview="${CSS.escape(el.dataset.id)}"]`);
          if (box) box.innerHTML = `<div class="card slim">${rulesList(r.lines)}<div class="row"><button class="btn accent compact" data-act="rules-confirm" data-id="${esc(el.dataset.id)}">Confirm and hand over</button><span class="small faint">Nothing applies until you confirm.</span></div></div>`;
        } catch (err) { toast(err.message, null, "error"); }
        busy(el, false); return;
      }
      const limit = Number(said.replace(/[^\d]/g, ""));
      busy(el, true, "Handing over");
      try { const e = await api(`/api/engagements/${el.dataset.id}/delegate`, { limit, autonomy: el.dataset.autonomy || "close" }); live.engagements.set(e.id, e); toast(e.phase === "agreed" ? "Your agent agreed inside your limit — pay below." : "Your agent has it — it negotiates inside your limit and asks only if there's no deal there."); }
      catch (err) { toast(err.message, null, "error"); }
      return refresh(openScreen);
    }
    if (a === "deal-msg" || a === "deal-note") {
      const input = document.querySelector(`[data-deal-msg="${CSS.escape(el.dataset.id)}"]`);
      const text = a === "deal-note" ? el.dataset.text : String(input?.value ?? "").trim();
      if (!text) return;
      busy(el, true, "Sending");
      try { const e = await api(`/api/engagements/${el.dataset.id}/ask`, { text }); live.engagements.set(e.id, e); if (input) input.value = ""; }
      catch (err) { toast(err.message, null, "error"); }
      return refresh(openScreen);
    }
    if (a === "rules-confirm") {
      const p = pendingRules.get(el.dataset.id);
      if (!p) return toast("Read your rules again first.");
      busy(el, true, "Handing over");
      try { const e = await api(`/api/engagements/${el.dataset.id}/rules`, p); live.engagements.set(e.id, e); pendingRules.delete(el.dataset.id);
        toast(e.phase === "agreed" ? "Your agent agreed inside your rules — pay below." : "Your agent has it — it follows your rules and asks you only when it can't."); }
      catch (err) { toast(err.message, null, "error"); }
      return refresh(openScreen);
    }
    if (a === "seller-counter") { const box = document.querySelector(`[data-counter="${CSS.escape(el.dataset.id)}"]`); box.hidden = !box.hidden; box.querySelector("input")?.focus(); return; }
    if (a === "seller-ask") { const f = document.querySelector(`[data-followup="${CSS.escape(el.dataset.id)}"]`); if (f) { f.focus(); f.placeholder = "Ask them anything — e.g. which style, any reference photo?"; } else toast("Use the box below the card to ask them."); return; }
    if (a === "take-price") {
      // Accepting the seller's listed price is an offer at that price: they confirm (or their agent does, if they allow it).
      busy(el, true, "Sending");
      try { const e = await api(`/api/engagements/${el.dataset.eng}/ask`, { text: `I'll buy it for ₹${el.dataset.price}` }); live.engagements.set(e.id, e); toast("Offered at their price — they confirm, then you pay."); }
      catch (err) { toast(err.message, null, "error"); }
      return refresh(openScreen);
    }
    if (a === "qty" || a === "shop-slot" || a === "store-offer-open") return shopControl(a, el);
    if (a === "store-order" || a === "store-offer-send") return orderFromCard(a, el);
    if (a === "add-contact-direct") { busy(el, true); await api("/api/contacts", { handle: el.dataset.handle }); el.textContent = "✓ In your people"; return; }
    if (a.startsWith("inbox-")) return inboxAction(a, el);
    if (a === "eng-ask") {
      const input = document.querySelector(`[data-followup="${CSS.escape(el.dataset.id)}"]`);
      const q = input?.value.trim();
      if (!q) return input?.focus();
      busy(el, true, "Sending");
      try { live.engagements.set(el.dataset.id, await api(`/api/engagements/${el.dataset.id}/ask`, { text: q })); input.value = ""; run(el.dataset.id); }
      finally { busy(el, false); }
      return refresh(openScreen);
    }
    if (a === "eng-close") { busy(el, true); await api(`/api/engagements/${el.dataset.id}/close`, {}); await refresh(openScreen); return; }
    // Joining an accepted offer: each step is the person's own, and a withdrawal says why.
    if (a.startsWith("join-")) {
      const id = el.dataset.id, body = { action: { "join-mark": "joined", "join-confirm": "confirm", "join-noshow": "no_show", "join-withdraw": "withdraw" }[a], ...(el.dataset.as ? { as: el.dataset.as } : {}) };
      if (a === "join-mark") body.date = el.parentElement?.querySelector("[data-join-date]")?.value || "";
      // Marking it for a demo person in this conversation says so at the top of the box.
      const e = live.engagements.get(id), mine = e?.requester.uid === session.uid ? "requester" : "provider";
      const as = el.dataset.as && e ? shortName(e[mine === "requester" ? "provider" : "requester"].name) : null;
      if (a === "join-noshow") { const r = await ask({ title: "Mark that they didn't join?", detail: "They see this, with anything you add, and it's part of the deal record.", ok: "They didn't join", danger: true, as, input: { label: "Anything to add (optional)", placeholder: "e.g. Didn't turn up on the start date" } }); if (r === null) return; body.reason = r; }
      if (a === "join-withdraw") { const r = await ask({ title: "Withdraw before joining?", detail: "They see your reason. This can't be undone.", ok: "Withdraw", danger: true, as, input: { label: "Why (they'll see it)", required: true, min: 3, placeholder: "e.g. I've accepted another offer" } }); if (r === null) return; body.reason = r; }
      busy(el, true);
      try { live.engagements.set(id, await api(`/api/engagements/${id}/joining`, body)); }
      catch (err) { toast(err.message, null, "error"); }
      finally { busy(el, false); }
      return refresh(openScreen);
    }
    if (a === "demo-applicants") {
      busy(el, true, "Applying");
      try { const r = await api(`/api/facts/${encodeURIComponent(el.dataset.id)}/demo-applicants`, {}); toast(r.added ? `${r.added} demo candidates applied — their agents are talking to yours.` : "The demo candidates have already applied."); }
      catch (err) { toast(err.message, null, "error"); }
      finally { busy(el, false); }
      await refresh(openScreen);
      for (const e of live.engagements.values()) if (e.outbox && e.requester.uid?.startsWith("demo-")) run(e.id);
      return;
    }
    if (a === "eng-outcome") { busy(el, true); await api(`/api/engagements/${el.dataset.id}/outcome`, { happened: el.dataset.happened === "1" }); await refresh(openScreen); return; }
    if (a === "eng-pay" || a === "eng-paid-outside") {
      // Google Pay (TEST) first, inside the tap; then the AP2 step. One idempotency key per tap: a retry of the same
      // request can't pay twice.
      return payDeal(el, null, a);
    }
    if (a === "nearby") {
      busy(el, true, "Asking Google Maps");
      const box = el.closest(".card").querySelector("[data-nearby]");
      try {
        const r = await api("/api/nearby", { item: el.dataset.item, area: el.dataset.area });
        box.innerHTML = nearbyHTML(r);
        // Kept with the card, so a later repaint (Keep watching, a reload) still shows them.
        const f = findCard(el); if (f) { f.c.nearby = { places: r.places, note: r.note }; await saveSession(f.s); }
      } finally { busy(el, false); }
      loadPolicy();
      return;
    }
    if (a === "price-check") {
      // Kept by what was asked, so a repaint (a live update, another tap) never loses it; a second tap while it's
      // searching does nothing.
      const key = priceKey(el.dataset.item, el.dataset.area, el.dataset.unit || null);
      if (priceChecks.get(key)?.state === "loading") return;
      priceChecks.set(key, { state: "loading" }); paintContent(true);
      try {
        // The request card's title as edited, if it was.
        const r = await api("/api/price-check", { item: el.closest(".brief")?.querySelector('[data-edit="title"]')?.value.trim() || el.dataset.item, area: el.dataset.area, unit: el.dataset.unit || undefined });
        priceChecks.set(key, { state: "done", r });
      } catch (err) {
        priceChecks.set(key, { state: "error", message: err.status === 429 ? err.message : `Couldn't get prices from the web right now${err.status === 503 ? " — Google Search didn't answer in time" : ""}. Try again in a minute.` });
      }
      paintContent(true);
      loadPolicy();
      return;
    }
    // Buy again: the same item and quantity from the same seller, as a new order at today's price (stock checked again).
    if (a === "buy-again") {
      const e = live.engagements.get(el.dataset.id);
      if (!e) return;
      const sellerSide = e.seller ?? "provider", n = e.negotiation.deal?.items?.length ? e.negotiation.deal.items.reduce((t, l) => t + l.quantity, 0) : e.negotiation.deal?.terms?.quantity > 1 ? e.negotiation.deal.terms.quantity : 1;
      busy(el, true, "Ordering");
      try {
        const x = await api(`/api/people/${encodeURIComponent(e[sellerSide].handle)}/order`, { offerFactId: e.offer.factId, quantity: n });
        live.engagements.set(x.id, x); session.track("order_from_card", { kind: "again", instant: x.phase === "agreed" });
        toast(x.phase === "agreed" ? "Ordered — it's agreed. Pay when you're ready." : "Ordered — waiting for them to confirm.");
        openScreen("requests", x.id);
      } catch (err) { toast(err.status === 404 ? "That isn't on offer any more." : err.message); busy(el, false); }
      return;
    }
    if (a === "eng-pickup") {
      busy(el, true);
      try { await openPass((await api(`/api/engagements/${el.dataset.id}/pickup`)).path); }
      catch (err) { toast(`Couldn't open the pass: ${err.message}`); }
      finally { busy(el, false); }
      return;
    }
    if (a === "slots-load") {
      busy(el, true);
      const r = await api(`/api/engagements/${el.dataset.id}/slots`);
      const box = document.querySelector(`[data-slots="${CSS.escape(el.dataset.id)}"]`);
      // The next eight times up front; the rest behind "More times".
      const slotBtn = sl => `<button class="btn secondary compact" data-act="slot-pick" data-id="${esc(el.dataset.id)}" data-slot="${esc(sl.id)}">${new Date(sl.start * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", timeZone: r.timezone ?? undefined })}</button>`;
      box.innerHTML = r.slots.length ? `<span class="small">Pick a time (${esc(r.timezone ?? "")}):</span><div class="row" style="flex-wrap:wrap">${r.slots.slice(0, 8).map(slotBtn).join("")}</div>
          ${r.slots.length > 8 ? `<details class="more"><summary>More times · ${r.slots.length - 8}</summary><div class="row" style="flex-wrap:wrap">${r.slots.slice(8).map(slotBtn).join("")}</div></details>` : ""}`
        : `<span class="small muted">No open slots right now — ask them to add some.</span>`;
      return;
    }
    if (a === "slot-pick") {
      busy(el, true, "Holding");
      try { const e = await api(`/api/engagements/${el.dataset.id}/slot`, { slotId: el.dataset.slot }); live.engagements.set(e.id, e); toast("Held for you — pay to book it."); }
      catch (err) { toast(err.message, null, "error"); }
      return refresh(openScreen);
    }
    if (a === "eng-delivered" || a === "eng-received") {
      const ok = el.dataset.ok !== "0";
      const note = a === "eng-received" && !ok ? await ask({ title: "Report a problem?", detail: "They see it, and it's part of the deal record.", ok: "Report problem", danger: true, input: { label: "What went wrong (optional)" } }) : "";
      if (note === null) return;
      busy(el, true);
      const e = await api(`/api/engagements/${el.dataset.id}/${a === "eng-delivered" ? "delivered" : "received"}`, a === "eng-delivered" ? {} : { ok, note });
      live.engagements.set(e.id, e);
      session.track(a === "eng-delivered" ? "delivered" : ok ? "received" : "disputed");
      const them = (e.requester.uid === session.uid ? e.provider : e.requester).name, close = partyRoles(e, "provider").close;
      toast(a === "eng-delivered" ? `${close.marked} ${them} will confirm.` : ok ? `Thanks — ${them} will see it: ${close.confirmed}` : `Problem reported to ${them}.`);
      return refresh(openScreen);
    }
    if (a === "eng-receipt") {
      busy(el, true);
      const r = await api(`/api/engagements/${el.dataset.id}/receipt`);
      busy(el, false);
      const when = t => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      const by = s => (r.confirmedBy[s] === "mandate" ? "a standing instruction" : "in person");
      openPanel({ title: "Receipt", html: `<div class="receipt">${receiptHTML(r, live.engagements.get(el.dataset.id))}
        <span class="small muted">Agreed ${when(r.at)} · ${r.matches ? "signed and unchanged" : "changed since"}</span>
        <div class="row"><a class="btn secondary compact" href="${esc(r.verifyPath)}" target="_blank" rel="noopener">Verify ↗</a><span class="small faint">Anyone with the link can check it.</span></div>
        <details class="more"><summary>How it's checked</summary>
          <span class="small muted">Both confirmed (${by("requester")} / ${by("provider")}); Collab signed a fingerprint of the terms, people and time. Any change breaks it.</span>
          <code class="small" style="overflow-wrap:anywhere">${esc(r.hash)}</code></details>
        ${r.payment ? `<details class="more"><summary>Payment (AP2) · ${r.payment.status === "paid" ? "paid" : r.payment.status === "outside" ? "settled outside the app" : "waiting"}</summary>
          <dl class="kv small">
            <dt>Cart Mandate</dt><dd>${money(r.payment.cart.total.value, r.terms.unit)} · issued by @${esc(r.payment.cart.merchant.handle)}'s agent · ${r.payment.check?.cartOk ? tag("✓ signature valid, matches the deal", "fresh") : tag("doesn't match", "danger")}</dd>
            ${r.payment.mandate ? `<dt>Payment Mandate</dt><dd>signed by @${esc(r.payment.mandate.payer)}'s agent, for that cart · ${r.payment.check?.paymentOk ? tag("✓ signature valid", "fresh") : tag("doesn't match", "danger")}</dd>
            <dt>Payment</dt><dd>${esc(r.payment.paymentId)}</dd>` : ""}
            ${r.payment.ap2 ? `<dt>AP2 v0.2 checkout</dt><dd>${esc(r.payment.ap2.checkout.id)} · authorised by @${esc(r.payment.ap2.checkout.merchant.handle)}'s agent (detached JWS) · ${r.payment.check?.ap2?.merchantOk ? tag("✓ valid", "fresh") : tag("doesn't match", "danger")}</dd>
            <dt>AP2 mandates</dt><dd>Checkout + Payment Mandates (SD-JWT) by @${esc(r.payment.ap2.checkout.buyer.handle)}'s agent, bound to the checkout hash · ${r.payment.check?.ap2?.mandatesOk ? tag("✓ valid", "fresh") : tag("doesn't match", "danger")}</dd>
            <dt>Instrument</dt><dd>${r.payment.ap2.instrument.type === "google_pay" ? `Google Pay · ${esc(r.payment.ap2.instrument.description ?? r.payment.ap2.instrument.network ?? "card")}` : "In the app"}</dd>` : ""}
          </dl>
          <span class="small muted">AP2: one agent signs the cart for the agreed terms; the other signs the payment only after Pay is tapped.</span></details>` : ""}</div>` });
      return;
    }
    if (screens[S.screen]?.act && await screens[S.screen].act(a, el, S, { paint, toast, openScreen, openDirect, publicIntake, openPass })) return;
    const f = findCard(el);
    if (!f) return;
    await cardAction(a, el, f);
  } catch (err) { toast(err.message, null, "error"); busy(el, false); }
}

async function cardAction(a, el, { s, m, c }) {
  if (a === "saved-tiers") { c.showTiers = true; await saveSession(s); return paint(); }
  // The owner chose to have Gemini answer this one question from the notes shown (nothing else is sent).
  if (a === "notes-cloud") {
    busy(el, true, "Asking");
    const r = await api("/api/think", { question: c.question, notes: c.notes.map(n => ({ text: n.text })), side: "self" });
    c.answer = r.action === "answer" ? (r.text ?? r.answer) : "Your notes don't clearly answer that.";
    await saveSession(s); paint();
    return;
  }
  const d = c.draft;
  if (a === "brief-strength") { const r = d.shared.requirements[Number(el.dataset.j)]; r.strength = r.strength === "required" ? "preferred" : "required"; const nf = d.need.filters.find(x => x.label === r.label); if (nf) nf.strength = r.strength; }
  if (a === "brief-drop") { const [r] = d.shared.requirements.splice(Number(el.dataset.j), 1); d.need.filters = d.need.filters.filter(x => x.label !== r.label); }
  if (a === "brief-dropq") { const [q] = d.shared.questions.splice(Number(el.dataset.j), 1); d.need.mustAsk = d.need.mustAsk.filter(x => x !== q); }
  if (a === "brief-about") {
    // A profile answer is only shared, never searched on: no re-read, nothing sent yet. Tapping it again clears it.
    const cur = d.shared.about?.find(x => x.label === el.dataset.key)?.value;
    setAbout(d.shared, el.dataset.key, cur === el.dataset.val ? "" : el.dataset.val);
  }
  if (a === "brief-clarify") {
    // The owner's answer joins the request at once (a requirement others' agents see) — no wait for a second read.
    const q = d.clarify[Number(el.dataset.j)], opt = el.dataset.val ?? q.options[Number(el.dataset.k)];
    answerBrief(c, q.question, opt);
  }
  if (a === "brief-rules-read" || a === "offer-rules-read") {
    const words = String(c.rulesText ?? "").trim();
    if (words.length < 4) return toast("Say your rules first — e.g. “up to ₹3,200, close yourself below ₹3,000”.");
    busy(el, true, "Reading");
    const o = a === "offer-rules-read" ? c.offer : null;
    const r = await api("/api/rules/read", { text: words, side: o ? (ownerPays(c) ? "buyer" : "seller") : (d?.need?.requesterPaid ? "seller" : "buyer"), offer: o ? { title: o.title, price: o.price.amount, unit: o.price.period } : { title: d?.shared?.title ?? "", price: null } }).catch(err => { toast(err.message, null, "error"); return null; });
    if (r) { c.rules = { rules: r.rules, lines: r.lines }; c.rulesOk = false; }
  }
  if (a === "brief-rules-clear" || a === "offer-rules-clear") { delete c.rules; delete c.rulesOk; c.rulesText = ""; }
  if (a === "brief-rules-ok") {
    // The confirmed rules become the request's: the private limit, where the agent may close, how many, must-be-yes checks.
    const r = c.rules.rules;
    c.rulesOk = true;
    if (r.limit) { d.mandate = { price: { opening: Math.round((r.closeAt ?? r.limit) * 0.9), limit: r.limit }, terms: {}, maxRounds: session.policy?.negotiation?.maxRounds ?? 5 }; d.need.maxPrice = r.limit; }
    if (r.quantity) d.need.attributes = { ...(d.need.attributes ?? {}), quantity: String(r.quantity) };
    for (const q of r.mustAsk) if (!d.shared.questions.includes(q)) d.shared.questions.push(q);
    c.autonomy = r.autonomy; c.closeAt = r.closeAt ?? null;
  }
  if (a === "offer-rules-ok") {
    const r = c.rules.rules;
    c.rulesOk = true;
    if (r.floor) c.floor = r.floor;
    c.autonomy = r.autonomy;
  }
  if (a === "gate-override") c.gateOverride = true;
  if (a === "matches-more") c.showAll = true;
  if (a === "gate-answer") {
    const j = Number(el.dataset.j), q = c.gate.missing[j], opt = el.dataset.val ?? q.options[Number(el.dataset.k)];
    (c.gateAnswers ??= {})[j] = opt;
    if (c.type === "brief") {
      // Answered like Gemini's other questions: it joins the request at once, and the gate opens when nothing's left.
      answerBrief(c, q.question, opt);
      c.gateAnswers = {};
    } else {
      // On an offering it's one more detail buyers see; answered, the gate opens.
      const lbl = q.question.replace(/\?$/, "").split(/\s+/).slice(0, 4).join(" ");
      if (!(c.missing ?? []).some(m => m.label === lbl)) (c.missing ??= []).push({ label: lbl, ask: q.question, options: q.options });
      (c.missingAnswers ??= {})[lbl] = opt;
      if (c.gate.missing.every((_, i) => c.gateAnswers[i])) c.gate = { ...c.gate, ok: true };
    }
  }
  if (a === "brief-send") {
    // Searching with questions still open is fine: the agents ask what they need.
    if (c.gate && !c.gate.ok) c.gateOverride = true;
    // The answers tapped for this request are kept (Private), and filled in the next time they're asked.
    rememberAll(c.answered ?? [], d.shared?.title ?? null);
    busy(el, true, "Searching");
    const r = await api("/api/briefs", { need: d.need, shared: d.shared, delegate: d.mandate ? { mandate: d.mandate, autonomy: autonomyOf(c) || "ask", days: c.days ?? 7,
      ...(c.rulesOk ? { closeAt: c.closeAt ?? null, rulesText: c.rulesText } : {}) } : null });
    // Real matches first (only the best one pre-ticked); sellers that fit but cost more than the limit come last, unticked.
    Object.assign(c, { step: "matches", briefId: r.brief.id, found: [...r.found, ...(r.overBudget ?? []).map(f => ({ ...f, over: true }))], rankedByModel: r.rankedByModel, picked: r.found.length ? [0] : [] });
    // Discovery runs on its own: the best matches (up to three, within budget) are contacted at once — only the shared
    // request goes out — and one live list shows every conversation, with what needs the owner on top.
    const first = r.found.slice(0, 3);
    if (first.length) {
      const es = await api(`/api/briefs/${r.brief.id}/engage`, { providers: first.map(p => ({ factId: p.fact.id })) });
      c.step = "engaged"; c.engaged = es.map(x => x.id);
      for (const x of es) live.engagements.set(x.id, x);
      m.cards.push({ type: "discovery", briefId: r.brief.id, engaged: c.engaged, found: c.found, title: d.shared?.title ?? "" });
      session.track("agents_contacted", { count: es.length, category: d.need?.category ?? "none", auto: true });
      m.text = `I'm talking to ${es.length === 1 ? "1 agent" : `${es.length} agents`} now — I'll come to you only when there's a decision.`;
      await saveSession(s); paint();
      for (const x of es) run(x.id);
      return;
    }
    // Nothing fits exactly: the closest listings come with the reply, and Google Maps is asked at once (no extra tap).
    c.closest = r.closest ?? [];
    m.text = c.closest.length ? "No exact match yet — here's what's closest, and what I found nearby on Google Maps." : "No match on Collab yet — I'm checking Google Maps nearby.";
    c.nearby = { loading: true };
    await saveSession(s); paint();
    const near = await api("/api/nearby", { item: d.shared.title, area: d.shared.area ?? "" }).catch(() => null);
    const now_ = findCard(el) ?? { c, s };
    now_.c.nearby = near ? { places: near.places ?? [], note: near.note } : { places: [], note: "" };
    await saveSession(now_.s); paint();
    return;
  }
  if (a === "closest-ask") {
    // The owner chose to have their agent ask one of the closest listings anyway.
    const f = c.closest?.[Number(el.dataset.j)];
    if (!f) return;
    busy(el, true, "Contacting");
    const es = await api(`/api/briefs/${c.briefId}/engage`, { providers: [{ factId: f.fact.id }] });
    (c.askedClosest ??= {})[Number(el.dataset.j)] = true;
    for (const x of es) { live.engagements.set(x.id, x); m.cards.push({ type: "discovery", briefId: c.briefId, engaged: [x.id], found: [], title: f.fact.offer?.title?.split(" · ")[0] ?? "" }); }
    await saveSession(s); paint();
    for (const x of es) run(x.id);
    return;
  }
  if (a === "disc-more") {
    // The other good matches, contacted too.
    const have = new Set(c.engaged.map(id => live.engagements.get(id)?.offer?.factId));
    const rest = (c.found ?? []).filter(f => !f.over && !have.has(f.fact.id)).slice(0, 3);
    if (!rest.length) return;
    busy(el, true, "Contacting");
    const es = await api(`/api/briefs/${c.briefId}/engage`, { providers: rest.map(p => ({ factId: p.fact.id })) });
    c.engaged = [...c.engaged, ...es.map(x => x.id)];
    for (const x of es) live.engagements.set(x.id, x);
    await saveSession(s); paint();
    for (const x of es) run(x.id);
    return;
  }
  if (a === "watch") {
    // A scheduled agent for this request: it searches again every hour and alerts the owner (push, if allowed).
    busy(el, true, "Starting");
    await api("/api/watches", { briefId: c.briefId, seen: (c.found ?? []).map(f => f.fact.id), every: 60, days: 14 });
    c.watching = true;
    if (session.push && "Notification" in window && Notification.permission === "default") session.push().then(() => toast("Notifications on — you'll hear when someone new fits.")).catch(() => {});
    await refresh(openScreen);
  }
  // One match, straight from its row: book at the listed price (the seller confirms, or their agent does at once if
  // they allow instant booking).
  if (a === "match-book") {
    const j = Number(el.dataset.j), p = c.found[j];
    if (c.booked?.[j]) return;
    busy(el, true, "Booking");
    try {
      // Part of this request: the deal joins its goal (one goal, one timeline), and the row turns into "Booked".
      const e = await api(`/api/people/${encodeURIComponent(p.profile.handle)}/order`, { offerFactId: p.fact.id, quantity: 1, briefId: c.briefId });
      c.booked = { ...(c.booked ?? {}), [j]: e.id };
      live.engagements.set(e.id, e); if (!m.cards.some(x => x.type === "engagement" && x.id === e.id)) m.cards.push({ type: "engagement", id: e.id });
      session.track("order_from_card", { kind: "match", instant: e.phase === "agreed" });
      await saveSession(s); paint();
    } catch (err) { toast(err.message, null, "error"); busy(el, false); }
    return;
  }
  if (a === "match-booked") { const card = document.querySelector(`[data-engagement="${CSS.escape(el.dataset.id)}"]`); card?.scrollIntoView({ behavior: "smooth", block: "center" }); card?.classList.remove("flash"); void card?.offsetWidth; card?.classList.add("flash"); return; }
  if (a === "brief-engage" || a === "match-negotiate" || a === "match-addons") {
    // Someone already booked from this request isn't contacted again.
    const picks = (a === "brief-engage" ? (c.picked ?? []) : [Number(el.dataset.j)]).filter(j => !c.booked?.[j]).map(j => c.found[j]).filter(Boolean);
    if (!picks.length) return toast(Object.keys(c.booked ?? {}).length ? "You've booked them already — see the deal below." : "Choose at least one person.");
    busy(el, true, "Contacting");
    const es = await api(`/api/briefs/${c.briefId}/engage`, { providers: picks.map(p => ({ factId: p.fact.id })) });
    c.step = "engaged"; c.engaged = es.map(x => x.id);
    for (const x of es) { live.engagements.set(x.id, x); m.cards.push({ type: "engagement", id: x.id }); }
    session.track("agents_contacted", { count: es.length, category: c.draft?.need?.category ?? "none" });
    await saveSession(s); paint();
    for (const x of es) run(x.id);
    if (a === "match-addons") for (const x of es) api(`/api/engagements/${x.id}/ask`, { text: "What add-ons or extras do you offer, and what does each cost?" }).then(e => { live.engagements.set(e.id, e); paint(); }).catch(() => {});
    return;
  }
  if (a === "hours-preset") { const h = (c.hours ??= defaultHours(c.offer)); h.days = el.dataset.days.split(",").map(Number).sort((x, y) => x - y); h.from = el.dataset.from; h.to = el.dataset.to; }
  if (a === "offer-price-pick") { c.basicPrice = el.dataset.val === "other" ? "" : el.dataset.val; c.priceOther = el.dataset.val === "other"; }
  if (a === "offer-ask-other") { (c.missingOther ??= {})[el.dataset.key] = true; }
  if (a === "offer-ask-pick") {
    (c.missingAnswers ??= {})[el.dataset.key] = c.missingAnswers[el.dataset.key] === el.dataset.val ? "" : el.dataset.val;
    c.answeredMissing = (c.missing ?? []).every(x => (c.missingAnswers[x.label] ?? "").trim());
  }
  if (a === "offer-basics") {
    // The two things a vague offering lacks; then Gemini reads it again as a listing. Answers already given stay.
    const price = Number(c.basicPrice), where = String(c.basicArea ?? c.basics?.area ?? "").trim();
    if (!(price > 0)) return toast("Type your price.");
    if (!where) return toast("Say where — your area, or Online.");
    busy(el, true, "Reading");
    const base = String(c.publicText ?? c.text).trim().replace(/[.!]*$/, ".");
    const full = `${base} ₹${price.toLocaleString("en-IN")}${c.basics?.unit ? ` per ${c.basics.unit}` : ""}. ${/^online$/i.test(where) ? "Online." : `In ${where}.`}`;
    // The answers already tapped go to Gemini too, so the details it shows match them (they're published once, below).
    const said = Object.entries(c.missingAnswers ?? {}).filter(([, v]) => String(v).trim()).map(([k, v]) => `${k}: ${String(v).trim().replace(/[.]+$/, "")}.`).join(" ");
    const d = await api("/api/offers/draft", { text: said ? `${full} ${said}` : full, here: S.profile?.area }).catch(err => { toast(err.message, null, "error"); return null; });
    if (!d?.offer) { busy(el, false); return toast(d?.problem ?? "Still couldn't read it as an offering — say a little more about what it is."); }
    const answered = (c.missing ?? []).filter(x => (c.missingAnswers?.[x.label] ?? "").trim());
    c.missing = [...answered, ...(d.missing ?? []).filter(x => !answered.some(y => y.label.toLowerCase() === x.label.toLowerCase()))].slice(0, 6);
    c.answeredMissing = c.missing.every(x => (c.missingAnswers?.[x.label] ?? "").trim());
    Object.assign(c, { text: full, publicText: said && d.publicText.endsWith(said) ? d.publicText.slice(0, -said.length).trim() : d.publicText, offer: d.offer, ownerPays: !!d.ownerPays, floor: d.floor ?? c.floor ?? null, basics: null, gate: d.gate ?? null });
    c.insights = await insightsLines({ side: "provider", category: d.offer.category, area: d.offer.place.name, price: d.offer.price.amount, unit: d.offer.price.period, item: d.offer.title }).catch(() => []);
  }
  // A job post's requirements (from the JD), edited before publishing.
  if (a === "req-strength") { const r = c.offer.requirements[Number(el.dataset.j)]; r.strength = r.strength === "must" ? "nice" : "must"; }
  if (a === "req-drop") c.offer.requirements.splice(Number(el.dataset.j), 1);
  if (a === "req-add") {
    const m = (el.closest(".card")?.querySelector("[data-req-new]")?.value ?? "").match(/^\s*([^:]{2,30}):\s*(.{1,80}?)\s*$/);
    if (!m) return toast("Write it as “Label: what's needed” — e.g. “Skills: React”.");
    (c.offer.requirements ??= []).push({ label: m[1].trim(), value: m[2].trim(), strength: "must" });
  }
  if (a === "offer-suggest-terms") { const f = findCard(el); if (f) prefillTerms(f.s.id, f.m.id, Number(el.dataset.card), true); return; }
  // A common term for this kind of offering, tapped in; "Add all" takes the rest.
  if (a === "offer-term-add") {
    const picks = el.dataset.j === "all" ? c.starters ?? [] : [c.starters?.[Number(el.dataset.j)]].filter(Boolean);
    c.terms = [...(c.terms ?? []), ...picks.map(t => ({ ...t, sources: [] }))];
    c.starters = (c.starters ?? []).filter(t => !picks.includes(t));
  }
  if (a === "offer-publish") {
    if (c.offer && c.gate && !c.gate.ok && !c.gateOverride) return toast("Answer what's missing above, or tap “Publish as it is”.");
    busy(el, true, "Publishing");
    // The details buyers usually ask about, answered here, join the public text; the terms are saved as the seller's own.
    // All read from the card's state (what was typed is kept there), not from whichever improvement panel is open.
    const base = String(c.publicText ?? c.text);
    const extra = (c.missing ?? []).map(m => [m.label, String(c.missingAnswers?.[m.label] ?? "").trim()]).filter(([, v]) => v)
      .map(([k, v]) => `${k}: ${v.replace(/[.]+$/, "")}.`).filter(x => !base.includes(x)).join(" ");
    const terms = (c.terms ?? []).map(t => ({ label: String(t.label ?? "").trim(), text: String(t.text ?? "").trim() })).filter(t => t.label && t.text);
    const instant = !!c.instant;
    if (extra) { const t = (c.publicText ?? c.text).trim(); c.publicText = `${t}${/[.!?]$/.test(t) ? "" : "."} ${extra}`; }
    // What was answered here is kept (Private) and suggested for the next listing.
    rememberAll((c.missing ?? []).map(m => ({ question: m.ask || m.label, answer: c.missingAnswers?.[m.label] })), c.offer?.title ?? null);
    // A note being made public is published in place (no private copy left behind).
    const fact = await api("/api/facts", { ...(c.noteId ? { id: c.noteId } : {}), tier: "public", text: c.publicText ?? c.text, negotiable: limitPast(c), category: c.offer?.category ?? c.basics?.category ?? null, ...(c.photo ? { photoId: c.photo.id } : {}) });
    factsCache = null;
    if (fact.floorKeptPrivate) toast(`${ownerPays(c) ? "The most you'd pay" : "Your lowest price"} was left out of the public text — it stays private.`);
    if (fact.offer && (terms.length || instant)) await api(`/api/facts/${fact.id}/policies`, { policies: terms, instant }).catch(() => {});
    // A job post: the requirements its applicants are screened against, as the employer left them.
    if (fact.offer && ownerPays(c) && c.offer?.requirements) await api(`/api/facts/${fact.id}/requirements`, { requirements: c.offer.requirements }).catch(err => toast(err.message, null, "error"));
    // How many they have: tracked from the start, so "is it in stock?" never needs them.
    const stock = c.stock;
    if (fact.offer && Number.isInteger(stock) && stock >= 0) await api("/api/resources", { factId: fact.id, type: "quantity", onHand: stock }).catch(() => {});
    // Weekly hours: bookable times two weeks ahead, in the seller's own time zone, refilled by the server.
    if (fact.offer && c.hoursOn && hoursOk(c.hours)) await api("/api/resources", { factId: fact.id, type: "slots", hours: c.hours, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }).catch(err => toast(err.message, null, "error"));
    if (c.offer && c.floor) {
      const listed = c.offer.price.amount, limit = ownerPays(c) ? Math.max(c.floor, listed) : Math.min(c.floor, listed);
      const mandate = { price: { opening: listed, limit }, terms: {}, maxRounds: session.policy?.negotiation?.maxRounds ?? 5 };
      await api(`/api/facts/${fact.id}/limit`, { mandate, autonomy: autonomyOf(c) || "ask", days: c.days ?? 7 });
    }
    // The seller's rules in their words, as they confirmed them: the agent's limits, most per buyer, public terms.
    if (fact.offer && c.rulesOk && c.rules) await api(`/api/facts/${fact.id}/rules`, { text: c.rulesText, rules: c.rules.rules }).catch(err => toast(err.message, null, "error"));
    c.step = "published"; c.publicText = fact.text;
  }
  // Accept every suggested answer still open (the owner's own answers stay).
  if (a === "offer-use-suggested") {
    c.missingAnswers = { ...(c.suggestedAnswers ?? {}), ...Object.fromEntries(Object.entries(c.missingAnswers ?? {}).filter(([, v]) => String(v).trim())) };
    c.answeredMissing = (c.missing ?? []).every(m => String(c.missingAnswers[m.label] ?? "").trim());
  }
  // One improvement open at a time under the listing (tap again to fold it); what's typed is kept either way.
  // Each improvement opens and closes on its own; several can be open at once.
  if (a === "offer-improve") c.openParts = { ...(c.openParts ?? {}), [el.dataset.k]: !c.openParts?.[el.dataset.k] };
  // Making a note public goes through the offering card when it's something offered.
  if (a === "tier" && el.dataset.tier === "public" && c.fact && c.fact.tier !== "public") { busy(el, true, "Reading"); if (await publicIntake(c.fact.text, c.fact.id)) return; }
  if (a === "tier") await setTier(c.fact, el.dataset.tier, el);
  await saveSession(s);
  paint();
}

/** One profile answer on a request ("Experience: 1–2 years"); empty clears it. */
function setAbout(shared, label, value) {
  const rest = (shared.about ?? []).filter(x => x.label !== label);
  shared.about = value ? [...rest, { label, value: value.slice(0, 120) }] : rest;
}

/**
 * What others charge for this kind of thing near here, asked once per card as soon as the card asks for a price;
 * the typical figure is filled in and low / typical / high become buttons. Nothing stops the seller typing their own.
 */
const hintsAsked = new WeakSet();
function priceHintsFor(c, s) {
  if (!c.basics || c.priceHints !== undefined || hintsAsked.has(c)) return;
  hintsAsked.add(c); c.priceHints = null;
  api("/api/offers/price-hints", { item: c.publicText ?? c.text, area: c.basicArea ?? c.basics.area ?? "", unit: c.basics.unit ?? undefined })
    .then(h => { c.priceHints = h?.status === "evidence" ? h : { status: h?.status ?? "unavailable" }; if (c.priceHints.typical && !c.basicPrice) c.basicPrice = String(c.priceHints.typical); })
    .catch(() => { c.priceHints = { status: "unavailable" }; })
    .then(() => { saveSession(s); paintContent(true); });
}

/**
 * Something being made public — from chat or Context — is read by Gemini first. If it's something offered, it opens
 * as an offering card (price and where asked for if missing, buyers' usual questions with tap-to-answer options, a
 * written floor kept private) and publishes in place of the note. Anything else is published as it is (false).
 */
async function publicIntake(text, noteId = null, photo = null) {
  const d = await api("/api/offers/draft", { text, here: S.profile?.area, note: true }).catch(() => null);
  if (!d || (!d.offer && !d.basics)) return false;
  let cur = S.sessions.find(x => x.id === S.current && !x.to);
  if (!cur) { cur = { id: id(), title: text.slice(0, 48), messages: [], updatedAt: now() }; S.current = cur.id; }
  cur.messages.push({ id: id(), role: "user", text: photo ? "List this from a photo" : `Make this public: “${text}”`, at: now() }, { id: id(), role: "agent", at: now(), ...(await offerReply(text, d, { noteId, ...(photo ? { photo } : {}) })) });
  await saveSession(cur);
  toChat(); paint();
  return true;
}

/** Moving a fact between tiers: all three live on the server; Private is stored but never shared. */
async function setTier(fact, tier, el) {
  if (!fact || fact.tier === tier) return;
  busy(el, true);
  const saved = await api("/api/facts", { id: fact.id, tier, text: fact.text });
  factsCache = null;
  if (tier === "protected") toast(`Protected under: ${saved.topics.join(", ")}. Add a rule in Privacy to say who sees it.`, () => openScreen("sharing"));
}

async function inboxAction(a, el) {
  const itemId = el.dataset.id;
  const item = live.inbox.find(i => i.id === itemId);
  if (!item) return;
  const body = {};
  if (a === "inbox-quick") body.text = el.dataset.text;
  if (a === "inbox-answer") { body.text = document.querySelector(`[data-reply="${CSS.escape(itemId)}"]`)?.value.trim(); if (!body.text) return toast("Write an answer, or choose “I'd rather not say”."); }
  if (a === "inbox-share") body.text = drafts.get(itemId)?.text;
  if (a === "inbox-approve") body.share = true;
  if (a === "inbox-decline") { body.decline = true; body.share = false; }
  if (a === "inbox-confirm") body.confirm = true;
  if (a === "inbox-walk") body.decline = true;
  // An offer letter: the employer sends (or revises) it; the candidate decides on it — always the person, never an agent.
  if (a === "inbox-letter-send") {
    const f = k => document.querySelector(`[data-letter="${CSS.escape(itemId)}"][data-k="${k}"]`)?.value?.trim() ?? "";
    body.letter = { role: f("role"), start: f("start"), validUntil: f("validUntil"), mode: f("mode"), probation: f("probation"), notice: f("notice"), note: f("note"), ...(f("salary") ? { salary: Number(f("salary")) } : {}) };
    if (!body.letter.start || !body.letter.validUntil) return toast("Pick a start date and the last day the offer is open.");
  }
  // A decision made for a demo person (their phone is simulated) says whose it is.
  const as = item.owner !== session.uid ? shortName(live.engagements.get(item.engagementId)?.[item.side]?.name ?? "") || null : null;
  if (a === "inbox-letter-withdraw") { if ((await ask({ title: "Don't make an offer?", detail: "Their agent is told politely, and the application ends.", ok: "Don't make an offer", cancel: "Keep it open", danger: true, as })) === null) return; body.decline = true; }
  if (a === "inbox-offer-accept") { if ((await ask({ title: "Accept this offer?", detail: "It's sealed into the signed deal record. Joining comes next.", ok: "Accept offer", as })) === null) return; body.confirm = true; }
  if (a === "inbox-offer-decline") { const why = await ask({ title: "Decline this offer?", detail: "The conversation ends politely.", ok: "Decline offer", danger: true, as, input: { label: "Why (optional — they'll see it)", placeholder: "e.g. I've accepted another offer" } }); if (why === null) return; body.decline = true; body.text = why; }
  if (a === "inbox-offer-changes") {
    body.changes = document.querySelector(`[data-changes="${CSS.escape(itemId)}"]`)?.value.trim() ?? "";
    if (body.changes.length < 3) return toast("Say what you'd like changed.");
  }
  if (a === "inbox-move") {
    const limit = Number(document.querySelector(`[data-limit="${CSS.escape(itemId)}"]`)?.value);
    if (!(limit > 0)) return toast("Set an amount.");
    const e = live.engagements.get(item.engagementId);
    const key = item.side === "requester" ? `brief:${e.briefId}` : `fact:${e.offer.factId}`;
    const prev = (await api("/api/limits").catch(() => [])).find(l => l.key === key)?.mandate;
    body.mandate = item.side === "requester"
      ? { price: { opening: prev?.price.opening ?? Math.round(limit * 0.9), limit }, terms: {}, maxRounds: Math.min(12, (prev?.maxRounds ?? 5) + 3) }
      : { price: { opening: e.offer.price ?? limit, limit }, terms: {}, maxRounds: Math.min(12, (prev?.maxRounds ?? 5) + 3) };
  }
  busy(el, true);
  live.inbox = live.inbox.filter(i => i.id !== itemId);
  // A decision the server can't take as it is (a past start date…) comes back to fix, not lost until the next refresh.
  try {
    await api(`/api/inbox/${itemId}`, body);
    if (body.text && item.kind === "answer" && item.owner === session.uid) toast("Sent. Your agent gives this answer itself the next time it's asked.");
  } catch (err) { toast(err.message, null, "error"); }
  await refresh(openScreen);
}

// MARK: - Driving the requester's side

const running = new Set();
async function run(engagementId) {
  if (running.has(engagementId)) return;
  running.add(engagementId);
  try {
    for (let i = 0; i < 6; i++) {
      const e = await api(`/api/engagements/${engagementId}/run`, {});
      live.engagements.set(e.id, e);
      paintContent(true);
      if (!e.outbox) break;
    }
  } catch (err) { toast(err.message, null, "error"); } finally { running.delete(engagementId); refresh(openScreen); }
}

/** The server's policy for this account (quotas left today, currencies, features), shown instead of fixed numbers. */
async function loadPolicy() { try { session.policy = await api("/api/policy"); paintContent(true); } catch {} }

/** Whether this owner has a deal waiting for their payment (Google Pay's script is then loaded ahead of the tap). */
function toPay() {
  for (const e of live.engagements.values()) {
    const seller = e.seller ?? "provider", mine = e.requester.uid === session.uid ? "requester" : "provider";
    if (e.payment?.status === "awaiting" && mine !== seller) return true;
  }
  return false;
}

/** A run that stopped mid-way (time limit) left its next turn in the outbox: carry on. */
function driveRequester() {
  // A demo requester's phone is simulated: the person talking to them runs their agent's turns.
  for (const e of live.engagements.values()) if (e.outbox && (e.requester.uid === session.uid || e.requester.uid?.startsWith("demo-"))) run(e.id);
}

// An installed app can stay open for days: coming back to it checks the deployed version, and reloads into a new one
// (unless something is being typed).
const readVersion = () => fetch("/version.txt", { cache: "no-store" }).then(r => (r.ok ? r.text() : null)).then(t => t?.trim() || null).catch(() => null);
let version = null;
readVersion().then(v => { version = v; });
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  // Coming back to the app (an installed one is often resumed, not restarted): look for a new deployment first.
  navigator.serviceWorker?.getRegistration?.().then(r => r?.update()).catch(() => {});
  const v = await readVersion();
  if (shouldReload(version, v, !!document.querySelector("input:focus, textarea:focus"))) location.reload();
});
// The service worker serves the app from this device and checks for a new version in the background.
// A push that arrives while Collab is open shows here (the system shows it when Collab is closed).
addEventListener("collab-push", e => {
  const n = e.detail ?? {};
  notice({ title: n.title ?? "Collab", body: n.body ?? "", kind: "attention", label: "Your agent", action: "Open", onClick: () => openLink(n.link) });
  refresh(openScreen);
});
navigator.serviceWorker?.addEventListener("message", e => {
  // A notification tapped while Collab is open: go there, without a reload.
  if (e.data?.type === "collab-open") { openLink(e.data.link); return; }
  // A new deployment took over: reload into it now, unless the owner is in the middle of typing.
  if (e.data?.type === "collab-updated") {
    if (!document.querySelector("input:focus, textarea:focus")) location.reload();
    else notice({ title: "A new version of Collab is ready", kind: "info", label: "Update", action: "Reload", onClick: () => location.reload(), ttl: 15000 });
  }
});

// Started last, once everything above is defined.
// Anything that stops start-up shows a way back instead of a blank page.
try {
await signIn();
if (!session.uid && !session.fresh) { root.innerHTML = `<div class="setup"><div class="card">${brand()}<p>Sign-in isn't available on this server.</p></div></div>`; throw new Error("no auth"); }
// A returning visitor: their profile and (from a QR) the person they're opening load side by side. A first visit has
// no profile yet, so the start screen shows at once.
if (session.uid) {
  setOwner(session.uid);
  const to = new URLSearchParams(location.search).get("to");
  if (to) person(to);
  S.profile = await api("/api/me").catch(() => null);
}
if (!S.profile) await setup();
setOwner(session.uid);
await boot();
timing("app");
// A screen drawn from what was kept repaints when the server's answer differs.
onFreshRead(() => paintContent(true));
// On a wide screen, what your agents are doing (Activity) sits beside the chat from the start.
if (sideBySide() && S.screen === "chat") { S.screen = "requests"; paint(); }
// Links from notifications, the installed app's shortcuts and QR codes open the right place.
{
  const qp = new URLSearchParams(location.search);
  if (qp.get("calendar")) {
    toast({ linked: "Google Calendar linked — your busy times now block bookings.", declined: "Google Calendar wasn't linked — you said no on Google's page.", failed: "Couldn't link Google Calendar — try again, or paste the calendar's iCal address instead." }[qp.get("calendar")] ?? "Calendar: done.");
    history.replaceState(null, "", location.pathname);
  }
  else if (location.search) openLink(location.pathname + location.search);
}

} catch (err) {
  if (!document.querySelector("#app")) root.innerHTML = `<main class="setup"><section class="card"><h1 class="headline">Couldn't open Collab</h1><p>${esc(err.message || "Check your connection and try again.")}</p><a class="btn accent" href="/">Try again</a></section></main>`;
}

export { S, engagementCard };
