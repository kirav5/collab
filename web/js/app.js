// Collab on the web: one chat with your agent (it remembers, answers from your notes, shapes requests with Gemini and
// publishes what you offer), every conversation your agent has with other people's agents as live cards, and the
// screens Collab has for what your agent knows (Context), who you know (People), who sees what (Sharing), what your
// agents are doing (Requests) and what was shared (Activity).
import { shouldReload } from "./version.js";
import { api, insightsLines, ios, session, signIn, standalone } from "./api.js";
import { chat, detectNano, engine, itemOf, refreshNotesCache, startDevice, drafts } from "./agent.js";
import { local, setOwner } from "./local.js";
import { live, needsYou, onChange, refresh, start } from "./live.js";
import { engagementCard, messageHTML } from "./cards.js";
import { payWithGoogle, preload as preloadGooglePay } from "./gpay.js";
import { screens } from "./screens.js";
import { $, busy, esc, id, label, money, now, tag, toast } from "./ui.js";

const S = { profile: null, sessions: [], current: null, screen: "chat", focus: null, sending: false };
const root = $("#root");

// MARK: - Boot

async function setup() {
  const to = new URLSearchParams(location.search).get("to")?.replace(/[^\w-]/g, "").slice(0, 24);
  const google = session.user && !session.user.isAnonymous;
  const suggest = (session.user?.email ?? "").split("@")[0].toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24);
  return new Promise(resolve => {
    root.innerHTML = `<div class="setup"><form class="card" id="setup">
      ${label("Collab", "sq ink")}
      <h1 class="headline">Your agent. <span class="soft">Your private context is never shared.</span></h1>
      ${to ? `<p class="small">You're opening <b>@${esc(to)}</b>'s agent. Start your own first — it takes ten seconds.</p>` : ""}
      ${session.google ? (google
        ? `<p class="small muted">Signed in as <b>${esc(session.user.email ?? session.user.displayName ?? "Google")}</b> — this identity follows you to any device.</p>`
        : `<button type="button" class="btn google" id="google"><svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true"><path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z"/><path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z"/><path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z"/><path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z"/></svg> Continue with Google</button>
           <p class="small faint">Keeps your handle, context and deals on every device. Already have Collab? This signs you back in.</p>
           <div class="or"><span>or start as a guest</span></div>`) : ""}
      <p class="small muted">Pick a handle — it's your agent's address (A2A) that other people's agents reach you at.</p>
      <input class="field" name="name" placeholder="Your name" required maxlength="60" value="${esc(session.user?.displayName ?? "")}">
      <div class="row" style="flex-wrap:nowrap"><span class="faint">@</span><input class="field" name="handle" placeholder="handle" required minlength="3" maxlength="24" autocapitalize="none" value="${esc(suggest.length >= 3 ? suggest : "")}"></div>
      <input class="field" name="area" placeholder="Your area (e.g. Indiranagar, Bengaluru)" value="Bengaluru">
      <p class="small faint">Only a neighbourhood is ever used — never your exact location.</p>
      <button class="btn accent">Start</button><p class="small" id="setup-err" style="color:var(--danger)"></p></form></div>`;
    const g = $("#google");
    if (g) g.onclick = async () => {
      busy(g, true, "Opening Google");
      try {
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
        S.profile = await api("/api/me", { name: f.get("name"), handle: String(f.get("handle")).toLowerCase(), areaName: f.get("area") });
        resolve();
      } catch (err) { $("#setup-err").textContent = err.message; busy(b, false); }
    };
  });
}

async function boot() {
  detectNano().then(() => paintSidebar());
  // Offline: a banner, cached conversations, and (with the on-device model) answers from the notes on this device.
  refreshNotesCache();
  loadPolicy();
  addEventListener("online", () => { toast("Back online."); refreshNotesCache(); paint(); });
  addEventListener("offline", () => { toast(engine.nano ? "Offline — questions about your notes are answered on this device." : "Offline — showing what's saved on this device."); paint(); });
  S.sessions = (await local.all("sessions")).sort((a, b) => b.updatedAt - a.updatedAt);
  S.current = S.sessions[0]?.id ?? null;
  syncChats();
  document.addEventListener("visibilitychange", () => { if (!document.hidden) syncChats(); });
  root.innerHTML = `<div class="app" id="app">
    <aside class="sidebar" id="sidebar"></aside>
    <section class="main"><div class="topbar" id="topbar"></div><div class="content" id="content"></div>
      <div class="composer" id="composer"><form class="box" id="compose">
        <div class="bar"><input id="input" autocomplete="off" placeholder="Ask anything — remember, find, offer…" aria-label="Message your agent"><button class="send" id="send" aria-label="Send">↑</button></div>
        <div class="row" id="composer-note"></div></form></div></section></div>`;
  $("#compose").onsubmit = e => { e.preventDefault(); send($("#input").value); };
  document.addEventListener("click", onClick);
  document.addEventListener("change", onEdit);
  document.addEventListener("input", onEdit);
  document.addEventListener("keydown", e => {
    const f = e.target.dataset?.followup;
    if (f && e.key === "Enter") { e.preventDefault(); document.querySelector(`[data-act="eng-ask"][data-id="${CSS.escape(f)}"]`)?.click(); }
  });
  start(openScreen);
  startDevice();
  onChange(() => { paintSidebar(); paintContent(true); driveRequester(); if (toPay()) preloadGooglePay(); });
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
  const n = needsYou().length;
  const groups = groupSessions(S.sessions);
  const html = `<header>${label("Collab", "sq ink")}<span class="end"><button class="engine-chip ${!navigator.onLine ? "offline" : engine.nano ? "peri" : "accent"}" data-act="screen" data-screen="settings"
      title="Which AI runs your agent — tap for details">${!navigator.onLine ? `● Offline${engine.nano ? " · on-device AI" : ""}` : `✦ ${engine.nano ? "Gemini Nano · on this device" : "Powered by Gemini"}`}</button></span></header>
    <div class="scroll">
      ${n ? `<button class="btn accent needs" data-act="screen" data-screen="requests"><span class="dot pulse"></span> ${n} request${n === 1 ? "" : "s"} need you »</button>` : ""}
      <button class="btn" data-act="new-chat">+ New chat</button>
      ${!session.pushOn || (!standalone() && (session.install || ios())) ? `<div class="row" style="gap:6px">
        ${!standalone() && (session.install || ios()) ? `<button class="btn quiet compact" data-act="${session.install ? "install" : "screen"}" data-screen="settings">📲 Install app</button>` : ""}
        ${!session.pushOn && session.push ? `<button class="btn quiet compact" data-act="screen" data-screen="settings">🔔 Turn on notifications</button>` : ""}</div>` : ""}
      ${groups.map(g => `<div class="stack" style="gap:4px">${label(g.title)}${g.items.map(s => `<button class="session ${S.screen === "chat" && s.id === S.current ? "on" : ""}" data-act="open-session" data-id="${esc(s.id)}">${esc(s.title)}</button>`).join("")}</div>`).join("") || `<p class="small faint">No chats yet. Every chat is kept here, on this device.</p>`}
      <div class="nav">${label("Your agent")}
        ${navRow("context", "▤", "Context", "")}
        ${navRow("people", "◎", "People", "")}
        ${navRow("sharing", "◈", "Sharing", "")}
        ${navRow("requests", "⇄", "Requests", live.engagements.size ? String(live.engagements.size) : "")}
        ${navRow("activity", "≡", "Activity", "")}
        ${navRow("settings", "⚙", "Settings", "")}
      </div>
      <div class="stack" style="gap:4px">${label("Your agent's address (A2A)")}<a class="small" href="/a2a/${esc(S.profile.handle)}/.well-known/agent-card.json" target="_blank" rel="noopener">@${esc(S.profile.handle)} · agent card ↗</a>
        ${session.google && session.user?.isAnonymous ? `<button class="btn quiet compact" data-act="screen" data-screen="settings">Guest · keep it with Google</button>` : session.user?.email ? `<span class="small faint">${esc(session.user.email)}</span>` : ""}</div>
    </div>`;
  if (el.dataset.html !== html) { el.innerHTML = html; el.dataset.html = html; }
}

const navRow = (screen, ico, title, trail) => `<button class="${S.screen === screen ? "on" : ""}" data-act="screen" data-screen="${screen}"><span class="ico">${ico}</span>${title}<span class="trail">${esc(trail)}</span></button>`;

function groupSessions(list) {
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const t = today.getTime() / 1000;
  const g = [{ title: "Today", items: list.filter(s => s.updatedAt >= t) }, { title: "Earlier", items: list.filter(s => s.updatedAt < t) }];
  return g.filter(x => x.items.length);
}

function paintTop() {
  const cur = S.sessions.find(s => s.id === S.current);
  const titles = { context: "Context", people: "People", sharing: "Sharing", requests: "Requests", activity: "Activity", settings: "Settings" };
  $("#topbar").innerHTML = `<button class="btn quiet compact menu" data-act="nav">☰</button>${label(S.screen === "chat" ? (cur?.title ?? "New chat") : titles[S.screen], "sq ink")}
    <span class="end small faint">@${esc(S.profile.handle)}</span>`;
  $("#composer").hidden = S.screen !== "chat";
  $("#input").placeholder = cur?.to ? `Ask ${cur.toName ?? "their"}'s agent…` : "Ask anything — remember, find, offer…";
  $("#composer-note").innerHTML = label(engine.nano ? "Private notes are read on this device (Gemini Nano)" : "Private notes are never shared · Gemini sees only what a request needs");
}

let painting = false, lastHTML = "";
let again = null;
async function paintContent(soft = false) {
  const el = $("#content");
  if (!el) return;
  // One paint at a time; a paint asked for meanwhile runs right after (a hard one wins over a soft one).
  if (painting) { again = again === false ? false : soft; return; }
  // A live refresh never rewrites what the owner is typing.
  if (soft && el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) return;
  painting = true;
  try {
    const nearBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 60;
    const html = `<div class="inner">${S.screen === "chat" ? await chatHTML() : await screens[S.screen].html(S)}</div>`;
    // Nothing changed: leave the page as it is (no flicker, nothing under the pointer replaced).
    if (soft && html === lastHTML) return;
    lastHTML = html;
    el.innerHTML = html;
    if (S.screen === "chat" && (nearBottom || !soft)) el.scrollTop = el.scrollHeight;
    if (S.focus) { document.querySelector(`[data-engagement="${CSS.escape(S.focus)}"]`)?.scrollIntoView({ block: "center" }); S.focus = null; }
  } finally {
    painting = false;
    if (again !== null) { const next = again; again = null; paintContent(next); }
  }
}

// Saved-note cards show the note as it is now (it may have moved tier on another screen); fetched at most every 20 s.
let factsCache = null;
function savedFacts() {
  if (!factsCache || Date.now() - factsCache.at > 20_000) factsCache = { at: Date.now(), map: api("/api/facts").then(fs => new Map(fs.map(f => [f.id, f]))).catch(() => new Map()) };
  return factsCache.map;
}

async function chatHTML() {
  const cur = S.sessions.find(s => s.id === S.current);
  if (!cur || !cur.messages.length) return emptyChat();
  if (cur.messages.some(m => m.cards?.some(c => c.type === "saved"))) {
    const facts = await savedFacts();
    for (const m of cur.messages) for (const c of m.cards ?? []) if (c.type === "saved") c.fact = facts.get(c.factId) ?? c.fact;
  }
  return cur.messages.map(messageHTML).join("");
}

function emptyChat() {
  const tiles = [["Remember", "Remember that I teach guitar on weekends and I'm free after 6 pm", ""],
    ["Find anything", "Need a 2BHK to rent in Indiranagar, budget 36,000 a month, I have a small dog", "peri"],
    ["Offer something", "I teach tabla online and at home in Jayanagar, ₹700 an hour, lowest 600", ""],
    ["Your context", "What did I note about guitar?", ""]];
  return `<h1 class="headline">Ask your agent. <span class="soft">It asks anyone's agent for anything — and your private context is never shared.</span></h1>
    <div class="grid-tiles">${tiles.map(([l, p, c]) => `<button class="tile ${c}" data-act="prompt" data-text="${esc(p)}">${label(l, "sq " + (c ? "peri" : ""))}<p>${esc(p)}</p><span class="arrow">↗</span></button>`).join("")}</div>
    <div class="card">${label("Who sees what", "sq")}
      <dl class="kv"><dt>${tag("Only me", "peri")}</dt><dd>Private. Stored with your account, but no rule can name it and no one else's agent ever sees it.</dd>
      <dt>${tag("Protected", "accent")}</dt><dd>Shared with the people your rules name, on the topics they name — answered by your always-on agent, or checked with you first.</dd>
      <dt>${tag("Public", "fresh")}</dt><dd>Anyone's agent can find it and be told it. What you offer lives here.</dd></dl>
      <p class="small muted">Requests go agent-to-agent over A2A. Your agent never reveals your limit, and anything it can't answer from what you shared comes to you.</p></div>`;
}

// MARK: - Direct chats (QR codes and links)

/** A chat with one person's or shop's agent, opened by scanning their QR code (or a /?to=handle link). */
async function openDirect(handle) {
  handle = String(handle).replace(/^@/, "").toLowerCase();
  const p = await api(`/api/people/${encodeURIComponent(handle)}`).catch(() => null);
  if (!p) return toast(`No one is called @${handle}.`);
  if (p.profile.uid === session.uid) return toast("That's your own QR code.");
  let cur = S.sessions.find(x => x.to === handle);
  if (!cur) {
    cur = { id: id(), title: `${p.profile.name} (@${handle})`, to: handle, toName: p.profile.name, updatedAt: now(),
      messages: [{ id: id(), role: "agent", text: "", at: now(), cards: [{ type: "store", profile: p.profile, facts: p.facts }] }] };
    await saveSession(cur);
  }
  S.current = cur.id;
  openScreen("chat");
}

/** In a direct chat, what you type goes to their agent (the first message opens the conversation). */
async function sendDirect(cur, text) {
  const open = cur.engagementId ? live.engagements.get(cur.engagementId) : null;
  const e = open && !["agreed", "closed", "declined"].includes(open.phase)
    ? await api(`/api/engagements/${open.id}/ask`, { text })
    : await api(`/api/people/${encodeURIComponent(cur.to)}/ask`, { text });
  cur.engagementId = e.id;
  live.engagements.set(e.id, e);
  // One live card per conversation: it moves to the latest message.
  for (const m of cur.messages) m.cards = (m.cards ?? []).filter(c => !(c.type === "engagement" && c.id === e.id));
  run(e.id);
  return { text: `Asked ${cur.toName ?? "their"}'s agent.`, cards: [{ type: "engagement", id: e.id }] };
}

// MARK: - Sessions

async function saveSession(s) { s.updatedAt = now(); await local.put("sessions", s); S.sessions = [s, ...S.sessions.filter(x => x.id !== s.id)]; upload(s); }

// Chat history also lives in the account (owner-only), so the installed app, other browsers and other devices show
// the same chats. Uploads wait a moment so a burst of edits is one write.
const pending = new Map();
function upload(s) {
  clearTimeout(pending.get(s.id));
  pending.set(s.id, setTimeout(() => { pending.delete(s.id); api("/api/chats", { chat: s }).catch(() => {}); }, 1500));
}

/** Brings in chats saved from other devices and sends up the ones only this device has (older chats included). */
async function syncChats() {
  const remote = await api("/api/chats").catch(() => null);
  if (!remote) return;
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

async function send(text) {
  text = text.trim();
  if (!text || S.sending) return;
  S.sending = true;
  $("#input").value = "";
  let cur = S.sessions.find(s => s.id === S.current);
  if (!cur) { cur = { id: id(), title: text.slice(0, 48), messages: [], updatedAt: now() }; S.current = cur.id; }
  const user = { id: id(), role: "user", text, at: now() };
  const reply = { id: id(), role: "agent", text: "", at: now(), pending: "Thinking", cards: [] };
  cur.messages.push(user, reply);
  await saveSession(cur);
  S.screen = "chat";
  paint();
  try {
    const recent = cur.messages.filter(m => m.role === "user").slice(-5, -1).map(m => m.text);
    // The latest request in this chat, so "try a wider area" or "up to 600" changes it.
    const open = cur.messages.slice(0, -2).flatMap(m => (m.cards ?? []).filter(c => c.type === "brief" && c.draft)).at(-1) ?? null;
    const r = cur.to ? await sendDirect(cur, text) : await chat(text, recent, S.profile.area, open);
    Object.assign(reply, r, { pending: null, engine: r.cards?.some(c => c.on === "device") ? "Gemini Nano · on device" : "Gemini" });
  } catch (e) {
    Object.assign(reply, { pending: null, text: e.status === 429 ? e.message : `Something went wrong: ${e.message}` });
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

function openScreen(screen, focus) { S.screen = screen; S.focus = focus ?? null; $("#app")?.classList.remove("nav-open"); paint(); }

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
    if (k === "limit") {
      const n = Number(v);
      f.c.draft.mandate = n > 0 ? { price: { opening: Math.round(n * 0.9), limit: n }, terms: {}, maxRounds: session.policy?.negotiation?.maxRounds ?? 5 } : null;
      f.c.draft.need.maxPrice = n > 0 ? n : null;
      if (e.type === "change") insightsLines({ side: "requester", category: f.c.draft.need.category, area: f.c.draft.need.place.name, limit: n > 0 ? n : null, unit: f.c.draft.need.unit, item: itemOf(f.c.draft) })
        .then(ls => { f.c.insights = ls; saveSession(f.s); paintContent(true); });
    }
  }
  if (f.c.type === "offer") { if (k === "floor") f.c.floor = Number(v) || null; else if (k !== "autonomy" && k !== "days") f.c[k] = v; }
  if (e.type === "change") { saveSession(f.s); if (k === "autonomy") paintContent(true); }
}

async function onClick(e) {
  const el = e.target.closest("[data-act]");
  if (!el) return;
  const a = el.dataset.act;
  try {
    if (a === "nav") return $("#app").classList.toggle("nav-open");
    if (a === "screen") return openScreen(el.dataset.screen);
    if (a === "install") { if (session.install && await session.install()) toast("Installed — open Collab from your home screen or apps."); return paint(); }
    if (a === "new-chat") { S.current = null; return openScreen("chat"); }
    if (a === "open-session") { S.current = el.dataset.id; return openScreen("chat"); }
    if (a === "prompt") { $("#input").value = el.dataset.text; $("#input").focus(); return; }
    if (a === "send-text") return send(el.dataset.text);
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
    if (a === "eng-outcome") { busy(el, true); await api(`/api/engagements/${el.dataset.id}/outcome`, { happened: el.dataset.happened === "1" }); await refresh(openScreen); return; }
    if (a === "eng-pay" || a === "eng-paid-outside") {
      // Google Pay (TEST) first, inside the tap; then the AP2 step. One idempotency key per tap: a retry of the same
      // request can't pay twice.
      let googlePay;
      if (el.dataset.gpay) { googlePay = await payWithGoogle(Number(el.dataset.amount), el.dataset.item ?? "Collab"); if (!googlePay) return; }
      busy(el, true, a === "eng-pay" ? "Paying" : "Saving");
      const body = a === "eng-pay" ? { idempotencyKey: el.dataset.key ??= crypto.randomUUID(), ...(googlePay ? { googlePay } : {}) } : {};
      const e = await api(`/api/engagements/${el.dataset.id}/${a === "eng-pay" ? "pay" : "paid-outside"}`, body);
      live.engagements.set(e.id, e);
      toast(a === "eng-pay" ? "Paid — test mode, no money moved. Their agent has the payment." : "Marked as paid outside the app.");
      return refresh(openScreen);
    }
    if (a === "nearby") {
      busy(el, true, "Asking Google Maps");
      const box = el.closest(".card").querySelector("[data-nearby]");
      try {
        const r = await api("/api/nearby", { item: el.dataset.item, area: el.dataset.area });
        box.innerHTML = r.places.length ? `<div class="stack" style="gap:6px">${r.places.map(p => `<a class="small" href="${esc(p.uri)}" target="_blank" rel="noopener noreferrer">📍 ${esc(p.title)}</a>`).join("")}
          <span class="small faint">${esc(r.note)} · Source: Google Maps · ${r.remaining} left today</span></div>` : `<span class="small muted">Google Maps found nothing close that fits.</span>`;
      } finally { busy(el, false); }
      loadPolicy();
      return;
    }
    if (a === "price-check") {
      busy(el, true, "Checking sources");
      const box = el.parentElement.querySelector("[data-price-result]");
      try {
        const r = await api("/api/price-check", { item: el.dataset.item, area: el.dataset.area });
        box.innerHTML = `<div class="card"><b>${r.status === "evidence" ? `${money(r.low)}–${money(r.high)} · typical ${money(r.typical)}/${esc(r.unit)}` : "Not enough comparable evidence"}</b><span class="small">${esc(r.note)}</span>${r.items.map(i => `<p class="small">${esc(i.label)} · ${money(i.price)}/${esc(i.unit)} ${i.sources.map(s => `<a href="${esc(s.url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || "Source")}</a>`).join(" · ")}</p>`).join("")}<span class="small faint">Only you see this · ${r.remaining} checks left today · ${new Date(r.checkedAt * 1000).toLocaleString()}</span></div>`;
        if (r.searchEntryPoint) { const frame = document.createElement("iframe"); frame.title = "Google Search suggestions"; frame.sandbox = "allow-popups allow-popups-to-escape-sandbox"; frame.srcdoc = r.searchEntryPoint; frame.style.cssText = "width:100%;border:0;min-height:110px"; box.append(frame); }
      } finally { busy(el, false); }
      loadPolicy();
      return;
    }
    if (a === "eng-pickup") {
      busy(el, true);
      const p = await api(`/api/engagements/${el.dataset.id}/pickup`);
      const link = `${location.origin}${p.path}`;
      let qr = "";
      try { qr = await (await import("https://esm.sh/qrcode@1.5.4")).default.toString(link, { type: "svg", margin: 1 }); } catch {}
      document.querySelector(`[data-pickup="${CSS.escape(el.dataset.id)}"]`).innerHTML = `<div class="card"><div class="qr" aria-label="Pickup QR">${qr}</div><b>${p.collectedAt ? `Already collected at ${esc(new Date(p.collectedAt * 1000).toLocaleString())}` : "✓ Paid (test mode) · Not collected yet"}</b><a class="btn secondary" href="${esc(link)}">Open pickup pass</a><span class="small faint">Show this pass to the seller. Keep the link private.</span></div>`;
      return;
    }
    if (a === "eng-delivered" || a === "eng-received") {
      const ok = el.dataset.ok !== "0";
      const note = a === "eng-received" && !ok ? (prompt("What went wrong? (optional)") ?? "") : "";
      busy(el, true);
      const e = await api(`/api/engagements/${el.dataset.id}/${a === "eng-delivered" ? "delivered" : "received"}`, a === "eng-delivered" ? {} : { ok, note });
      live.engagements.set(e.id, e);
      toast(a === "eng-delivered" ? "Marked delivered — the buyer will confirm." : ok ? "Thanks — the seller will see it arrived as agreed." : "Problem reported to the seller.");
      return refresh(openScreen);
    }
    if (a === "eng-receipt") {
      busy(el, true);
      const box = document.querySelector(`[data-receipt="${CSS.escape(el.dataset.id)}"]`);
      const r = await api(`/api/engagements/${el.dataset.id}/receipt`);
      const when = t => new Date(t * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
      const by = s => (r.confirmedBy[s] === "mandate" ? "their standing instruction" : "the owner");
      box.innerHTML = `<div class="receipt">
        <div class="row">${r.matches ? tag("✓ Verified", "fresh") : tag(r.registered ? "Changed since agreed" : "Not registered", "danger")}
          <span class="small">${esc(r.parties.requester.name)} ↔ ${esc(r.parties.provider.name)} · <b>${money(r.terms.price, r.terms.unit)}</b></span></div>
        <span class="small muted">“${esc(r.terms.title)}” · agreed ${when(r.at)}${r.registeredAt ? ` · registered ${when(r.registeredAt)}` : ""}</span>
        <a class="btn secondary compact" href="${esc(r.verifyPath)}" target="_blank" rel="noopener">Public verification & download</a><span class="small faint">Anyone with that link can view the receipt.</span>
        <details class="more"><summary>How this is checked</summary>
          <span class="small muted">When both sides confirmed, Collab hashed the terms, both parties and the time (SHA-256) and registered that hash. Verify recomputes it from the conversation: any change to price, terms or parties breaks the match. Confirmed by ${by("requester")} (requester) and ${by("provider")} (provider).</span>
          <code class="small" style="overflow-wrap:anywhere">${esc(r.hash)}</code></details>
        ${r.payment ? `<details class="more"><summary>Payment (AP2) · ${r.payment.status === "paid" ? "paid" : r.payment.status === "outside" ? "settled outside the app" : "waiting"}</summary>
          <dl class="kv small">
            <dt>Cart Mandate</dt><dd>${money(r.payment.cart.total.value, r.terms.unit)} · issued by @${esc(r.payment.cart.merchant.handle)}'s agent · ${r.payment.check?.cartOk ? tag("✓ signature valid, matches the deal", "fresh") : tag("doesn't match", "danger")}</dd>
            ${r.payment.mandate ? `<dt>Payment Mandate</dt><dd>signed by @${esc(r.payment.mandate.payer)}'s agent, for that cart · ${r.payment.check?.paymentOk ? tag("✓ signature valid", "fresh") : tag("doesn't match", "danger")}</dd>
            <dt>Payment</dt><dd>${esc(r.payment.paymentId)} · test mode, no money moved</dd>` : ""}
            ${r.payment.ap2 ? `<dt>AP2 v0.2 checkout</dt><dd>${esc(r.payment.ap2.checkout.id)} · authorised by @${esc(r.payment.ap2.checkout.merchant.handle)}'s agent (detached JWS) · ${r.payment.check?.ap2?.merchantOk ? tag("✓ valid", "fresh") : tag("doesn't match", "danger")}</dd>
            <dt>AP2 mandates</dt><dd>Checkout + Payment Mandates (SD-JWT) by @${esc(r.payment.ap2.checkout.buyer.handle)}'s agent, bound to the checkout hash · ${r.payment.check?.ap2?.mandatesOk ? tag("✓ valid", "fresh") : tag("doesn't match", "danger")}</dd>
            <dt>Instrument</dt><dd>${r.payment.ap2.instrument.type === "google_pay" ? `Google Pay (TEST) · ${esc(r.payment.ap2.instrument.description ?? r.payment.ap2.instrument.network ?? "card")}` : "Test payment"} · no money moved</dd>` : ""}
          </dl>
          <span class="small muted">AP2 (Agent Payments Protocol): the seller's agent signs a cart for exactly the agreed terms; the buyer's agent signs a payment against that cart only after the buyer taps Pay. The payment goes to the seller's agent over A2A.</span></details>` : ""}</div>`;
      return;
    }
    if (screens[S.screen]?.act && await screens[S.screen].act(a, el, S, { paint, toast, openScreen, openDirect })) return;
    const f = findCard(el);
    if (!f) return;
    await cardAction(a, el, f);
  } catch (err) { toast(err.message); busy(el, false); }
}

async function cardAction(a, el, { s, m, c }) {
  const d = c.draft;
  if (a === "brief-strength") { const r = d.shared.requirements[Number(el.dataset.j)]; r.strength = r.strength === "required" ? "preferred" : "required"; const nf = d.need.filters.find(x => x.label === r.label); if (nf) nf.strength = r.strength; }
  if (a === "brief-drop") { const [r] = d.shared.requirements.splice(Number(el.dataset.j), 1); d.need.filters = d.need.filters.filter(x => x.label !== r.label); }
  if (a === "brief-dropq") { const [q] = d.shared.questions.splice(Number(el.dataset.j), 1); d.need.mustAsk = d.need.mustAsk.filter(x => x !== q); }
  if (a === "brief-clarify") {
    // The owner's answer becomes part of the request, and Gemini reads it again (filters, brief, next questions).
    const q = d.clarify[Number(el.dataset.j)], opt = q.options[Number(el.dataset.k)];
    busy(el, true, "Updating");
    c.text = `${c.text}. ${q.question.replace(/\?$/, "")}: ${opt}`;
    const r = await api("/api/briefs/draft", { text: c.text, here: S.profile.area, category: d.need.category });
    if (r.draft) { const keep = d.mandate; c.draft = r.draft; if (keep && !r.draft.mandate) c.draft.mandate = keep;
      c.insights = await insightsLines({ side: "requester", category: r.draft.need.category, area: r.draft.need.place.name, limit: c.draft.mandate?.price.limit, unit: r.draft.need.unit, item: itemOf(r.draft) }); }
  }
  if (a === "brief-send") {
    busy(el, true, "Searching");
    const r = await api("/api/briefs", { need: d.need, shared: d.shared, delegate: d.mandate ? { mandate: d.mandate, autonomy: c.autonomy ?? "ask", days: c.days ?? 7 } : null });
    // Real matches first (only the best one pre-ticked); sellers that fit but cost more than the limit come last, unticked.
    Object.assign(c, { step: "matches", briefId: r.brief.id, found: [...r.found, ...(r.overBudget ?? []).map(f => ({ ...f, over: true }))], rankedByModel: r.rankedByModel, picked: r.found.length ? [0] : [] });
  }
  if (a === "watch") {
    // A scheduled agent for this request: it searches again every hour and alerts the owner (push, if allowed).
    busy(el, true, "Starting");
    await api("/api/watches", { briefId: c.briefId, seen: (c.found ?? []).map(f => f.fact.id), every: 60, days: 14 });
    c.watching = true;
    if (session.push && "Notification" in window && Notification.permission === "default") session.push().then(() => toast("Notifications on — you'll hear when someone new fits.")).catch(() => {});
    await refresh(openScreen);
  }
  if (a === "brief-engage") {
    const picks = (c.picked ?? []).map(j => c.found[j]).filter(Boolean);
    if (!picks.length) return toast("Choose at least one person.");
    busy(el, true, "Contacting");
    const es = await api(`/api/briefs/${c.briefId}/engage`, { providers: picks.map(p => ({ factId: p.fact.id })) });
    c.step = "engaged"; c.engaged = es.map(x => x.id);
    for (const x of es) { live.engagements.set(x.id, x); m.cards.push({ type: "engagement", id: x.id }); }
    await saveSession(s); paint();
    for (const x of es) run(x.id);
    return;
  }
  if (a === "offer-publish") {
    busy(el, true, "Publishing");
    const fact = await api("/api/facts", { tier: "public", text: c.publicText ?? c.text, negotiable: !!(c.offer && c.floor && c.floor < c.offer.price.amount) });
    if (c.offer && c.floor) {
      const mandate = { price: { opening: c.offer.price.amount, limit: Math.min(c.floor, c.offer.price.amount) }, terms: {}, maxRounds: session.policy?.negotiation?.maxRounds ?? 5 };
      await api(`/api/facts/${fact.id}/limit`, { mandate, autonomy: c.autonomy ?? "ask", days: c.days ?? 7 });
    }
    c.step = "published"; c.publicText = fact.text;
  }
  if (a === "tier") await setTier(c.fact, el.dataset.tier, el);
  await saveSession(s);
  paint();
}

/** Moving a fact between tiers: all three live on the server; Private is stored but never shared. */
async function setTier(fact, tier, el) {
  if (!fact || fact.tier === tier) return;
  busy(el, true);
  const saved = await api("/api/facts", { id: fact.id, tier, text: fact.text });
  factsCache = null;
  if (tier === "protected") toast(`Protected under: ${saved.topics.join(", ")}. Add a rule in Sharing to say who sees it.`, () => openScreen("sharing"));
}

async function inboxAction(a, el) {
  const itemId = el.dataset.id;
  const item = live.inbox.find(i => i.id === itemId);
  if (!item) return;
  const body = {};
  if (a === "inbox-answer") { body.text = document.querySelector(`[data-reply="${CSS.escape(itemId)}"]`)?.value.trim(); if (!body.text) return toast("Write an answer, or choose “I'd rather not say”."); }
  if (a === "inbox-share") body.text = drafts.get(itemId)?.text;
  if (a === "inbox-approve") body.share = true;
  if (a === "inbox-decline") { body.decline = true; body.share = false; }
  if (a === "inbox-confirm") body.confirm = true;
  if (a === "inbox-walk") body.decline = true;
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
  await api(`/api/inbox/${itemId}`, body);
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
  } catch (err) { toast(err.message); } finally { running.delete(engagementId); refresh(openScreen); }
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
  for (const e of live.engagements.values()) if (e.outbox && e.requester.uid === session.uid) run(e.id);
}

// An installed app can stay open for days: coming back to it checks the deployed version, and reloads into a new one
// (unless something is being typed).
const readVersion = () => fetch("/version.txt", { cache: "no-store" }).then(r => (r.ok ? r.text() : null)).then(t => t?.trim() || null).catch(() => null);
let version = null;
readVersion().then(v => { version = v; });
document.addEventListener("visibilitychange", async () => {
  if (document.hidden) return;
  const v = await readVersion();
  if (shouldReload(version, v, !!document.querySelector("input:focus, textarea:focus"))) location.reload();
});
// The service worker serves the app from this device and checks for a new version in the background.
// A push that arrives while Collab is open shows here (the system shows it when Collab is closed).
addEventListener("collab-push", e => {
  const n = e.detail ?? {};
  toast(`🔔 ${n.title ?? "Collab"} — ${n.body ?? ""}`, () => { if (n.link && n.link !== "/") location.href = n.link; });
  refresh(openScreen);
});
navigator.serviceWorker?.addEventListener("message", e => {
  if (e.data?.type === "collab-updated") toast("A new version of Collab is ready — tap to reload.", () => location.reload());
});

// Started last, once everything above is defined.
await signIn();
if (!session.uid) { root.innerHTML = `<div class="setup"><div class="card">${label("Collab", "sq ink")}<p>Sign-in isn't available on this server.</p></div></div>`; throw new Error("no auth"); }
setOwner(session.uid);
S.profile = await api("/api/me").catch(() => null);
if (!S.profile) await setup();
setOwner(session.uid);
await boot();
// Links from notifications, the installed app's shortcuts and QR codes open the right place.
{
  const qp = new URLSearchParams(location.search);
  if (qp.get("to")) openDirect(qp.get("to"));
  else if (qp.get("engagement")) openScreen("requests", qp.get("engagement"));
  else if (qp.get("alerts") || qp.get("screen") === "requests") openScreen("requests");
}

export { S, engagementCard };
