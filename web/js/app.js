// Collab on the web: one chat with your agent (it remembers, answers from your notes, shapes requests with Gemini and
// publishes what you offer), every conversation your agent has with other people's agents as live cards, and the
// screens Collab has for what your agent knows (Context), who you know (People), who sees what (Sharing), what your
// agents are doing (Requests) and what was shared (Activity).
import { api, insightsLines, session, signIn } from "./api.js";
import { chat, detectNano, engine, startDevice, drafts } from "./agent.js";
import { local, setOwner } from "./local.js";
import { live, needsYou, onChange, refresh, start } from "./live.js";
import { engagementCard, messageHTML } from "./cards.js";
import { screens } from "./screens.js";
import { $, busy, esc, id, label, money, now, tag, toast } from "./ui.js";

const S = { profile: null, sessions: [], current: null, screen: "chat", focus: null, sending: false };
const root = $("#root");

// MARK: - Boot

async function setup() {
  return new Promise(resolve => {
    root.innerHTML = `<div class="setup"><form class="card" id="setup">
      ${label("Collab", "sq ink")}
      <h1 class="headline">Your agent. <span class="soft">Your private context stays on this device.</span></h1>
      <p class="small muted">Pick a handle — it's your agent's address (A2A) that other people's agents reach you at.</p>
      <input class="field" name="name" placeholder="Your name" required maxlength="60">
      <div class="row" style="flex-wrap:nowrap"><span class="faint">@</span><input class="field" name="handle" placeholder="handle" required minlength="3" maxlength="24" autocapitalize="none"></div>
      <input class="field" name="area" placeholder="Your area (e.g. Indiranagar, Bengaluru)" value="Bengaluru">
      <p class="small faint">Only a neighbourhood is ever used — never your exact location.</p>
      <button class="btn accent">Start</button><p class="small" id="setup-err" style="color:var(--danger)"></p></form></div>`;
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
  S.sessions = (await local.all("sessions")).sort((a, b) => b.updatedAt - a.updatedAt);
  S.current = S.sessions[0]?.id ?? null;
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
  start(openScreen);
  startDevice();
  onChange(() => { paintSidebar(); paintContent(true); driveRequester(); });
  try { if ("Notification" in window && Notification.permission === "default") setTimeout(() => Notification.requestPermission().catch(() => {}), 4000); } catch {}
  paint();
}

// MARK: - Painting

function paint() { paintSidebar(); paintTop(); paintContent(); }

function paintSidebar() {
  const el = $("#sidebar");
  if (!el) return;
  const n = needsYou().length;
  const groups = groupSessions(S.sessions);
  const html = `<header>${label("Collab", "sq ink")}${tag("Web")}<span class="end">${tag(engine.nano ? "Gemini Nano on device" : "Gemini", engine.nano ? "peri" : "accent")}</span></header>
    <div class="scroll">
      ${n ? `<button class="btn accent needs" data-act="screen" data-screen="requests"><span class="dot pulse"></span> ${n} request${n === 1 ? "" : "s"} need you »</button>` : ""}
      <button class="btn" data-act="new-chat">+ New chat</button>
      ${groups.map(g => `<div class="stack" style="gap:4px">${label(g.title)}${g.items.map(s => `<button class="session ${S.screen === "chat" && s.id === S.current ? "on" : ""}" data-act="open-session" data-id="${esc(s.id)}">${esc(s.title)}</button>`).join("")}</div>`).join("") || `<p class="small faint">No chats yet. Every chat is kept here, on this device.</p>`}
      <div class="nav">${label("Your agent")}
        ${navRow("context", "▤", "Context", "")}
        ${navRow("people", "◎", "People", "")}
        ${navRow("sharing", "◈", "Sharing", "")}
        ${navRow("requests", "⇄", "Requests", live.engagements.size ? String(live.engagements.size) : "")}
        ${navRow("activity", "≡", "Activity", "")}
        ${navRow("settings", "⚙", "Settings", "")}
      </div>
      <div class="stack" style="gap:4px">${label("Your agent's address (A2A)")}<a class="small" href="/a2a/${esc(S.profile.handle)}/.well-known/agent-card.json" target="_blank" rel="noopener">@${esc(S.profile.handle)} · agent card ↗</a></div>
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
  $("#composer-note").innerHTML = label(engine.nano ? "Private notes are read on this device (Gemini Nano)" : "Private notes stay on this device · Gemini sees only what a request needs, nothing stored");
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

async function chatHTML() {
  const cur = S.sessions.find(s => s.id === S.current);
  if (!cur || !cur.messages.length) return emptyChat();
  const facts = new Map((await local.all("facts")).map(f => [f.id, f]));
  for (const m of cur.messages) for (const c of m.cards ?? []) if (c.type === "saved") c.fact = facts.get(c.factId) ?? c.fact;
  return cur.messages.map(messageHTML).join("");
}

function emptyChat() {
  const tiles = [["Remember", "Remember that I teach guitar on weekends and I'm free after 6 pm", ""],
    ["Find anything", "Need a 2BHK to rent in Indiranagar, budget 36,000 a month, I have a small dog", "peri"],
    ["Offer something", "I teach tabla online and at home in Jayanagar, ₹700 an hour, lowest 600", ""],
    ["Your context", "What did I note about guitar?", ""]];
  return `<h1 class="headline">Ask your agent. <span class="soft">It asks anyone's agent for anything — and your private context stays on this device.</span></h1>
    <div class="grid-tiles">${tiles.map(([l, p, c]) => `<button class="tile ${c}" data-act="prompt" data-text="${esc(p)}">${label(l, "sq " + (c ? "peri" : ""))}<p>${esc(p)}</p><span class="arrow">↗</span></button>`).join("")}</div>
    <div class="card">${label("Who sees what", "sq")}
      <dl class="kv"><dt>${tag("On device", "peri")}</dt><dd>Private. Only you and your device agent. Never stored on the server.</dd>
      <dt>${tag("Protected", "accent")}</dt><dd>Shared with the people your rules name, on the topics they name — answered by your always-on agent, or checked with you first.</dd>
      <dt>${tag("Public", "fresh")}</dt><dd>Anyone's agent can find it and be told it. What you offer lives here.</dd></dl>
      <p class="small muted">Requests go agent-to-agent over A2A. Your agent never reveals your limit, and anything it can't answer from what you shared comes to you.</p></div>`;
}

// MARK: - Sessions

async function saveSession(s) { s.updatedAt = now(); await local.put("sessions", s); S.sessions = [s, ...S.sessions.filter(x => x.id !== s.id)]; }

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
    const r = await chat(text, recent, S.profile.area);
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
      f.c.draft.mandate = n > 0 ? { price: { opening: Math.round(n * 0.9), limit: n }, terms: {}, maxRounds: 5 } : null;
      f.c.draft.need.maxPrice = n > 0 ? n : null;
      if (e.type === "change") insightsLines({ side: "requester", category: f.c.draft.need.category, area: f.c.draft.need.place.name, limit: n > 0 ? n : null, unit: f.c.draft.need.unit })
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
    if (a === "new-chat") { S.current = null; return openScreen("chat"); }
    if (a === "open-session") { S.current = el.dataset.id; return openScreen("chat"); }
    if (a === "prompt") { $("#input").value = el.dataset.text; $("#input").focus(); return; }
    if (a.startsWith("inbox-")) return inboxAction(a, el);
    if (a === "eng-close") { busy(el, true); await api(`/api/engagements/${el.dataset.id}/close`, {}); await refresh(openScreen); return; }
    if (a === "eng-outcome") { busy(el, true); await api(`/api/engagements/${el.dataset.id}/outcome`, { happened: el.dataset.happened === "1" }); await refresh(openScreen); return; }
    if (a === "eng-receipt") {
      busy(el, true);
      const box = document.querySelector(`[data-receipt="${CSS.escape(el.dataset.id)}"]`);
      const r = await api(`/api/engagements/${el.dataset.id}/receipt`);
      const market = await insightsLines({ side: el.dataset.side, category: el.dataset.cat, area: el.dataset.area, price: el.dataset.price || null, unit: el.dataset.unit });
      const confirmedBy = s => r.confirmedBy[s] === "mandate" ? "standing mandate" : "owner";
      const sig = s => (r.signatures[s] ? `${r.signatures[s].slice(0, 16)}…` : "—");
      box.innerHTML = `<div class="stack" style="gap:6px">
        ${market.length ? `<span class="small faint">${esc(market[0])}</span>` : ""}
        <span class="small">“${esc(r.terms.title)}” — <b>${money(r.terms.price, r.terms.unit)}</b></span>
        <span class="small faint">hash ${esc(r.hash.slice(0, 16))}… · requester signed (${confirmedBy("requester")}): ${esc(sig("requester"))} · provider signed (${confirmedBy("provider")}): ${esc(sig("provider"))}</span>
        <span class="small faint">Anyone with this engagement id can ask Collab to verify the hash.</span></div>`;
      return;
    }
    if (screens[S.screen]?.act && await screens[S.screen].act(a, el, S, { paint, toast, openScreen })) return;
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
      c.insights = await insightsLines({ side: "requester", category: r.draft.need.category, area: r.draft.need.place.name, limit: c.draft.mandate?.price.limit, unit: r.draft.need.unit }); }
  }
  if (a === "brief-send") {
    busy(el, true, "Searching");
    const r = await api("/api/briefs", { need: d.need, shared: d.shared, delegate: c.autonomy ? { mandate: d.mandate, autonomy: c.autonomy, days: c.days ?? 7 } : null });
    if (d.mandate) await local.put("limits", { id: `brief:${r.brief.id}`, mandate: d.mandate });
    Object.assign(c, { step: "matches", briefId: r.brief.id, found: r.found, rankedByModel: r.rankedByModel, picked: r.found.slice(0, 2).map((_, j) => j) });
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
    await local.put("facts", { id: fact.id, text: fact.text, tier: "public", topics: [], createdAt: fact.createdAt });
    if (c.offer && c.floor) {
      const mandate = { price: { opening: c.offer.price.amount, limit: Math.min(c.floor, c.offer.price.amount) }, terms: {}, maxRounds: 5 };
      await local.put("limits", { id: `fact:${fact.id}`, mandate });
      if (c.autonomy) await api(`/api/facts/${fact.id}/limit`, { mandate, autonomy: c.autonomy, days: c.days ?? 7 });
    }
    c.step = "published"; c.publicText = fact.text;
  }
  if (a === "tier") await setTier(c.fact, el.dataset.tier, el);
  await saveSession(s);
  paint();
}

/** Moving a fact between tiers: Private lives only here; Protected and Public are also on the server. */
async function setTier(fact, tier, el) {
  if (!fact || fact.tier === tier) return;
  busy(el, true);
  if (tier === "private") {
    if (fact.tier !== "private") await api(`/api/facts/${fact.id}/delete`, {}).catch(() => {});
    await local.put("facts", { ...fact, tier: "private", topics: [] });
  } else {
    const saved = await api("/api/facts", { id: fact.id, tier, text: fact.text });
    await local.put("facts", { id: saved.id, text: saved.text, tier, topics: saved.topics, createdAt: fact.createdAt });
    if (saved.id !== fact.id) await local.del("facts", fact.id);
    if (tier === "protected") toast(`Protected under: ${saved.topics.join(", ")}. Add a rule in Sharing to say who sees it.`, () => openScreen("sharing"));
  }
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
    const prev = (await local.get("limits", key))?.mandate;
    const mandate = item.side === "requester"
      ? { price: { opening: prev?.price.opening ?? Math.round(limit * 0.9), limit }, terms: {}, maxRounds: Math.min(12, (prev?.maxRounds ?? 5) + 3) }
      : { price: { opening: e.offer.price ?? limit, limit }, terms: {}, maxRounds: Math.min(12, (prev?.maxRounds ?? 5) + 3) };
    await local.put("limits", { id: key, mandate });
    body.mandate = mandate;
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

/** A run that stopped mid-way (time limit) left its next turn in the outbox: carry on. */
function driveRequester() {
  for (const e of live.engagements.values()) if (e.outbox && e.requester.uid === session.uid) run(e.id);
}

// Started last, once everything above is defined.
await signIn();
if (!session.uid) { root.innerHTML = `<div class="setup"><div class="card">${label("Collab", "sq ink")}<p>Sign-in isn't available on this server.</p></div></div>`; throw new Error("no auth"); }
setOwner(session.uid);
S.profile = await api("/api/me").catch(() => null);
if (!S.profile) await setup();
await boot();

export { S, engagementCard };
