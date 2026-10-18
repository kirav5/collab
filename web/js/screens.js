// The screens beside chat (Collab's Screens.swift): Context (what your agent knows, and who sees each thing),
// My card (QR, agent card, contacts), Privacy (rules for Protected topics, pause everything, what was shared), Activity
// (every conversation between agents, live) and Settings. Screen keys keep their old names so links keep working.
import { api, ios, session, standalone, cached } from "./api.js";
import { detectEngine, downloadModel, engine, setProcessingMode } from "./agent.js";
import { MODEL, removeGemma } from "./gemma.js";
import { me, others, refreshServing, removeDevice, renameDevice, setServe } from "./mydevices.js";
import { applicantsBoard, dealAmount, dealStage, defaultHours, engagementCard, hoursOk, hoursText, rulesList } from "./cards.js";
import { local } from "./local.js";
import { privacyFacts } from "./processing.js";
import { live, needsYou, needsYouCount } from "./live.js";
import { ask, avatarHTML, busy, byTag, esc, label, logo, money, shortName, tag, tierTag, time, icon } from "./ui.js";
import { listingRoles, rolesOf } from "./roles.js";
import { pendingWrites, saveNote } from "./outbox.js";

/** Rules read from a seller's words on the About me screen, waiting for them to confirm (by offering). */
const ctxRules = new Map();

/** One of a seller's terms, editable: its name and what it says, in their words. */
const termRow = (id, l = "", t = "") => `<div class="row small" style="flex-wrap:nowrap" data-term-row="${esc(id)}"><input class="field compact" data-term-label value="${esc(l)}" placeholder="Term" maxlength="40" style="max-width:130px" aria-label="Term"><input class="field" data-term-text value="${esc(t)}" placeholder="In your own words" maxlength="240" aria-label="What it says"></div>`;

/** What the agent shared, and with whom (Public and Protected answers only — Private never appears). */
async function sharedLog() {
  const items = await cached("/api/activity").catch(() => []);
  return { count: items.length, html: items.map(x => `<div class="card slim"><div class="row">${tag(x.tier === "protected" ? "Protected" : "Public", x.tier === "protected" ? "accent" : "fresh")}<b class="small">To ${esc(x.to)}</b><span class="end faint small">${new Date(x.at * 1000).toLocaleString()}</span></div>
    <span class="small faint">${esc(x.question)}</span><span class="small">→ ${esc(x.answer)}</span></div>`).join("") || `<p class="small muted">Nothing shared yet.</p>` };
}

/**
 * Insights, at the top of My card, for someone with at least one public offering: what to do first (Gemini's lines, or
 * the plain reading of the numbers when the model isn't there — the server checks every number either way), then the
 * numbers behind it in small tiles, each edged by what it is: wait (pink) for demand you missed, accent for demand you
 * could meet (asked near you, bought alongside yours), talk (periwinkle) for what people ask and what's coming, green for deals done.
 * Other people only ever appear as counts — the server sends nothing else. Read at most once a minute (each read is a
 * metered call); an empty part is left out, and a forecast is shown only when the response has one.
 */
/** The last insights card drawn (kept between repaints so the slot never flickers empty). */
let shopInsightsHTML = "";
/** My card's QR, drawn once for its link (the link doesn't change between repaints). */
let qrMemo = { link: "", svg: "" };

async function insightsCard() {
  const facts = await cached("/api/facts").catch(() => []);
  if (!facts.some(f => f.tier === "public" && f.offer)) return "";
  const i = await cached("/api/shop/insights", 60_000).catch(() => null);
  if (!i) return "";
  const n = x => Math.round(Number(x) || 0);
  const b = i.buyers ?? {}, f = i.forecast;
  // Visual panels, each only when it has something to show: bars for demand, a dot line for price, big numbers.
  const panel = (lbl, cls, body, sub = "") => `<div class="ins-panel ${cls}"><span class="label">${esc(lbl)}</span>${sub ? `<span class="ins-sub">${esc(sub)}</span>` : ""}${body}</div>`;
  const missed = (i.missed ?? []).slice(0, 3), maxW = Math.max(1, ...missed.map(m => n(m.wanted)));
  const prices = (i.prices ?? []).filter(p => p.listed != null).slice(0, 3);
  const next7 = f?.available ? (f.items ?? []).reduce((t, x) => t + n(x.next7), 0) : null;
  const panels = [
    missed.length && panel("Demand you missed", "wait", missed.map(m => `<div class="ins-bar"><div class="ins-bar-top"><span>${esc(m.item)}</span><span>${n(m.had)} had · <b>${n(m.wanted)}</b> wanted</span></div>
      <div class="ins-track"><i class="had" style="width:${(n(m.had) / maxW) * 100}%"></i><i style="width:${(n(m.wanted) / maxW) * 100}%"></i></div></div>`).join(""), "People wanted more than you had"),
    prices.length && panel("Listed vs agreed", "fresh", prices.map(p => { const lo = Math.min(p.agreed, p.listed) * 0.9, hi = Math.max(p.agreed, p.listed) * 1.05, x = v => ((v - lo) / (hi - lo)) * 100;
      return `<div class="ins-dot"><span>${esc(p.item)}</span><div class="ins-line" role="img" aria-label="Listed ${esc(money(p.listed))}, agreed ${esc(money(p.agreed))}"><i class="seg" style="left:${x(Math.min(p.agreed, p.listed))}%;width:${Math.abs(x(p.listed) - x(p.agreed))}%"></i><i class="pt listed" style="left:${x(p.listed)}%" title="Listed ${esc(money(p.listed))}"></i><i class="pt agreed" style="left:${x(p.agreed)}%" title="Agreed ${esc(money(p.agreed))}"></i></div><span class="ins-vals">${esc(money(p.agreed))} agreed <span class="faint">· ${esc(money(p.listed))} listed</span></span></div>`; }).join(""), "Median price agreed vs your listed price"),
    b.total && panel("Who deals with you", "talk", `<div class="ins-nums"><div><b>${n(b.total)}</b><span>People</span></div><div><b>${n(b.repeat)}</b><span>Came back</span></div><div><b>${n(b.atListed)}</b><span>Paid your price</span></div><div><b>${n(b.bargained)}</b><span>Bargained</span></div></div>`),
    (i.unmet ?? []).length && panel("Asked near you, not filled", "accent", `<div class="ins-pills">${i.unmet.slice(0, 4).map(u => `<span>${esc(u.item)}<b>${n(u.requests)}</b></span>`).join("")}</div>`),
    (i.together ?? []).length && panel("Often wanted together", "accent", `<div class="ins-pills">${i.together.slice(0, 4).map(t => `<span>${esc(t.item)}<b>${n(t.buyers)}</b></span>`).join("")}</div>`),
    (i.asked ?? []).length && panel("People ask most", "talk", `<ul class="ins-qs">${i.asked.slice(0, 4).map(a => `<li><span>${esc(a.question)}</span><span>×${n(a.times)}</span></li>`).join("")}</ul>`),
    next7 && panel("Next 7 days", "talk", `<div class="ins-big"><b>${next7}</b><span>requests expected near you · BigQuery forecast</span></div>`),
  ].filter(Boolean);
  const lines = (i.summary ?? []).filter(Boolean);
  const head = `<div class="row">${label("Insights", "sq ink")}<span class="small faint end">last ${n(i.days) || 30} days</span></div>`;
  if (!lines.length && panels.length <= 1) return `<div class="card insights">${head}<span class="small faint">Insights appear after your first conversations.</span></div>`;
  return `<div class="card insights">${head}
    ${lines.length ? `<div class="ins-say"><span class="label">What to do next${i.byModel ? " · Gemini" : ""}</span><ul>${lines.map(l => `<li>${esc(l)}</li>`).join("")}</ul></div>` : ""}
    <div class="ins-board">${panels.join("")}</div></div>`;
}

const frame = (lbl, title, body) => `<div class="stack" style="gap:6px">${label(lbl, "sq")}<h2 class="headline">${title}</h2></div>${body}`;

/** Every fact the owner has — all tiers live on the server under their account; Private is never shared. */
async function allFacts() {
  // Offline: the notes kept on this device, plus any saved offline that haven't synced yet (marked so).
  const online = await cached("/api/facts").catch(() => null);
  const queued = (await pendingWrites()).filter(w => w.path === "/api/facts").map(w => ({ ...w.body, queued: true, createdAt: Math.floor(w.at / 1000), topics: [] }));
  const base = online ?? (await local.get("facts", "notes").catch(() => null))?.items ?? [];
  const byId = new Map(base.map(f => [f.id, f]));
  for (const q of queued) byId.set(q.id, { ...byId.get(q.id), ...q });
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

/** Gemma's state on this device, and what the owner can do about it. */
function deviceAI() {
  const pct = engine.progress == null ? "" : ` ${Math.round(engine.progress * 100)}%`;
  switch (engine.status) {
    case "ready": case "downloaded": return `<span style="color:var(--fresh)">● ${MODEL.label} is on this device</span> — answers about your notes run here, even offline.
      <button class="btn quiet compact" data-act="gemma-remove">Remove (frees about 2 GB)</button>`;
    case "absent": return `Read your private notes offline, on this device. One-time 2 GB download.
      <button class="btn secondary compact" data-act="device-download">Download ${MODEL.label}</button>${engine.reason ? `<br><span class="small" style="color:var(--stale)">${esc(engine.reason)}</span>` : ""}`;
    case "downloading": return `${logo("live spinner")} Downloading ${MODEL.label}…${pct} <span class="small faint">You can keep using Collab; if it stops, it resumes where it left off.</span>`;
    case "loading": return `${logo("live spinner")} Loading ${MODEL.label} onto this device's GPU…`;
    case "error": return `<span style="color:var(--danger)">${MODEL.label} couldn't start: ${esc(engine.reason ?? "unknown error")}</span> <button class="btn secondary compact" data-act="device-download">Try again</button>`;
    case "checking": return `Checking…`;
    default: return `This device can't run Gemma${engine.reason ? `: ${esc(engine.reason)}` : "."} Your laptop or desktop can — and with the same Google account, it answers this device's questions (My devices, below).`;
  }
}

/** The account's devices: this one, the others, whether each has Gemma and answers for the rest. */
function myDevices() {
  if (session.user?.isAnonymous) return `<div class="card">${label("My devices", "sq")}<p class="small">Keep this account with Google (below), then sign in with it on your other devices.</p></div>`;
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 2 ? "online now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const row = d => `<div class="card slim"><div class="row"><b>${esc(d.name ?? "Device")}</b>${d.gemma ? tag(MODEL.label, "fresh") : tag("No Gemma", "")}${d.gemma && d.serve ? tag("Answers for my devices", "peri") : ""}<span class="end small faint">${ago(d.seen)}</span></div>
      <div class="row"><button class="btn quiet compact" data-act="device-remove" data-id="${esc(d.id)}">Remove</button></div></div>`;
  return `<div class="card">${label("My devices", "sq")}
    <p class="small muted">A device with ${MODEL.label} answers note questions for your others. The questions and answers between them are end-to-end encrypted; your notes themselves stay stored in your account.</p>
    <div class="card slim"><div class="row"><b>This device</b><input class="field compact" data-device-name value="${esc(me.name ?? "")}" maxlength="60" aria-label="This device's name"><button class="btn quiet compact" data-act="device-rename">Rename</button></div>
      <label class="row small" style="gap:6px"><input type="checkbox" data-act="device-serve" ${me.serve ? "checked" : ""} ${engine.here ? "" : "disabled"}> Answer questions from my other devices with ${MODEL.label}${engine.here ? "" : " (download it here first)"}</label>
      <span class="small faint">Keep Collab open on it (a tab or the installed app) for it to answer.</span></div>
    ${others.length ? others.map(row).join("") : `<p class="small faint">No other devices yet.</p>`}
    <details class="more"><summary>Add a device</summary><p class="small">On your other phone, tablet or computer, open <b>${esc(location.origin)}</b> (or scan your QR in People) and choose <b>Continue with Google</b> with the same Google account. It appears here by itself.</p></details>
  </div>`;
}


// MARK: - Communities: a place people share (an office park, an apartment block, a campus). Members post anything — a cab
// to share, an order to pool, a class on the terrace, a drill to borrow — and each post is shown the way it's understood.
const KIND = {
  trip: { name: "Trip", tone: "talk", join: "Take a seat", joined: "You have a seat", leave: "Give up my seat" },
  group: { name: "Group", tone: "peri", join: "Join in", joined: "You're in", leave: "Leave" },
  event: { name: "Event", tone: "wait", join: "I'm going", joined: "You're going", leave: "Not going" },
  ask: { name: "Ask", tone: "accent", join: "I can help", joined: "You offered to help", leave: "Take it back" },
  offer: { name: "Offer", tone: "fresh", join: "I'm interested", joined: "You're interested", leave: "Not any more" },
};
const SPACES = [["office", "Office"], ["apartment", "Apartment"], ["campus", "Campus"], ["neighbourhood", "Neighbourhood"], ["other", "Other"]];
/** Posts waiting to go up (checked in a preview first), by community. */
const postDrafts = new Map();

/** "Today, 9:00 am" · "Tomorrow, 7:30 pm" · "Sat 18 Oct, 9:00 am". */
function when(t) {
  if (!t) return "";
  const d = new Date(t * 1000), day = new Date(d), today = new Date();
  day.setHours(0, 0, 0, 0); today.setHours(0, 0, 0, 0);
  const n = Math.round((day - today) / 86_400_000);
  const name = n === 0 ? "Today" : n === 1 ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
  return `${name}, ${time(t)}`;
}
const localInput = t => { if (!t) return ""; const d = new Date(t * 1000); d.setMinutes(d.getMinutes() - d.getTimezoneOffset()); return d.toISOString().slice(0, 16); };
const at = p => (p ? [p.lat, p.lon].join(",") : "");
const short = p => esc(String(p?.name ?? "").split(",")[0]);

/** One post, drawn for what it is: a trip on a map, a group's progress, an event's date, or a plain ask or offer. */
function postCard(p, preview = false) {
  const k = KIND[p.kind] ?? KIND.ask, full = p.spots != null && (p.kind === "group" ? p.count + 1 >= p.spots : p.count >= p.spots);
  const head = `<div class="row">${tag(k.name, k.tone)}<b class="grow">${esc(p.title)}</b>${p.km != null && !preview ? `<span class="small faint">${p.km} km</span>` : ""}</div>`;
  let body = "";
  if (p.kind === "trip") {
    const seats = p.spots == null ? "" : ` · ${Math.max(0, p.spots - p.count)} of ${p.spots} seat${p.spots === 1 ? "" : "s"} free`;
    body = `${p.from && p.to ? `<div class="trip-map" data-from="${at(p.from)}" data-to="${at(p.to)}" aria-label="Map of the trip"></div>` : ""}
      <div class="trip-line"><span class="dot-from"></span><b>${p.from ? short(p.from) : "Where from?"}</b><span class="faint">→</span><span class="dot-to"></span><b>${p.to ? short(p.to) : "Where to?"}</b></div>
      <div class="small muted">${p.at ? esc(when(p.at)) : "Time to agree"}${seats}</div><div class="small faint trip-eta">&nbsp;</div>`;
  } else if (p.kind === "event") {
    const d = p.at ? new Date(p.at * 1000) : null;
    body = `<div class="row" style="align-items:stretch">${d ? `<div class="date-tile"><span>${d.toLocaleDateString([], { month: "short" })}</span><b>${d.getDate()}</b></div>` : ""}
      <div class="stack" style="gap:2px">${d ? `<span>${esc(when(p.at))}</span>` : `<span class="muted">Time to be set</span>`}${p.place ? `<span class="small muted">at ${short(p.place)}</span>` : ""}
      <span class="small faint">${p.count ? `${p.count} going` : "Be the first to go"}</span></div></div>`;
  } else if (p.kind === "group") {
    const have = p.count + 1, pct = p.spots ? Math.min(100, Math.round((have / p.spots) * 100)) : 0;
    body = p.spots ? `<div class="progress" role="img" aria-label="${have} of ${p.spots} people"><span style="width:${pct}%"></span></div>
      <div class="small muted">${have} of ${p.spots} people${full ? " — full" : ` · ${p.spots - have} more needed`}${p.place ? ` · ${short(p.place)}` : ""}${p.at ? ` · ${esc(when(p.at))}` : ""}</div>`
      : `<div class="small muted">${have} in so far${p.place ? ` · ${short(p.place)}` : ""}${p.at ? ` · ${esc(when(p.at))}` : ""}</div>`;
  } else {
    body = `${p.place || p.at ? `<div class="small muted">${[p.place ? short(p.place) : "", p.at ? esc(when(p.at)) : ""].filter(Boolean).join(" · ")}</div>` : ""}${p.count ? `<div class="small faint">${p.count} ${p.kind === "ask" ? "can help" : "interested"}</div>` : ""}`;
  }
  const words = p.text && p.text !== p.title ? `<p class="small" style="margin:0">${esc(p.text)}</p>` : "";
  if (preview) return `<div class="card post ${k.tone}" data-post="preview">${head}${body}${words}</div>`;
  const by = p.mine ? "You" : `${esc(p.ownerName)} <span class="faint">@${esc(p.ownerHandle)}</span>`;
  const actions = p.mine
    ? `${p.people?.length ? `<span class="small">In: ${p.people.map(x => `<button class="link" data-act="cm-message" data-handle="${esc(x.handle)}">${esc(x.name)}</button>`).join(", ")}</span>` : `<span class="small faint">No one yet — you'll get a notification.</span>`}
       <button class="btn quiet compact end" data-act="cm-close" data-id="${esc(p.id)}">Close</button>`
    : `${p.youJoined ? `${tag(k.joined, "fresh")}<button class="btn quiet compact" data-act="cm-join" data-id="${esc(p.id)}" data-leave="1">${k.leave}</button>`
         : `<button class="btn accent compact" data-act="cm-join" data-id="${esc(p.id)}" ${full ? "disabled" : ""}>${full ? (p.kind === "trip" ? "No seats left" : "Full") : k.join}</button>`}
       <button class="btn secondary compact" data-act="cm-message" data-handle="${esc(p.ownerHandle)}">Message</button>`;
  return `<div class="card post ${k.tone}" data-post="${esc(p.id)}" data-anim="post-${esc(p.id)}" data-anim-sig="${p.count}">${head}${body}${words}
    <div class="row small"><span class="faint">${by}</span></div><div class="row">${actions}</div></div>`;
}

/** The preview of what's about to go up, with only the details that kind needs to edit. */
function draftCard(d) {
  const kinds = Object.entries(KIND).map(([k, v]) => `<button class="chip ${d.kind === k ? "on" : ""}" aria-pressed="${d.kind === k}" data-act="cm-kind" data-kind="${k}">${v.name}</button>`).join("");
  const f = (name, lab, value, attrs = "") => `<label class="stack small" style="gap:4px">${lab}<input class="field compact" data-cm="${name}" value="${esc(value ?? "")}" ${attrs}></label>`;
  const fields = d.kind === "trip" ? [f("from", "From", d.fromName ?? d.from?.name ?? "", 'placeholder="Area"'), f("to", "To", d.toName ?? d.to?.name ?? "", 'placeholder="The community"'), f("at", "When", localInput(d.at), 'type="datetime-local"'), f("spots", "Seats", d.spots ?? "", 'type="number" min="1" max="6" placeholder="Any"')]
    : d.kind === "group" ? [f("spots", "People needed in all", d.spots ?? "", 'type="number" min="2" max="500" placeholder="No limit"'), f("place", "Where", d.placeName ?? d.place?.name ?? "", 'placeholder="Optional"'), f("at", "When", localInput(d.at), 'type="datetime-local"')]
    : [f("at", "When", localInput(d.at), 'type="datetime-local"'), f("place", "Where", d.placeName ?? d.place?.name ?? "", 'placeholder="Optional"')];
  return `<div class="card stack" data-cm-draft>${label("Preview — how members will see it", "sq")}
    ${postCard({ ...d, count: 0, km: null, from: d.fromName ? { name: d.fromName } : d.from, to: d.toName ? { name: d.toName } : d.to, place: d.placeName ? { name: d.placeName } : d.place }, true)}
    <div class="row small" style="gap:6px">${kinds}</div>
    <div class="cm-fields">${f("title", "Title", d.title, 'maxlength="80"')}${fields.join("")}</div>
    ${d.byModel === false ? `<span class="small faint">Pick what kind of post it is and add the details — Gemini wasn't available to read it.</span>` : ""}
    <div class="row"><button class="btn accent" data-act="cm-post">Post to members</button><button class="btn quiet" data-act="cm-draft-cancel">Edit the words</button></div></div>`;
}

/** A listing's text: what it says, then the "Label: value." details it carries as a list (plain notes stay as they are). */
function factText(f) {
  if (!f.offer) return `<span>${esc(f.text)}</span>`;
  const parts = f.text.split(/(?<=[.!?])\s+(?=[A-Z])/), head = [], kv = [];
  for (const p of parts) { const m = p.match(/^([A-Z][^.:?!]{1,40}):\s+(.{1,160}?)\.?$/); if (m && kv.length + head.length) kv.push([m[1], m[2]]); else head.push(p); }
  return `<span>${esc(head.join(" "))}</span>${kv.length ? `<dl class="kv">${kv.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}`;
}

/** The conversations as Activity last read them: goals and applicants are read again once any of them changes. */
let engSig = "";

export const screens = {
  context: {
    async html() {
      // Read together: stock and time slots for public offerings (what reservations hold and payments commit — other
      // people's reservations change them, so they're shared only briefly), linked systems, and the agent's rules.
      const [facts, resources, grants, limitList] = await Promise.all([allFacts(), cached("/api/resources", 3_000).catch(() => []), cached("/api/connectors", 15_000).catch(() => []), cached("/api/limits", 15_000).catch(() => [])]);
      const n = t => facts.filter(f => f.tier === t && f.source !== "chat" && f.source !== "answer").length;
      const ledgers = new Map(resources.map(r => [r.factId, r]));
      // A linked system, in plain words: what it does, whether it's working, and how (one tap away).
      const connected = r => grants.filter(g => g.resourceId === r.id && g.status !== "revoked").map(g => {
        const pos = g.provider === "inventory-webhook", gcal = g.provider === "google-calendar", last = g.lastEventAt ? new Date(g.lastEventAt * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
        const state = g.status === "degraded" ? `<span style="color:var(--danger)">not reporting${g.lastError ? ` — ${esc(g.lastError)}` : ""}</span>`
          : last ? `<span style="color:var(--fresh)">● working</span> · last update ${esc(last)}` : `<span class="faint">● linked · waiting for its first update</span>`;
        const how = pos ? "Each sale in your billing app is sent here, signed with the key you were given once. Collab checks the signature and takes those units off this count — so what agents say about your stock stays right without you updating it."
          : "Collab reads only the busy times from your calendar, every few minutes; a busy time can't be booked. Event titles and details stay in your calendar.";
        return `<div class="stack small" style="gap:2px"><div class="row small"><b>${pos ? "Linked to your billing app" : gcal ? "Linked to Google Calendar" : "Linked to your calendar"}</b><span>${state}</span></div>
          <details class="more"><summary>How it works</summary><span class="small muted">${how}</span></details>
          <div class="row">${pos ? "" : `<button class="btn quiet compact" data-act="conn-sync" data-id="${esc(g.id)}">Sync now</button>`}<button class="btn quiet compact" data-act="conn-revoke" data-id="${esc(g.id)}">${pos ? "Disconnect" : "Unlink"}</button></div></div>`;
      }).join("");
      const now_ = Date.now() / 1000;
      const stockRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const r = ledgers.get(f.id);
        if (!r) return `<div class="row small stock"><span class="faint">Availability not tracked — agents say you'll confirm.</span>
          <input class="field" type="number" min="0" style="max-width:90px" data-stock-new="${esc(f.id)}" placeholder="Qty" aria-label="How many you have"><button class="btn secondary compact" data-act="stock-track" data-id="${esc(f.id)}">Track stock</button>
          <button class="btn quiet compact" data-act="slots-track" data-id="${esc(f.id)}">Use time slots</button></div>`;
        if (r.type === "quantity") {
          const held = r.holds.filter(h => h.state === "held" && h.expiresAt > now_).reduce((n, h) => n + h.qty, 0);
          const low = r.onHand - held <= (session.policy?.stock?.lowAt ?? 3);
          return `<div class="row small stock"><b>Stock ${r.onHand}</b>${low ? tag(r.onHand - held > 0 ? "Low" : "Sold out", "danger") : ""}${held ? `<span class="faint">· ${held} reserved</span>` : ""}<span class="faint">· counted ${new Date(r.observedAt * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
            <input class="field" type="number" min="0" style="max-width:90px" data-stock="${esc(r.id)}" value="${r.onHand}" aria-label="Stock on hand"><button class="btn secondary compact" data-act="stock-set" data-id="${esc(r.id)}">Update</button></div>
            ${connected(r) || `<div class="row small"><button class="btn quiet compact" data-act="conn-pos" data-id="${esc(r.id)}">Connect billing software</button><span class="faint">its sales update this count</span></div>`}<div data-conn="${esc(r.id)}"></div>`;
        }
        const open = r.slots.filter(sl => sl.start > now_);
        const taken = sl => r.holds.filter(h => h.slotId === sl.id && (h.state === "committed" || (h.state === "held" && h.expiresAt > now_))).reduce((n, h) => n + h.qty, 0);
        const free = open.filter(sl => taken(sl) < sl.capacity), booked = open.length - free.length;
        const hrs = r.hours ?? defaultHours(f.offer), rid = esc(r.id);
        const fmt = t => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
        // One line says it all: the hours, how many free times are open, when the next one is, and how many are booked.
        const line = r.hours ? `${esc(hoursText(r.hours))} · ${r.hours.minutes} min each` : `${open.length} times set by hand`;
        const summary = `<span class="faint">${line}${free.length ? ` · next free ${esc(fmt(free[0].start))}` : open.length ? " · all booked" : ""}${booked ? ` · ${booked} booked` : ""}</span>`;
        return `<div class="stack small stock"><div class="row"><b>Bookable times</b>${summary}</div>
          <details class="more"><summary>${r.hours ? "Change hours" : "Set weekly hours"} or add a one-off time</summary>
          <div class="row">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip"><input type="checkbox" data-hours-day="${rid}" value="${d}" ${hrs.days.includes(d) ? "checked" : ""}> ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}</label>`).join("")}</div>
          <div class="row"><input class="field compact" type="time" data-hours-from="${rid}" value="${esc(hrs.from)}" style="max-width:120px" aria-label="Opens"><span>to</span><input class="field compact" type="time" data-hours-to="${rid}" value="${esc(hrs.to)}" style="max-width:120px" aria-label="Closes">
            <input class="field compact" type="number" min="10" max="480" step="5" data-hours-mins="${rid}" value="${hrs.minutes}" style="max-width:80px" aria-label="Minutes per booking"><span>min each</span></div>
          <div class="row"><button class="btn secondary compact" data-act="hours-save" data-id="${rid}">Save hours</button>${r.hours ? `<button class="btn quiet compact" data-act="hours-stop" data-id="${rid}">Stop weekly hours</button>` : ""}<span class="faint">Booked times always stay.</span></div>
          <div class="row" style="margin-top:6px"><span class="faint" style="min-width:110px">One-off time</span><input class="field compact" type="datetime-local" data-slot-start="${rid}" style="max-width:230px" aria-label="One-off time"><input class="field compact" type="number" min="15" step="15" style="max-width:80px" data-slot-mins="${rid}" value="60" title="Minutes"><button class="btn quiet compact" data-act="slot-add" data-id="${rid}">Add</button></div></details>
          ${connected(r) || calendarLink(r.id)}</div>`;
      };
      // Linking a calendar so its busy times block bookings: Google through its own sign-in (when the server has an
      // OAuth client); any calendar through its private iCal address (Google's "Secret address in iCal format").
      const calendarLink = rid => `<div class="row small"><button class="btn secondary compact" data-act="gcal-link" data-id="${esc(rid)}">Link Google Calendar</button><button class="btn quiet compact" data-act="cal-other" data-id="${esc(rid)}">Other calendar</button><span class="faint">busy times then block bookings</span></div>
        <div class="card slim stack" data-cal-other="${esc(rid)}" hidden style="gap:6px">
          <span class="small muted">Any calendar can share busy times through its private iCal address. In Google Calendar: Settings → your calendar → <b>Integrate calendar</b> → <b>Secret address in iCal format</b>.</span>
          <div class="row small"><input class="field" type="url" placeholder="Paste the secret iCal address (https://…)" data-ical="${esc(rid)}" aria-label="Secret iCal address"><button class="btn accent compact" data-act="conn-ical" data-id="${esc(rid)}">Link</button></div>
          <span class="faint small">Only busy times are read — titles and guests stay with your calendar.</span></div>`;
      // The seller's own terms for an offering, and instant booking: their words, a row to add one, and Gemini's
      // suggestions for this listing on request. No headings or examples are put in front of them.
      // The seller's rules for their agent, in their words: what's in force, and a box to change them.
      const limits = new Map(limitList.map(l => [l.key, l]));
      const rulesRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const l = limits.get(`fact:${f.id}`), id = esc(f.id);
        const now_ = [l ? `lowest ${money(l.limit)} (private)` : null, l?.autonomy === "close" ? (l.closeAt ? `closes on its own at ${money(l.closeAt)}+` : "closes on its own") : l ? "you confirm deals" : null,
          f.offer.maxPerBuyer ? `at most ${f.offer.maxPerBuyer} per person` : null].filter(Boolean).join(" · ");
        return `<details class="more"><summary>Your agent's rules${now_ ? ` · ${esc(now_)}` : " · none yet"}</summary>
          ${l?.rulesText ? `<span class="small faint">You said: “${esc(l.rulesText)}”</span>` : ""}
          <div class="row"><input class="field" style="flex:1;min-width:220px" data-ctx-rules="${id}" aria-label="Your agent's rules" placeholder="e.g. never below ₹400 each, max 10 per person, close yourself above ₹420"><button class="btn secondary compact" data-act="ctx-rules-read" data-id="${id}">Read my rules</button></div>
          <div data-ctx-rules-preview="${id}"></div></details>`;
      };
      const termsRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const ps = f.offer.policies ?? [], L = listingRoles(f.offer);
        return `<details class="more"><summary>Your terms for ${esc(L.responders)}${ps.length ? ` · ${ps.length} set` : ""}${f.offer.instant ? " · instant booking on" : ""}</summary>
          <p class="small muted">Shown on your card and sealed into each deal's receipt exactly as you write them. Collab never writes terms for you. Don't put a phone number or home address here unless you want every one of your ${esc(L.responders)} to see it.</p>
          ${ps.map(p => termRow(f.id, p.label, p.text)).join("")}${termRow(f.id)}
          ${L.pays ? "" : `<label class="row small" style="gap:6px"><input type="checkbox" data-instant="${esc(f.id)}" ${f.offer.instant ? "checked" : ""}> Accept orders at my listed price automatically (instant booking) — offers below it still come to you</label>`}
          <div class="row"><button class="btn secondary compact" data-act="terms-save" data-id="${esc(f.id)}">Save terms</button><button class="btn quiet compact" data-act="terms-suggest" data-id="${esc(f.id)}" data-category="${esc(f.offer.category)}" data-owner-pays="${f.offer.ownerPays ? "1" : ""}">Suggest terms for this offering</button></div></details>`;
      };
      // Your context is what you told your agent on purpose; what it picked up from chats and answers is kept apart.
      const learned = facts.filter(f => f.source === "chat" || (f.source === "answer" && f.question && f.answer)), days = facts.filter(f => f.source === "summary").sort((a, b) => b.createdAt - a.createdAt);
      const own = facts.filter(f => !learned.includes(f) && !days.includes(f));
      return frame("About me", "What your agent knows", `
        <div class="stats"><div>${label("Only me", "peri")}<b>${n("private")}</b></div><div>${label("Protected", "accent")}<b>${n("protected")}</b></div><div>${label("Public", "fresh")}<b>${n("public")}</b></div></div>
        <form class="card" data-form="add-fact">${label("Add to context", "sq")}
          <textarea class="field" name="text" rows="2" aria-label="Add to context" placeholder="e.g. My landlord is Kabir · I'm free weekday evenings · I teach guitar" required></textarea>
          <div class="row"><select class="field" name="tier" style="max-width:260px" aria-label="Who sees it"><option value="private">Private (not listed — your agent may use it)</option><option value="protected">People my rules name (Protected)</option><option value="public">Anyone (Public, discoverable)</option></select>
          <button class="btn" data-act="add-fact">Save</button></div></form>
        <div class="card slim">${label("Your daily agent", "peri")}<span class="small muted">Once a day it notes what you did — requests, deals, listings, answers — in your private context, so your agent remembers. Never shown to anyone.</span>
          ${days.slice(0, 3).map(f => `<div class="mem-row"><span class="small" style="flex:1;min-width:0">${esc(f.text)}</span><button class="btn quiet compact" data-act="fact-delete" data-id="${esc(f.id)}" aria-label="Forget this summary">Forget</button></div>`).join("")}
          <div class="row"><button class="btn secondary compact" data-act="summary-now">Summarise my last day now</button>${days.length > 3 ? `<span class="small faint">${days.length - 3} older</span>` : ""}</div></div>
        ${learned.length ? `<details class="card slim memory"><summary class="row"><span class="small"><b>${learned.length}</b> thing${learned.length === 1 ? "" : "s"} your agent learned from your chats and answers</span><span class="small faint end">Review ›</span></summary>
          <span class="small faint">Kept so you're never asked twice — used to answer others within your limits, never listed publicly.</span>
          ${learned.map(f => `<div class="mem-row"><div class="stack" style="gap:2px;min-width:0;flex:1"><span class="small">${esc(f.source === "answer" ? f.answer : String(f.text).replace(/^Asked: “[^”]*” — answer:\s*/, ""))}</span>${f.source === "answer" ? `<span class="small faint">${esc(f.question)}</span>` : ""}</div>
            <button class="btn quiet compact" data-act="fact-delete" data-id="${esc(f.id)}" aria-label="Forget this">Forget</button></div>`).join("")}</details>` : ""}
        <div class="stack">${own.map(f => `<div class="card slim"><div class="row">${tierTag(f.tier, f.topics)}${f.offer ? tag("offering") : ""}${f.source === "chat" ? tag("from chat") : ""}<span class="end faint small">${new Date(f.createdAt * 1000).toLocaleDateString()}</span></div>
          ${factText(f)}
          ${f.tier !== "public" ? `<div class="row small"><span class="faint">Your agent ${f.noShare ? "never uses this" : /₹|\brs\.?\s?\d|\brupees?\b|\$\s?\d|\binr\b|\b(budget|price limit|lowest|floor price|price floor|at most|go below|go above|won'?t (go|pay|take)|can'?t (go|pay)|afford|kam se kam|best price|cost(s|ing)?|charges?|margin|profit|paid|salary|ctc|lakh|crore)\b|\b(limit|budget|max|min)\b[^.]{0,12}\d|\b(up ?to|under|below|above|over|at least)\s*\d/i.test(f.text) ? "never repeats this (it mentions money)" : "answers others from this"}</span>
            <div class="seg compact end" role="group" aria-label="May your agent use this to answer others?"><button class="${f.noShare ? "" : "on"}" aria-pressed="${!f.noShare}" data-act="fact-use" data-id="${esc(f.id)}" data-use="1">Use</button><button class="${f.noShare ? "on" : ""}" aria-pressed="${!!f.noShare}" data-act="fact-use" data-id="${esc(f.id)}" data-use="0">Never</button></div></div>` : ""}
          ${stockRow(f)}${rulesRow(f)}${termsRow(f)}
          <div class="row">${["private", "protected", "public"].filter(t => t !== f.tier).map(t => `<button class="btn secondary compact" data-act="fact-tier" data-id="${esc(f.id)}" data-tier="${t}">Make ${{ private: "private", protected: "protected", public: "public" }[t]}</button>`).join("")}
            ${f.tier === "public" && f.offer && !f.offer.ownerPays ? `<button class="btn secondary compact" data-act="demo-customers" data-id="${esc(f.id)}" title="Simulated people nearby ask for this; their agents talk to yours">Try with demo customers</button>` : ""}
            <button class="btn danger compact end" data-act="fact-delete" data-id="${esc(f.id)}">Delete</button></div></div>`).join("") || `<p class="muted">Nothing yet. Tell your agent things in chat, or add them here.</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "fact-use") {
        busy(el, true);
        await api(`/api/facts/${encodeURIComponent(el.dataset.id)}/use`, { use: el.dataset.use === "1" });
        h.toast(el.dataset.use === "1" ? "Your agent answers others from this." : "Your agent never uses this to answer anyone.");
        await h.paint(); return true;
      }
      if (a === "fact-reuse") {
        busy(el, true);
        await api(`/api/facts/${encodeURIComponent(el.dataset.id)}/reuse`, { reuse: el.dataset.reuse === "1" });
        h.toast(el.dataset.reuse === "1" ? "Your agent answers this on its own." : "Your agent asks you first next time.");
        await h.paint(); return true;
      }
      if (a === "add-fact") {
        const form = el.closest("form"); const f = new FormData(form);
        const text = String(f.get("text") ?? "").trim(), tier = String(f.get("tier"));
        if (!text) return true;
        busy(el, true);
        // Something offered, added as Public, opens as an offering card first (what buyers would ask, floor kept private).
        if (tier === "public" && await h.publicIntake(text)) { form.reset(); return true; }
        const saved = await saveNote(api, { text, tier });
        if (saved.queued) h.toast("Saved on this device — it syncs to your account when you're back online.");
        h.paint(); return true;
      }
      if (a === "fact-tier") {
        busy(el, true);
        const f = (await allFacts()).find(x => x.id === el.dataset.id);
        if (f && el.dataset.tier === "public" && await h.publicIntake(f.text, f.id)) return true;
        if (f) await saveNote(api, { id: f.id, text: f.text, tier: el.dataset.tier });
        h.paint(); return true;
      }
      if (a === "ctx-rules-read") {
        const id = el.dataset.id, text = String(document.querySelector(`[data-ctx-rules="${CSS.escape(id)}"]`)?.value ?? "").trim();
        if (text.length < 4) { h.toast("Say your rules — e.g. “never below ₹400, close yourself above ₹420”.", null, "error"); return true; }
        busy(el, true, "Reading");
        try {
          // An owner who pays (an employer) sets a ceiling, not a floor.
          const pays = !!(await allFacts()).find(x => x.id === id)?.offer?.ownerPays;
          const r = await api("/api/rules/read", { text, side: pays ? "buyer" : "seller", factId: id });
          ctxRules.set(id, { text, rules: r.rules });
          document.querySelector(`[data-ctx-rules-preview="${CSS.escape(id)}"]`).innerHTML = `<div class="card slim">${rulesList(r.lines)}<div class="row"><button class="btn accent compact" data-act="ctx-rules-confirm" data-id="${esc(id)}">Confirm rules</button><span class="small faint">Nothing applies until you confirm. New rules replace the old ones.</span></div></div>`;
        } catch (err) { h.toast(err.message, null, "error"); }
        busy(el, false); return true;
      }
      if (a === "ctx-rules-confirm") {
        const p = ctxRules.get(el.dataset.id);
        if (!p) return true;
        busy(el, true, "Saving");
        try { const r = await api(`/api/facts/${el.dataset.id}/rules`, p); ctxRules.delete(el.dataset.id); h.toast(r.needsFloor ? "Saved — add your lowest price so your agent can negotiate." : "Saved — your agent follows these from now on."); }
        catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "terms-suggest") {
        // Suggestions fill empty fields (and add new headings); nothing is saved until the seller taps Save terms.
        busy(el, true, "Suggesting");
        const f = (await allFacts()).find(x => x.id === el.dataset.id);
        const r = await api("/api/terms/suggest", { category: el.dataset.category, text: f?.text ?? "", ownerPays: el.dataset.ownerPays === "1" }).catch(err => { h.toast(err.message, null, "error"); return null; });
        busy(el, false);
        if (!r) return true;
        if (!r.terms.length) { h.toast("Gemini couldn't suggest terms just now — try again in a moment, or write your own."); return true; }
        const panel = el.closest("details"), id = el.dataset.id;
        const rows = () => [...panel.querySelectorAll(`[data-term-row="${CSS.escape(id)}"]`)];
        for (const t of r.terms) {
          // A term the seller already wrote under the same name is left as it is; a new one gets its own row.
          const same = rows().find(x => x.querySelector("[data-term-label]").value.trim().toLowerCase() === t.label.toLowerCase());
          if (same) { const input = same.querySelector("[data-term-text]"); if (!input.value.trim()) input.value = t.text; continue; }
          const blank = rows().find(x => !x.querySelector("[data-term-label]").value.trim() && !x.querySelector("[data-term-text]").value.trim());
          (blank ?? rows().at(-1)).insertAdjacentHTML("beforebegin", termRow(id, t.label, t.text) + (t.sources?.length ? `<span class="small faint">As ${esc(listingRoles(f?.offer).owner)}s state it: ${t.sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || "source")}</a>`).join(" · ")}</span>` : ""));
        }
        h.toast("Suggested — edit anything, then Save terms. Nothing is saved yet.");
        return true;
      }
      if (a === "terms-save") {
        const id = el.dataset.id;
        const policies = [...document.querySelectorAll(`[data-term-row="${CSS.escape(id)}"]`)].map(r => ({ label: r.querySelector("[data-term-label]").value.trim(), text: r.querySelector("[data-term-text]").value.trim() })).filter(p => p.label && p.text);
        busy(el, true, "Saving");
        try { await api(`/api/facts/${encodeURIComponent(id)}/policies`, { policies, instant: !!document.querySelector(`[data-instant="${CSS.escape(id)}"]`)?.checked }); h.toast(`Saved — ${listingRoles((await allFacts()).find(x => x.id === id)?.offer).responders} see these terms on your card and receipts.`); }
        catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "stock-track" || a === "slots-track") {
        const qty = Number(document.querySelector(`[data-stock-new="${CSS.escape(el.dataset.id)}"]`)?.value);
        if (a === "stock-track" && !(Number.isInteger(qty) && qty >= 0)) { h.toast("Enter how many you have.", null, "error"); return true; }
        busy(el, true);
        try { await api("/api/resources", a === "stock-track" ? { factId: el.dataset.id, type: "quantity", onHand: qty } : { factId: el.dataset.id, type: "slots", slots: [] }); h.toast(a === "stock-track" ? "Stock tracked — deals now reserve it." : "Add your time slots below."); }
        catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "conn-pos") {
        busy(el, true);
        try {
          const r = await api("/api/connectors", { provider: "inventory-webhook", resourceId: el.dataset.id });
          // Plain words first; the two values to hand over behind copy buttons; the technical format for whoever sets it up.
          document.querySelector(`[data-conn="${CSS.escape(el.dataset.id)}"]`).innerHTML = `<div class="card slim">${label("Connect your billing software", "sq accent")}
            <span class="small">Give these to your POS or billing software; its sales update your stock. Shown once — keep the key private.</span>
            <div class="row"><span class="small" style="min-width:90px">Web address</span><button class="btn secondary compact" data-act="copy" data-value="${esc(r.eventsUrl)}">Copy</button></div>
            <div class="row"><span class="small" style="min-width:90px">Secret key</span><button class="btn secondary compact" data-act="copy" data-value="${esc(r.signingKey)}">Copy</button></div>
            <details class="more"><summary>For your developer</summary><code class="small" style="overflow-wrap:anywhere">${esc(r.eventsUrl)}</code><span class="small faint" style="overflow-wrap:anywhere">${esc(r.howTo)}</span></details></div>`;
        } catch (err) { h.toast(err.message, null, "error"); busy(el, false); }
        return true;
      }
      if (a === "copy") { try { await navigator.clipboard.writeText(el.dataset.value); h.toast("Copied."); } catch { h.toast("Couldn't copy — select it under “For your developer”."); } return true; }
      if (a === "gcal-link") {
        busy(el, true, "Opening Google");
        try { const r = await api(`/api/google/calendar/start?resourceId=${encodeURIComponent(el.dataset.id)}`); location.href = r.url; return true; }
        catch (err) { busy(el, false); h.toast(err.message, null, "error"); document.querySelector(`[data-cal-other="${CSS.escape(el.dataset.id)}"]`)?.removeAttribute("hidden"); return true; }
      }
      if (a === "cal-other") { const box = document.querySelector(`[data-cal-other="${CSS.escape(el.dataset.id)}"]`); if (box) box.hidden = !box.hidden; return true; }
      if (a === "conn-ical") {
        const url = document.querySelector(`[data-ical="${CSS.escape(el.dataset.id)}"]`)?.value.trim();
        if (!url) { h.toast("Paste your calendar's secret iCal address first.", null, "error"); return true; }
        // Google's public address only works for calendars made public; the secret one carries "/private-".
        if (/calendar\.google\.com/.test(url) && !/\/private-/.test(url)) { h.toast("That's the public address. Copy the “Secret address in iCal format” instead — it's a bit lower on the same settings page."); return true; }
        busy(el, true);
        try { const r = await api("/api/connectors", { provider: "ical", resourceId: el.dataset.id, url }); h.toast(r.grant.status === "degraded" ? `Connected, but the feed couldn't be read: ${r.grant.lastError}` : "Calendar linked — your busy times now block bookings."); }
        catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "conn-sync") { busy(el, true); const r = await api(`/api/connectors/${el.dataset.id}/sync`, {}).catch(e => ({ reason: e.message })); h.toast(r.synced ? `Synced — ${r.busy} busy times.` : `Couldn't sync: ${r.reason}`); h.paint(); return true; }
      if (a === "conn-revoke") {
        if ((await ask({ title: "Revoke this connection?", detail: "It stops changing your availability; until you recount, availability shows as unconfirmed.", ok: "Revoke", danger: true })) === null) return true;
        busy(el, true); await api(`/api/connectors/${el.dataset.id}/revoke`, {}); h.toast("Revoked."); h.paint(); return true;
      }
      if (a === "stock-set") {
        const qty = Number(document.querySelector(`[data-stock="${CSS.escape(el.dataset.id)}"]`)?.value);
        busy(el, true);
        try { await api(`/api/resources/${el.dataset.id}/stock`, { onHand: qty }); h.toast("Stock updated."); } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "hours-save" || a === "hours-stop") {
        const id = el.dataset.id, val = k => document.querySelector(`[data-hours-${k}="${CSS.escape(id)}"]`)?.value;
        const hours = a === "hours-stop" ? null : { days: [...document.querySelectorAll(`[data-hours-day="${CSS.escape(id)}"]:checked`)].map(i => Number(i.value)), from: val("from"), to: val("to"), minutes: Number(val("mins")) };
        if (hours && !hoursOk(hours)) { h.toast("Pick at least one day, and leave room for one booking between opening and closing.", null, "error"); return true; }
        busy(el, true);
        try { await api(`/api/resources/${id}/hours`, { hours, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); h.toast(hours ? "Saved — free times are ready two weeks ahead and refill on their own." : "Weekly hours stopped. Booked times stay."); }
        catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "slot-add") {
        const start = Date.parse(document.querySelector(`[data-slot-start="${CSS.escape(el.dataset.id)}"]`)?.value ?? "") / 1000;
        const mins = Number(document.querySelector(`[data-slot-mins="${CSS.escape(el.dataset.id)}"]`)?.value) || 60;
        if (!start || start < Date.now() / 1000) { h.toast("Pick a future date and time.", null, "error"); return true; }
        busy(el, true);
        try { await api(`/api/resources/${el.dataset.id}/slots`, { slots: [{ start, end: start + mins * 60, capacity: 1 }] }); h.toast("Slot added."); } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "summary-now") {
        busy(el, true, "Summarising");
        try { const r = await api("/api/me/summary", {}); h.toast(r.fact ? "Noted in your private context." : "Nothing to note from the last day yet."); }
        catch (err) { h.toast(err.message, null, "error"); }
        finally { busy(el, false); }
        h.paint(); return true;
      }
      if (a === "fact-delete") {
        if ((await ask({ title: "Delete this from your context?", ok: "Delete", danger: true })) === null) return true;
        busy(el, true);
        await api(`/api/facts/${el.dataset.id}/delete`, {}).catch(err => h.toast(err.message, null, "error"));
        h.paint(); return true;
      }
    },
  },

  people: {
    async html(S) {
      // Insights take a moment (they read a month of conversations and ask Gemini): the screen draws at once with the
      // last card (or a placeholder), and the card fills its slot when it's ready.
      insightsCard().then(h => { if (h === shopInsightsHTML) return; shopInsightsHTML = h; const slot = document.getElementById("shop-insights"); if (slot) slot.innerHTML = h; }).catch(() => {});
      const insights = `<div id="shop-insights">${shopInsightsHTML}</div>`;
      const card = `${location.origin}/a2a/${S.profile.handle}/.well-known/agent-card.json`;
      const link = `${location.origin}/?to=${encodeURIComponent(S.profile.handle)}`;
      const qrP = qrMemo.link === link ? Promise.resolve(qrMemo.svg) : import("/vendor/qrcode.js").then(m => m.default.toString(link, { type: "svg", margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } })).then(svg => (qrMemo = { link, svg }).svg).catch(() => ""); // offline: no QR
      // The card people get when they scan: who, what's on offer, and a record that comes from signed receipts.
      const [contacts, qr, facts, rec] = await Promise.all([cached("/api/contacts").catch(() => []), qrP, cached("/api/facts").catch(() => []), cached(`/public/people/${encodeURIComponent(S.profile.handle)}/record`, 60_000).catch(() => null)]);
      const offers = facts.filter(f => f.tier === "public" && f.offer && f.offer.status !== "sold");
      return frame("My card", "Share it — anyone can reach your agent", `
        <div class="card share-card">
          <div class="share-top">${avatarHTML(S.profile.name, S.profile.handle, 64)}<b class="share-name">${esc(S.profile.name)}</b>
            <span class="small faint">@${esc(S.profile.handle)}${S.profile.area?.name ? ` · ${esc(S.profile.area.name)}` : ""}</span>${S.profile.bio ? `<span class="small muted">${esc(S.profile.bio)}</span>` : ""}</div>
          <div class="share-stats"><div><b>${offers.length}</b><span>on offer</span></div><div><b>${rec?.verified ?? 0}</b><span>verified deals</span></div><div><b>${rec?.problems ?? 0}</b><span>problems</span></div></div>
          <div class="qr" aria-label="Your QR code">${qr}</div>
          <span class="small muted">Scan with any phone camera to talk to ${esc(S.profile.name.split(" ")[0])}'s agent — no app needed.</span>
          <div class="share-grid"><button class="btn accent" data-act="share-card" data-link="${esc(link)}" data-name="${esc(S.profile.name)}">Share</button>
            <button class="btn secondary" data-act="copy-link" data-link="${esc(link)}">Copy link</button>
            <a class="btn secondary" download="collab-${esc(S.profile.handle)}-qr.svg" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}">Save QR</a></div>
          <div class="share-grid quiet"><button class="btn quiet compact" data-act="preview-card">As others see it</button><button class="btn quiet compact" data-act="agent-card">Agent card ›</button><button class="btn quiet compact" data-act="scan">Scan a QR</button></div></div>
        <div id="scanner"></div>
        ${insights}
        <form class="card" data-form="add-contact">${label("Add someone by handle", "sq")}<div class="row"><input class="field" name="handle" placeholder="@handle" aria-label="Handle" style="max-width:260px"><button class="btn" data-act="add-contact">Add</button></div>
          <span class="small faint">Contacts can be named in rules (Privacy). Try @riya, @kabir, @arjun, @meera, @dev, @sana or @nikhil — demo people.</span></form>
        <div class="stack">${contacts.map(c => `<div class="card slim"><div class="row"><b>${esc(c.name)}</b><span class="faint small">@${esc(c.handle)}</span>${c.addedYou ? tag("Added you", "peri") : ""}
          <button class="btn secondary compact end" data-act="view-person" data-handle="${esc(c.handle)}">Public profile</button><button class="btn quiet compact" data-act="remove-contact" data-id="${esc(c.uid)}">Remove</button></div>
          <div id="person-${esc(c.handle)}"></div></div>`).join("") || `<p class="muted">No contacts yet.</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "copy-link") { await navigator.clipboard.writeText(el.dataset.link).catch(() => {}); h.toast("Link copied."); return true; }
      if (a === "share-card") {
        // The phone's own share sheet where there is one (WhatsApp, Messages…); otherwise the link is copied.
        const data = { title: `${el.dataset.name} on Collab`, text: `Talk to ${el.dataset.name}'s agent on Collab`, url: el.dataset.link };
        if (navigator.share) { await navigator.share(data).catch(() => {}); return true; }
        await navigator.clipboard.writeText(el.dataset.link).catch(() => {}); h.toast("Link copied — paste it anywhere."); return true;
      }
      if (a === "scan") { await scan(h); return true; }
      if (a === "add-contact") { const handle = new FormData(el.closest("form")).get("handle"); busy(el, true); await api("/api/contacts", { handle: String(handle).replace(/^@/, "") }); h.paint(); return true; }
      if (a === "remove-contact") { busy(el, true); await api("/api/contacts/remove", { uid: el.dataset.id }); h.paint(); return true; }
      if (a === "view-person") {
        busy(el, true);
        const p = await api(`/api/people/${el.dataset.handle}`);
        document.getElementById(`person-${el.dataset.handle}`).innerHTML = `<div class="stack" style="margin-top:8px">${p.profile.bio ? `<span class="small muted">${esc(p.profile.bio)}</span>` : ""}${p.stats?.deals ? `<span class="small faint">${p.stats.deals} deal${p.stats.deals === 1 ? "" : "s"} · ${p.stats.kept} went ahead</span>` : ""}${p.facts.map(f => `<div class="row">${tag("Public", "fresh")}<span class="small">${esc(f.text)}</span></div>`).join("") || `<span class="small faint">Nothing public.</span>`}<div class="row"><button class="btn accent compact" data-act="cm-message" data-handle="${esc(el.dataset.handle)}">Open their shop</button><a class="small faint" href="${esc(p.agentCard)}" target="_blank" rel="noopener" title="The machine-readable card other agents read">agent card ↗</a></div></div>`;
        busy(el, false); return true;
      }
    },
  },

  communities: {
    async html(S) {
      if (S.community) {
        let f;
        try { f = await api(`/api/communities/${S.community}`); }
        catch (e) { S.community = null; return frame("Communities", "Not a member", `<div class="card"><p>${esc(e.message)}</p><button class="btn" data-act="cm-back">All communities</button></div>`); }
        const c = f.community, show = S.cmTab ?? "all";
        const d = postDrafts.get(c.id);
        const count = k => f.posts.filter(p => p.kind === k).length;
        const tabs = [["all", `All ${f.posts.length}`], ...Object.entries(KIND).filter(([k]) => count(k)).map(([k, v]) => [k, `${v.name}s ${count(k)}`]), ...(f.offers.length + f.gigs.length ? [["listed", `Members' listings ${f.offers.length + f.gigs.length}`]] : [])];
        const posts = f.posts.filter(p => show === "all" || p.kind === show);
        const listing = x => `<div class="card slim post fresh"><div class="row"><b class="grow">${esc(x.title)}</b><span>${money(x.price, x.unit, x.currency)}</span></div>
          <div class="row small"><span class="faint">${x.mine ? "You" : `${esc(x.name)} @${esc(x.handle)}`} · ${short({ name: x.area })}</span>${x.mine ? "" : `<button class="btn secondary compact end" data-act="cm-message" data-handle="${esc(x.handle)}">Ask their agent</button>`}</div></div>`;
        return frame(SPACES.find(k => k[0] === c.kind)?.[1] ?? "Community", esc(c.name), `
          <div class="row small"><button class="btn quiet compact" data-act="cm-back">‹ All communities</button><span class="faint">${short(c.place)} · ${c.members} member${c.members === 1 ? "" : "s"}</span>
            <button class="btn quiet compact end" data-act="cm-leave" data-id="${esc(c.id)}">Leave</button></div>
          ${d ? draftCard(d) : `<form class="card stack" data-form="cm-compose">${label("Post to members", "sq ink")}
            <textarea class="field" name="text" rows="2" maxlength="400" aria-label="Post to members" placeholder="In your own words — e.g. “Cab from HSR to the office at 9 tomorrow, 2 seats” or “Anyone up for a bulk order of rice?”"></textarea>
            <div class="row"><button class="btn accent" data-act="cm-draft">Preview</button><span class="small faint">Gemini reads it into a trip, group, event, ask or offer. You check it before it goes up.</span></div></form>`}
          <div class="row" style="gap:6px;flex-wrap:wrap">${tabs.map(([k, t]) => `<button class="chip ${show === k ? "on" : ""}" aria-pressed="${show === k}" data-act="cm-tab" data-tab="${k}">${esc(t)}</button>`).join("")}</div>
          ${show === "listed" ? `${f.offers.length ? label("On offer") : ""}${f.offers.map(listing).join("")}${f.gigs.length ? label("Gigs and tasks") : ""}${f.gigs.map(listing).join("")}`
            : `<div class="stack">${posts.map(p => postCard(p)).join("") || `<p class="muted">Nothing posted yet. Be the first.</p>`}</div>
               ${show === "all" && f.offers.length + f.gigs.length ? `<div class="stack">${label("What members offer")}${[...f.offers, ...f.gigs].slice(0, 3).map(listing).join("")}${f.offers.length + f.gigs.length > 3 ? `<button class="btn quiet compact" data-act="cm-tab" data-tab="listed">See all ${f.offers.length + f.gigs.length}</button>` : ""}</div>` : ""}`}
          <details class="more"><summary>Members (${c.members})</summary><div class="row small" style="flex-wrap:wrap;gap:6px">${f.members.map(m => m.you ? tag("You", "ink") : `<button class="chip" data-act="cm-message" data-handle="${esc(m.handle)}">${esc(m.name)}</button>`).join("")}</div></details>`);
      }
      const l = await api("/api/communities");
      const area = S.profile.area?.name ?? "";
      return frame("Communities", "People who share a place", `
        <p class="muted" style="margin:0">Your office, building, campus or street. Share a cab, pool an order, run a class, lend a drill — only members see what's posted.</p>
        ${l.mine.length ? `<div class="tiles">${l.mine.map(c => `<button class="tile cm-tile" data-act="cm-open" data-id="${esc(c.id)}">${label(SPACES.find(k => k[0] === c.kind)?.[1] ?? "Community")}<b>${esc(c.name)}</b><span class="small faint">${short(c.place)} · ${c.members} member${c.members === 1 ? "" : "s"}</span></button>`).join("")}</div>` : ""}
        ${l.nearby.length ? `<div class="stack">${label(area ? `Near ${area.split(",")[0]}` : "Nearby")}${l.nearby.map(c => `<div class="card slim"><div class="row"><b class="grow">${esc(c.name)}</b><span class="small faint">${short(c.place)}${c.km != null ? ` · ${c.km} km` : ""} · ${c.members}</span>
            <button class="btn secondary compact" data-act="cm-join-community" data-id="${esc(c.id)}">Join</button></div></div>`).join("")}</div>` : ""}
        <details class="more" ${l.mine.length || l.nearby.length ? "" : "open"}><summary>Start a community</summary>
          <form class="stack" data-form="cm-create" style="margin-top:8px">
            <input class="field" name="name" maxlength="60" placeholder="Its name — e.g. Embassy Tech Village" aria-label="Community name">
            <div class="row small" style="gap:6px;flex-wrap:wrap">${SPACES.map(([k, t], i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" aria-pressed="${i === 0}" data-act="cm-space" data-kind="${k}">${t}</button>`).join("")}</div>
            <input type="hidden" name="kind" value="office">
            <input class="field" name="place" maxlength="80" value="${esc(area)}" placeholder="Area — e.g. Whitefield" aria-label="Area">
            <div class="row"><button class="btn accent" data-act="cm-create">Create</button><span class="small faint">Anyone nearby can find and join it.</span></div></form></details>`);
    },
    async act(a, el, S, h) {
      if (!a.startsWith("cm-")) return false;
      const form = el.closest("form");
      if (a === "cm-open") { S.community = el.dataset.id; S.cmTab = "all"; h.paint(); return true; }
      if (a === "cm-back") { S.community = null; h.paint(); return true; }
      if (a === "cm-tab") { S.cmTab = el.dataset.tab; h.paint(); return true; }
      if (a === "cm-space") { form.querySelectorAll('[data-act="cm-space"]').forEach(b => { b.classList.toggle("on", b === el); b.setAttribute("aria-pressed", String(b === el)); }); form.elements.kind.value = el.dataset.kind; return true; }
      if (a === "cm-create") {
        const f = new FormData(form);
        busy(el, true, "Creating");
        try { const c = await api("/api/communities", { name: f.get("name"), kind: f.get("kind"), place: f.get("place") }); S.community = c.id; h.toast(`${c.name} is ready. Share its name so people nearby can join.`); h.paint(); }
        catch (e) { busy(el, false); h.toast(e.message, null, "error"); }
        return true;
      }
      if (a === "cm-join-community") { busy(el, true); try { await api(`/api/communities/${el.dataset.id}/join`, {}); S.community = el.dataset.id; h.paint(); } catch (e) { busy(el, false); h.toast(e.message, null, "error"); } return true; }
      if (a === "cm-leave") { if ((await ask({ title: "Leave this community?", detail: "You can join again later.", ok: "Leave" })) === null) return true; await api(`/api/communities/${el.dataset.id}/join`, { leave: true }); S.community = null; h.paint(); return true; }
      if (a === "cm-message") { h.openDirect(el.dataset.handle); return true; }
      if (a === "cm-draft") {
        const text = String(new FormData(form).get("text") ?? "").trim();
        if (text.length < 4) { h.toast("Say what you'd like to post."); return true; }
        busy(el, true, "Reading");
        try { postDrafts.set(S.community, await api(`/api/communities/${S.community}/posts/draft`, { text })); h.paint(); }
        catch (e) { busy(el, false); h.toast(e.message, null, "error"); }
        return true;
      }
      const d = postDrafts.get(S.community);
      const box = el.closest("[data-cm-draft]");
      const val = k => box?.querySelector(`[data-cm="${k}"]`)?.value?.trim() ?? "";
      const keep = () => { if (!d || !box) return; d.title = val("title") || d.title; const t = val("at"); d.at = t ? Math.floor(new Date(t).getTime() / 1000) : null; const n = val("spots"); d.spots = n ? Number(n) : null; for (const k of ["from", "to", "place"]) if (box.querySelector(`[data-cm="${k}"]`)) d[`${k}Name`] = val(k); };
      if (a === "cm-kind" && d) { keep(); d.kind = el.dataset.kind; h.paint(); return true; }
      if (a === "cm-draft-cancel") { postDrafts.delete(S.community); h.paint(); return true; }
      if (a === "cm-post" && d) {
        keep();
        const place = k => (d[`${k}Name`] !== undefined ? d[`${k}Name`] : d[k]?.name ?? "");
        busy(el, true, "Posting");
        try {
          await api(`/api/communities/${S.community}/posts`, { text: d.text, kind: d.kind, title: d.title, at: d.at, spots: d.spots, from: d.kind === "trip" ? place("from") : "", to: d.kind === "trip" ? place("to") : "", place: d.kind === "trip" ? "" : place("place") });
          postDrafts.delete(S.community); S.cmTab = "all"; h.toast("Posted. Members who join show up here, and you'll get a notification."); h.paint();
        } catch (e) { busy(el, false); h.toast(e.message, null, "error"); }
        return true;
      }
      if (a === "cm-join") {
        busy(el, true);
        try { await api(`/api/posts/${el.dataset.id}/join`, el.dataset.leave ? { leave: true } : {}); h.paint(); }
        catch (e) { busy(el, false); h.toast(e.message, null, "error"); }
        return true;
      }
      if (a === "cm-close") { if ((await ask({ title: "Close this post?", detail: "Members won't see it any more.", ok: "Close post", danger: true })) === null) return true; await api(`/api/posts/${el.dataset.id}/close`, {}); h.paint(); return true; }
      return false;
    },
  },

  sharing: {
    async html(S) {
      const [log, rules, contacts, facts] = await Promise.all([sharedLog(), cached("/api/rules").catch(() => []), cached("/api/contacts").catch(() => []), allFacts()]);
      const topics = [...new Set(facts.filter(f => f.tier === "protected").flatMap(f => f.topics))];
      const shapeText = { yesNo: "Yes or no", oneLine: "One line", summary: "A summary", full: "The whole fact" };
      // One form of taps: who, which topics (your own Protected topics as chips), how much, whether you check first, how long.
      const chip = (field, value, text, on) => `<button type="button" class="chip ${on ? "on" : ""}" aria-pressed="${!!on}" data-act="rule-chip" data-field="${field}" data-value="${esc(value)}">${esc(text)}</button>`;
      return frame("Privacy", "Who sees what", `
        <div class="card ${S.profile.paused ? "accent" : ""}"><div class="row">${label(S.profile.paused ? "Paused" : "Your agent is answering", "sq " + (S.profile.paused ? "stale" : "fresh"))}
          <button class="btn ${S.profile.paused ? "accent" : "secondary"} compact end" data-act="pause">${S.profile.paused ? "Resume" : "Pause"}</button></div>
          <span class="small muted">${S.profile.paused ? "Your agent answers no one until you resume." : "It answers from everything you've told it, so nobody asks you the same thing twice."} It never says your limits, money in private notes, contact details, or a note you set to “never use” (About me). Everything it shares is listed below.</span></div>
        <form class="card" data-form="rule">${label("Share Protected facts", "sq")}
          <label class="row"><span class="small">With</span><select class="field" name="audience" style="max-width:280px"><option value="anyone">Anyone who contacts your agent</option>${contacts.map(c => `<option value="${esc(c.handle)}">${esc(c.name)} (@${esc(c.handle)})</option>`).join("")}</select></label>
          <div class="stack" style="gap:6px"><span class="small">About</span>
            ${topics.length ? `<div class="row">${topics.map((t, i) => chip("topics", t, t, i < 1)).join("")}</div><input type="hidden" name="topics" value="${esc(topics.slice(0, 1).join(","))}">`
              : `<input type="hidden" name="topics" value="">`}
            <input class="field" name="topicText" maxlength="60" aria-label="Another topic" placeholder="${topics.length ? "Or type a topic, e.g. availability" : "A topic, e.g. availability, rent, pickup times"}"></div>
          <div class="stack" style="gap:6px"><span class="small">How much</span><div class="row">${Object.entries(shapeText).map(([k, v]) => chip("shape", k, v, k === "oneLine")).join("")}</div><input type="hidden" name="shape" value="oneLine"></div>
          <div class="stack" style="gap:6px"><span class="small">Before it answers</span><div class="row">${chip("approval", "review", "Ask me first", true)}${chip("approval", "auto", "Answer on its own", false)}</div><input type="hidden" name="approval" value="review"></div>
          <div class="stack" style="gap:6px"><span class="small">For</span><div class="row">${[["1", "A day"], ["7", "A week"], ["30", "A month"], ["", "Until removed"]].map(([k, v]) => chip("days", k, v, k === "30")).join("")}</div><input type="hidden" name="days" value="30"></div>
          <button type="button" class="btn" data-act="add-rule">Add rule</button></form>
        ${label(`Rules · ${rules.length}`, "sq")}
        <div class="stack">${rules.map(r => `<div class="card slim"><div class="row"><b class="small">${esc(r.audienceName)}</b><span class="end">${tag(r.approval === "auto" ? "On its own" : "Asks you", r.approval === "auto" ? "fresh" : "stale")}</span></div>
          <div class="row">${r.topics.map(t => tag(t, "accent")).join("")}<span class="small faint">${esc(shapeText[r.shape])}${r.expires ? ` · until ${new Date(r.expires * 1000).toLocaleDateString()}` : ""}</span><button class="btn quiet compact end" data-act="revoke" data-id="${esc(r.id)}">Remove</button></div></div>`).join("") || `<p class="small muted">None yet — Protected facts stay with you.</p>`}</div>
        <details class="more"><summary>What your agent shared · ${log.count}</summary><div class="stack">${log.html}</div></details>`);
    },
    async act(a, el, S, h) {
      if (a === "pause") { busy(el, true, S.profile.paused ? "Resuming" : "Pausing"); S.profile = await api("/api/me/pause", { paused: !S.profile.paused }); h.paint(); return true; }
      if (a === "add-rule") {
        const f = new FormData(el.closest("form"));
        const topics = [...new Set([...String(f.get("topics") ?? "").split(","), ...String(f.get("topicText") ?? "").split(",")].map(t => t.trim().toLowerCase()).filter(Boolean))];
        if (!topics.length) { h.toast("Pick or type at least one topic.", null, "error"); el.closest("form").querySelector('[name="topicText"]')?.focus(); return true; }
        busy(el, true, "Adding");
        try { await api("/api/rules", { audience: f.get("audience"), topics, shape: f.get("shape"), approval: f.get("approval"), days: f.get("days") ? Number(f.get("days")) : null }); h.toast("Rule added."); }
        catch (err) { h.toast(err.message, null, "error"); }
        finally { busy(el, false); }
        h.paint(); return true;
      }
      if (a === "revoke") { busy(el, true); await api(`/api/rules/${el.dataset.id}/revoke`, {}); h.paint(); return true; }
      if (a === "rule-chip") {
        // Topics can be several; every other choice is one.
        const form = el.closest("form"), field = el.dataset.field, input = form.querySelector(`input[name="${field}"]`);
        if (field === "topics") {
          el.classList.toggle("on"); el.setAttribute("aria-pressed", String(el.classList.contains("on")));
          input.value = [...form.querySelectorAll('[data-field="topics"].on')].map(b => b.dataset.value).join(",");
        } else {
          form.querySelectorAll(`[data-field="${field}"]`).forEach(b => { b.classList.toggle("on", b === el); b.setAttribute("aria-pressed", String(b === el)); });
          input.value = el.dataset.value;
        }
        return true;
      }
    },
  },

  receipts: {
    async html(S) {
      // Every deal both people confirmed has a signed receipt. They're the owner's proof, and they're what the network
      // learns from: the record on their card (no names or prices) and the anonymised prices others bargain with.
      const mine = e => (e.requester.uid === session.uid ? "requester" : "provider");
      const list = [...live.engagements.values()].filter(e => e.agreedAt || e.phase === "agreed").sort((a, b) => (b.agreedAt ?? 0) - (a.agreedAt ?? 0));
      const f = ["all", "bought", "sold"].includes(S.receiptsFilter) ? S.receiptsFilter : "all";
      const sold = e => mine(e) === (e.seller ?? "provider");
      const shown = list.filter(e => f === "all" || (f === "sold") === sold(e));
      const cats = [...new Map(list.map(e => [e.offer.category, e])).values()].slice(0, 3);
      const [rec, market] = await Promise.all([cached(`/public/people/${encodeURIComponent(S.profile.handle)}/record`, 60_000).catch(() => null), Promise.all(cats.map(e => cached(`/api/insights?category=${encodeURIComponent(e.offer.category)}&item=${encodeURIComponent((e.offer.title ?? "").split(" · ")[0])}&unit=${encodeURIComponent(e.offer.unit ?? "")}`, 300_000)
        .then(r => (r?.insights ? { e, i: r.insights } : null)).catch(() => null))).then(xs => xs.filter(Boolean))]);
      const status = e => { const p = e.payment?.status; return p === "paid" ? ["Paid", "fresh"] : p === "outside" ? ["Settled", "fresh"] : ["closed", "declined"].includes(e.phase) ? ["Ended", "stale"] : ["To pay", "wait"]; };
      const v = S.verified ?? {};
      const row = e => { const side = mine(e), them = side === "provider" ? e.requester : e.provider, [st, tone] = status(e);
        const when = e.agreedAt ? new Date(e.agreedAt * 1000).toLocaleDateString([], { day: "numeric", month: "short" }) : "";
        return `<div class="rrow"><button class="rrow-main" data-act="eng-receipt" data-id="${esc(e.id)}">${avatarHTML(them.name, them.handle, 40)}<span class="rrow-text"><b>${esc((e.offer.title || e.title).split(" · ")[0])}</b><span class="small faint">${sold(e) ? "Sold to" : "From"} ${esc(them.name)} · ${esc(when)}</span></span></button>
          <span class="rrow-side"><b class="small">${dealAmount(e)}</b><span class="row" style="gap:6px">${tag(st, tone)}${v[e.id] === true ? tag("✓ verified", "fresh") : v[e.id] === false ? tag("✗ changed", "danger") : ""}</span></span></div>`; };
      return frame("Receipts", "Every deal, signed — anyone can check it", `
        <div class="card slim net-card">${label("What your receipts do", "sq ink")}
          <div class="net-grid">
            <div><b>${rec?.verified ?? 0}</b><span>verified ${rec?.verified === 1 ? "sale" : "sales"} on your card — other agents read your record before they deal with you</span></div>
            <div><b>${list.length}</b><span>${list.length === 1 ? "deal" : "deals"} adding to the prices people see when they set a limit (anonymised)</span></div>
          </div>
          ${market.map(({ e, i }) => `<span class="small muted">${esc((e.offer.title ?? "").split(" · ")[0])}: ${i.n} deals, most closed at ${money(Math.round(i.p25), e.offer.unit, e.offer.currency)}–${money(Math.round(i.p75), e.offer.unit, e.offer.currency)}, median ${money(Math.round(i.median), e.offer.unit, e.offer.currency)}${i.demo ? " (incl. demo deals)" : ""}.</span>`).join("")}
          <span class="small faint">No names, no private limits — only what was agreed, signed by both agents.</span></div>
        <div class="row" style="gap:6px;flex-wrap:wrap">${[["all", "All"], ["bought", "Bought"], ["sold", "Sold"]].map(([k, t]) => `<button class="chip ${f === k ? "on" : ""}" aria-pressed="${f === k}" data-act="receipts-filter" data-k="${k}">${t} · ${list.filter(e => k === "all" || (k === "sold") === sold(e)).length}</button>`).join("")}
          ${list.length ? `<button class="btn secondary compact end" data-act="receipts-verify">Verify all</button>` : ""}</div>
        <div class="rlist">${shown.map(row).join("") || `<p class="small muted">${list.length ? "None here." : "No receipts yet. When both of you confirm a deal, its signed receipt appears here."}</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "receipts-filter") { S.receiptsFilter = el.dataset.k; h.paint(); return true; }
      if (a === "receipts-verify") {
        // Each receipt is fetched and its signature checked against the agreed terms; a changed one says so.
        busy(el, true, "Checking");
        const ids = [...live.engagements.values()].filter(e => e.agreedAt || e.phase === "agreed").map(e => e.id);
        const out = await Promise.all(ids.map(id => api(`/api/engagements/${id}/receipt`).then(r => [id, !!r.matches]).catch(() => [id, null])));
        S.verified = Object.fromEntries(out.filter(([, ok]) => ok !== null));
        const bad = out.filter(([, ok]) => ok === false).length;
        h.toast(bad ? `${bad} receipt${bad === 1 ? " no longer matches" : "s no longer match"} what was agreed.` : out.length === 1 ? "Your receipt checks out — signed and unchanged." : `All ${out.length} receipts check out — signed and unchanged.`);
        h.paint(); return true;
      }
    },
  },

  requests: {
    async act(a, el, S, h) {
      if (a === "alert-ask") {
        const al = live.alerts.find(x => x.id === el.dataset.id);
        if (!al) return true;
        busy(el, true, "Contacting");
        const es = await api(`/api/briefs/${al.briefId}/engage`, { providers: [{ factId: al.factId }] });
        await api(`/api/alerts/${al.id}/done`, {});
        live.alerts = live.alerts.filter(x => x.id !== al.id);
        for (const e of es) live.engagements.set(e.id, e);
        h.toast(`Your agent is contacting ${al.name}'s agent.`);
        h.paint(); return true;
      }
      if (a === "alert-done") { busy(el, true); await api(`/api/alerts/${el.dataset.id}/done`, {}); live.alerts = live.alerts.filter(x => x.id !== el.dataset.id); h.paint(); return true; }
      if (a === "goal-budget") {
        const amount = Number(document.querySelector(`[data-goal-budget="${CSS.escape(el.dataset.id)}"]`)?.value) || 0;
        const currency = document.querySelector(`[data-goal-currency="${CSS.escape(el.dataset.id)}"]`)?.value ?? "INR";
        busy(el, true);
        try { await api(`/api/goals/${el.dataset.id}/budget`, { amount, currency }); h.toast(amount ? "Budget set — deals in this goal must fit it." : "Budget removed."); } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "goal-plan") {
        busy(el, true, "Planning");
        try { const g = await api(`/api/goals/${el.dataset.id}/plan`, {}); h.toast(`${g.plan.length} step${g.plan.length === 1 ? "" : "s"} — ready steps are searching.`); } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "goal-repeat" || a === "goal-repeat-stop") {
        const everyDays = a === "goal-repeat" ? Number(document.querySelector(`[data-goal-every="${CSS.escape(el.dataset.id)}"]`)?.value) || 7 : 0;
        busy(el, true); await api(`/api/goals/${el.dataset.id}/recurrence`, { everyDays }); h.toast(everyDays ? `Your agent will look again every ${everyDays} days and tell you — it never buys on its own.` : "Stopped repeating."); h.paint(); return true;
      }
      if (a === "goal-aon") { await api(`/api/goals/${el.dataset.id}/settings`, { allOrNothing: el.checked }); h.toast(el.checked ? "All or nothing: if a part fails, the others are released." : "Parts are independent."); h.paint(); return true; }
      if (a === "step-matches") {
        busy(el, true);
        const r = await api(`/api/goals/${el.dataset.goal}/steps/${el.dataset.step}/matches`).catch(err => ({ error: err.message }));
        const box = document.querySelector(`[data-step-box="${CSS.escape(el.dataset.step)}"]`);
        box.innerHTML = r.error ? `<span class="small faint">${esc(r.error)}</span>` : r.found.length ? r.found.slice(0, 5).map(f => `<div class="row small"><span>${esc(f.profile.name)}</span><span class="faint">${esc((f.fact.offer?.title ?? f.fact.text).slice(0, 60))}</span>${f.fact.offer ? `<b>${money(f.fact.offer.price.amount, f.fact.offer.price.period)}</b>` : ""}
          <button class="btn accent compact end" data-act="step-ask" data-brief="${esc(r.briefId)}" data-fact="${esc(f.fact.id)}">Ask their agent</button></div>`).join("") : `<span class="small faint">No one fits yet.</span>`;
        busy(el, false); return true;
      }
      if (a === "step-ask") {
        busy(el, true, "Contacting");
        const es = await api(`/api/briefs/${el.dataset.brief}/engage`, { providers: [{ factId: el.dataset.fact }] });
        for (const e of es) live.engagements.set(e.id, e);
        h.toast("Your agent is contacting them over A2A."); h.paint(); return true;
      }
      // An employer's moves on an application (the agent never takes them on its own).
      if (a === "app-shortlist" || a === "app-interview" || a === "app-reject") {
        // A demo employer's decision, made by the candidate, says whose it is.
        const as = el.dataset.demo ? shortName(live.engagements.get(el.dataset.id)?.provider.name ?? "") || null : null;
        if (a === "app-reject" && (await ask({ title: as ? "Turn down your own application?" : `Tell ${el.dataset.name} you won't take this forward?`, detail: "Their agent gets a polite note, and the application ends.", ok: "Not this time", danger: true, as })) === null) return true;
        const note = a === "app-interview" ? await ask({ title: "Invite them to an interview?", detail: "Their agent asks them when they're free.", ok: "Send invite", input: { label: "When or how (optional)", placeholder: "e.g. a 30-minute video call" } }) : "";
        if (note === null) return true;
        busy(el, true);
        try {
          const e = await api(`/api/engagements/${encodeURIComponent(el.dataset.id)}/${{ "app-shortlist": "shortlist", "app-interview": "interview", "app-reject": "reject" }[a]}`, a === "app-interview" ? { note } : {});
          live.engagements.set(e.id, e);
          h.toast(a === "app-shortlist" ? (el.dataset.demo ? "Shortlisted — their agent opens the salary talk with yours." : "Shortlisted — your agent opens the salary talk.") : a === "app-interview" ? "Invitation sent — their agent asks them when they're free." : "Sent a polite note. The application has ended.");
        } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "goal-cancel") {
        if ((await ask({ title: "Cancel this goal?", detail: "Conversations without a deal end; agreed deals keep their obligations.", ok: "Cancel goal", cancel: "Keep it", danger: true })) === null) return true;
        busy(el, true); await api(`/api/goals/${el.dataset.id}/cancel`, {}); h.toast("Goal cancelled."); h.paint(); return true;
      }
      if (a === "deal-receipt") {
        // The button sits in the row's summary, whose own toggle runs after this: open the row once that's done.
        const row = el.closest("details");
        setTimeout(() => { row.open = true; row.querySelector('[data-act="eng-receipt"]')?.click(); }, 0);
        return true;
      }
      if (a === "deals-filter") { S.dealsFilter = el.dataset.k; h.paint(); return true; }
      if (a === "radar") { S.radar = el.dataset.k; h.paint(); return true; }
      if (a === "deal-jump") { const c = document.querySelector(`[data-engagement="${CSS.escape(el.dataset.id)}"]`); c?.scrollIntoView({ block: "center" }); c?.classList.add("landed"); setTimeout(() => c?.classList.remove("landed"), 1600); return true; }
      if (a === "watch-stop") { busy(el, true); await api(`/api/watches/${el.dataset.id}/stop`, {}); live.watches = live.watches.filter(x => x.id !== el.dataset.id); h.paint(); return true; }
    },
    async html(S) {
      const list = [...live.engagements.values()].sort((a, b) => {
        const need = e => (live.inbox.some(i => i.engagementId === e.id) ? 1 : 0);
        return need(b) - need(a) || b.updatedAt - a.updatedAt;
      });
      // Goals and applicants follow from the conversations: read again when one changed, else shared across a burst of repaints.
      const sig = list.map(e => `${e.id}:${e.updatedAt}`).join(), changed = sig !== engSig; engSig = sig;
      // Goals first: what you wanted, where it stands, and what happens next (each conversation is one of its tasks).
      const [facts, goals] = await Promise.all([allFacts(), cached("/api/goals", changed ? 0 : 3_000).catch(() => [])]);
      // An employer's job posts: each with its applicants, screened against the JD and ranked, above the activity rows.
      const jobs = facts.filter(f => f.tier === "public" && f.offer?.ownerPays && rolesOf(f.offer.category).flow === "hire");
      const boards = (await Promise.all(jobs.map(f => cached(`/api/facts/${encodeURIComponent(f.id)}/applicants`, changed ? 0 : 30_000).catch(() => null)))).filter(b => b?.job);
      const when = t => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      const STATE = { draft: ["Draft", ""], active: ["In progress", "accent"], waiting: ["Needs you", "wait"], completed: ["Done", "fresh"],
        partially_completed: ["Partly done", "peri"], cancelled: ["Cancelled", ""], failed: ["Didn't work out", "danger"] };
      const open = goals.filter(g => !["completed", "cancelled", "failed"].includes(g.state)), doneGoals = goals.filter(g => !open.includes(g)).slice(0, 5);
      const STEP = { waiting: "waits", ready: "ready", searched: "matches found", started: "talking", done: "✓ done", failed: "✗ didn't work" };
      const goalRow = g => {
        const id = esc(g.id), live_ = open.includes(g), b = g.budgetUse;
        const steps = (g.plan ?? []).map((st, i) => `<div class="row small"><span class="faint">${i + 1}.</span><span>${esc(st.title)}</span>${st.after ? `<span class="faint">after ${esc(g.plan.find(x => x.id === st.after)?.title ?? "")}</span>` : ""}
          <span class="end faint">${STEP[st.state] ?? st.state}</span>${st.state === "searched" ? `<button class="btn quiet compact" data-act="step-matches" data-goal="${id}" data-step="${esc(st.id)}">See matches</button>` : ""}</div>${st.note && st.state !== "done" ? `<span class="small faint">${esc(st.note)}</span>` : ""}<div data-step-box="${esc(st.id)}"></div>`).join("");
        return `<div class="card slim goal ${g.state === "waiting" ? "needs-card" : ""}"><div class="row"><b class="small">${esc(g.outcome)}</b><span class="end">${tag(...(STATE[g.state] ?? [g.state, ""]))}</span></div>
        <span class="small muted">${g.tasks.length ? `${g.tasks.length} conversation${g.tasks.length === 1 ? "" : "s"}${g.next ? ` · ${esc(g.next)}` : ""}` : g.plan?.length ? `${g.plan.length} step plan` : "No conversations yet"}</span>
        ${b ? `<span class="small">Budget ${money(b.used, null, b.currency)} of ${money(b.amount, null, b.currency)} committed</span>` : ""}
        ${steps ? `<div class="stack" style="gap:2px">${steps}</div>` : ""}
        ${g.recurrence && !g.recurrence.stopped ? `<span class="small faint">Repeats every ${g.recurrence.everyDays} day${g.recurrence.everyDays === 1 ? "" : "s"} · next ${new Date(g.recurrence.nextAt * 1000).toLocaleDateString()} · ${g.recurrence.rounds} round${g.recurrence.rounds === 1 ? "" : "s"} so far</span>` : g.recurrence?.stopped ? `<span class="small faint">Repeating stopped: ${esc(g.recurrence.stopped)}</span>` : ""}
        ${g.compensation ? `<span class="small" style="color:var(--stale)">Part of this all-or-nothing goal failed: ${g.compensation.cancelled.length} unpaid deal${g.compensation.cancelled.length === 1 ? "" : "s"} cancelled, ${g.compensation.released.length} reservation${g.compensation.released.length === 1 ? "" : "s"} released${g.compensation.paidNeedsOwner.length ? `; ${g.compensation.paidNeedsOwner.length} already paid — ask those sellers to cancel` : ""}.</span>` : ""}
        ${live_ ? `<details class="more"><summary>Goal settings</summary><div class="stack" style="gap:6px">
          <div class="row small"><input class="field" type="number" min="0" style="max-width:110px" data-goal-budget="${id}" placeholder="Budget" aria-label="Budget" value="${b?.amount ?? ""}"><select class="field" style="max-width:90px" data-goal-currency="${id}" aria-label="Currency">${(session.policy?.currencies ?? ["INR"]).map(c => `<option ${b?.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select><button class="btn secondary compact" data-act="goal-budget" data-id="${id}">Set budget</button></div>
          ${g.plan?.length ? "" : `<div class="row small"><button class="btn secondary compact" data-act="goal-plan" data-id="${id}">Plan it — several providers</button><span class="faint">Gemini splits it into steps; each step searches when ready</span></div>`}
          <div class="row small"><span>Repeat every</span><input class="field" type="number" min="1" max="90" style="max-width:70px" data-goal-every="${id}" aria-label="Repeat every (days)" value="${g.recurrence?.everyDays ?? 7}"><span>days</span><button class="btn quiet compact" data-act="goal-repeat" data-id="${id}">${g.recurrence && !g.recurrence.stopped ? "Update" : "Repeat"}</button>${g.recurrence && !g.recurrence.stopped ? `<button class="btn quiet compact" data-act="goal-repeat-stop" data-id="${id}">Stop</button>` : ""}</div>
          <label class="row small" style="gap:6px"><input type="checkbox" data-act="goal-aon" data-id="${id}" ${g.allOrNothing ? "checked" : ""}> All or nothing — if one part fails, release the others</label>
          <div class="row"><button class="linkish small faint end" data-act="goal-cancel" data-id="${id}">Cancel goal</button></div></div></details>` : ""}</div>`;
      };
      // What your agents are doing, by what it needs from you: what's waiting on you first, then what they're
      // negotiating on their own, then deals to pay for or hand over; finished and ended ones folded away.
      const me = e => (e.provider.uid === session.uid ? "provider" : "requester");
      const waitingOn = new Set(needsYou().filter(i => i.engagementId).map(i => i.engagementId));
      const sellerOf = e => e.seller ?? "provider";
      // A deal that fell through or was called off before anyone paid: nothing left to do, and it isn't a sale.
      const off = e => e.fulfilment?.state === "cancelled" || (!["paid", "outside"].includes(e.payment?.status) && Object.values(e.outcome ?? {}).includes("fell_through"));
      // Handed over is finished for the seller; the buyer still says whether it's as agreed.
      const toConfirm = e => e.fulfilment?.state === "delivered" && sellerOf(e) !== me(e);
      const ended = e => ["closed", "declined"].includes(e.phase), handed = e => ["delivered", "accepted"].includes(e.fulfilment?.state) && !toConfirm(e);
      const waiting = list.filter(e => waitingOn.has(e.id) && !ended(e));
      const talking = list.filter(e => !waitingOn.has(e.id) && ["asking", "negotiating", "deal"].includes(e.phase));
      const toFinish = list.filter(e => !waitingOn.has(e.id) && e.phase === "agreed" && !handed(e) && !off(e));
      const gone = list.filter(ended);
      // Every deal you've made, newest first — what you bought and sold, where it stands, its pass and its receipt. One
      // still being paid for or handed over is open above; its row here jumps to it.
      const shownAbove = new Set([...waiting, ...toFinish].map(e => e.id));
      const deals = list.filter(e => e.phase === "agreed" && e.negotiation.deal).sort((a, b) => (b.agreedAt ?? b.updatedAt) - (a.agreedAt ?? a.updatedAt));
      const sold = deals.filter(e => !off(e) && sellerOf(e) === me(e)), bought = deals.filter(e => !off(e) && sellerOf(e) !== me(e));
      // What was paid, per currency ("₹12,000" or "₹500 + $40").
      const paidBy = es => { const m = {}; for (const e of es) if (["paid", "outside"].includes(e.payment?.status)) { const c = e.offer.currency ?? "INR"; m[c] = (m[c] ?? 0) + (e.payment.cart?.total?.value ?? 0); }
        return Object.entries(m).filter(([, v]) => v).map(([c, v]) => money(v, null, c)).join(" + "); };
      const soldSum = paidBy(sold), boughtSum = paidBy(bought);
      // Find a deal fast: what still needs doing, what you sold, what you bought, what's finished.
      // Open: still to pay, hand over or confirm. Won: paid or handed over as agreed. Lost: cancelled or fell through.
      const DEAL_FILTERS = [["open", "Open"], ["won", "Won"], ["lost", "Lost"], ["all", "All"]];
      const finishedDeal = e => ["accepted", "disputed"].includes(e.fulfilment?.state) || off(e) || (handed(e) && sellerOf(e) === me(e));
      const dealIn = (e, k) => k === "all" || (k === "open" ? !finishedDeal(e) : k === "lost" ? off(e) : finishedDeal(e) && !off(e));
      const dealFilter = DEAL_FILTERS.some(([k]) => k === S.dealsFilter) ? S.dealsFilter : "open";
      const STAGE = e => dealStage(e, me(e));
      const dealRow = e => {
        const side = me(e), them = side === "provider" ? e.requester : e.provider, mineSold = sellerOf(e) === side;
        const d = e.negotiation.deal, n = d.items?.length ? d.items.reduce((t, l) => t + l.quantity, 0) : d.terms?.quantity > 1 ? d.terms.quantity : 1;
        const total = e.payment?.cart?.total?.value ?? (d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : d.price * n);
        const [st, tone] = STAGE(e), at = new Date((e.agreedAt ?? e.updatedAt) * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
        const line = `<span class="deal-line">${tag(mineSold ? "Sold" : "Bought", mineSold ? "fresh" : "peri")}<b class="grow" title="${esc((e.offer?.title ?? e.title).split(" · ")[0])}">${esc((e.offer?.title ?? e.title).split(" · ")[0])}${n > 1 ? ` × ${n}` : ""}</b><span class="deal-amt">${money(total, null, e.offer.currency)}</span></span>
          <span class="deal-line small"><span class="faint">${mineSold ? "to" : "from"} ${esc(them.name)} · ${esc(at)}</span>${tag(st, tone)}</span>`;
        const paid = ["paid", "outside"].includes(e.payment?.status);
        return shownAbove.has(e.id) ? `<button class="deal-row deal-jump" data-act="deal-jump" data-id="${esc(e.id)}" data-anim="d-${esc(e.id)}" data-anim-sig="${esc(st)}" title="Open this deal above">${line}</button>`
          : `<details class="more deal-row" data-anim="d-${esc(e.id)}" data-anim-sig="${esc(st)}"><summary>${line}${paid ? `<button class="btn quiet compact" data-act="deal-receipt" data-id="${esc(e.id)}" title="The signed record of this deal">Receipt</button>` : ""}</summary>${engagementCard(e, e.id)}</details>`;
      };
      // Deals grouped by who they're with: one person's deals together, newest person first.
      const byPerson = es => {
        const groups = new Map();
        for (const e of es) { const them = me(e) === "provider" ? e.requester : e.provider; (groups.get(them.uid ?? them.name) ?? groups.set(them.uid ?? them.name, { them, es: [] }).get(them.uid ?? them.name)).es.push(e); }
        return [...groups.values()].map(g => `<div class="stack" style="gap:6px"><span class="small"><b>${esc(g.them.name)}</b>${g.them.handle ? ` <span class="faint">@${esc(g.them.handle)}</span>` : ""} <span class="faint">· ${g.es.length} deal${g.es.length === 1 ? "" : "s"}</span></span>${g.es.map(dealRow).join("")}</div>`).join("");
      };
      const t0 = new Date().setHours(0, 0, 0, 0) / 1000;
      const mine = e => (me(e) === "provider" ? "provider_agent" : "requester_agent");
      const moves = list.reduce((n, e) => n + e.events.filter(v => v.who === mine(e) && v.at >= t0).length, 0);
      const closed = list.reduce((n, e) => n + e.events.filter(v => v.who === mine(e) && v.at >= t0 && /inside the limit my owner set|standing mandate/.test(v.text)).length, 0);
      const need = needsYouCount(), rounds = session.policy?.negotiation?.maxRounds ?? 5;
      const row = e => {
        const side = me(e), them = side === "provider" ? e.requester : e.provider, n = e.negotiation;
        const my = (side === "provider" ? n.provider : n.requester).at(-1), their = (side === "provider" ? n.requester : n.provider).at(-1);
        const units = e.quantity > 1 ? ` × ${e.quantity}` : "", item = (e.offer?.title ?? e.title).split(" · ")[0];
        const status = e.phase === "deal" && n.deal ? `on the table: ${dealAmount(e)}${n.confirmed[side] ? " · waiting for them" : ""}`
          : my || their ? `yours ${my ? money(my.price) : "—"} · theirs ${their ? money(their.price) : "—"} · round ${Math.max(n.provider.length, n.requester.length)} of ${rounds}`
          : "agents are asking and answering";
        return `<details class="more eng-row" data-anim="r-${esc(e.id)}" data-anim-sig="${esc(status)}"><summary><b>${esc(them.name)}</b> · ${esc(item)}${units} <span class="faint">· ${esc(status)}</span></summary>${engagementCard(e, e.id)}</details>`;
      };
      const alerts = live.alerts.map(a => `<div class="card slim needs-card">
          <div class="row">${avatarHTML(a.name, a.handle, 36)}<div class="eng-who"><b>${esc(a.name)}</b><span class="small faint">fits “${esc(a.title)}” · found by your scheduled agent</span></div>${a.price ? `<span class="end"><b>${money(a.price, a.unit)}</b></span>` : ""}</div>
          <span class="small muted">${esc(a.text)}</span>
          <div class="row"><button class="btn accent compact" data-act="alert-ask" data-id="${esc(a.id)}">Ask their agent</button><button class="btn quiet compact" data-act="alert-done" data-id="${esc(a.id)}">Dismiss</button></div></div>`).join("");
      // The radar: four counts across the top, each a filter; one row per conversation, with the decision right on it.
      const finished = list.filter(e => e.phase === "agreed" && handed(e)), agreedAll = [...toFinish, ...finished];
      const pick = S.radar && ["need", "talks", "agreed", "closed"].includes(S.radar) ? S.radar : need || live.alerts.length ? "need" : talking.length || open.length ? "talks" : agreedAll.length ? "agreed" : "need";
      const counts = { need: need + live.alerts.length, talks: talking.length, agreed: agreedAll.length, closed: gone.length };
      const radar = `<div class="radar">${[["need", "Awaiting you"], ["talks", "In talks"], ["agreed", "Agreed"], ["closed", "Closed"]].map(([k, t]) => `<button class="${pick === k ? "on" : ""} ${k}${k === "need" && counts.need ? " hot" : ""}" aria-pressed="${pick === k}" data-act="radar" data-k="${k}"><b>${counts[k]}</b><span>${t}</span></button>`).join("")}</div>`;
      // One row: who, what it's about, where it stands — and for a decision, accept / pass right there.
      const decision = e => live.inbox.find(i => i.engagementId === e.id && i.owner === session.uid && ["confirm", "move"].includes(i.kind) && (i.kind === "confirm" || i.counter));
      const rowOf = (e, why) => {
        const side = me(e), them = side === "provider" ? e.requester : e.provider, [st, tone] = dealStage(e, side, waitingOn.has(e.id));
        const d = decision(e), c = d?.counter, cur = e.offer?.currency;
        const acts = d ? (d.kind === "confirm"
            ? `<button class="btn accent compact" data-act="inbox-confirm" data-id="${esc(d.id)}">Accept</button><button class="btn secondary compact" data-act="inbox-walk" data-id="${esc(d.id)}">Pass</button>`
            : `<button class="btn accent compact" data-act="take-price" data-eng="${esc(e.id)}" data-price="${c.price}">Accept ${c.quantity > 1 ? money(c.total, null, cur) : money(c.price, null, cur)}</button><button class="btn secondary compact" data-act="inbox-walk" data-id="${esc(d.id)}">Pass</button>`)
          : waitingOn.has(e.id) ? `<button class="btn accent compact" data-act="eng-open" data-id="${esc(e.id)}">Answer ›</button>` : "";
        return `<div class="rrow ${waitingOn.has(e.id) ? "needs" : ""}" data-engagement-row="${esc(e.id)}" data-anim="rr-${esc(e.id)}" data-anim-sig="${esc(st)}">
          <button class="rrow-main" data-act="eng-open" data-id="${esc(e.id)}">${avatarHTML(them.name, them.handle, 40)}<span class="rrow-text"><b>${esc(them.name)}</b><span class="small muted">${esc(why)}</span></span></button>
          <span class="rrow-side">${tag(st, tone)}<span class="row" style="gap:10px">${acts}<button class="btn quiet compact" data-act="eng-log" data-id="${esc(e.id)}">Agent log ›</button></span></span></div>`;
      };
      const why = e => { const d = decision(e), n = e.negotiation, item = (e.offer?.title ?? e.title).split(" · ")[0];
        if (d?.kind === "confirm") return `Confirm ${dealAmount(e)} for ${item}`;
        if (d?.counter) return `${shortName(d.counter.by)} offers ${money(d.counter.price, null, e.offer?.currency)} for ${item}`;
        const q = live.inbox.find(i => i.engagementId === e.id && i.owner === session.uid && i.question); if (q) return q.question;
        if (e.phase === "agreed") return `${dealAmount(e)} · ${item}`;
        if (["closed", "declined"].includes(e.phase)) return e.events.filter(x => x.who === "system").at(-1)?.text ?? item;
        const my = (me(e) === "provider" ? n.provider : n.requester).at(-1), their = (me(e) === "provider" ? n.requester : n.provider).at(-1);
        return my || their ? `${item} · yours ${my ? money(my.price) : "—"} · theirs ${their ? money(their.price) : "—"}` : `${item} · agents are asking and answering`; };
      const shortName = x => String(x ?? "").split(" ")[0];
      const alertRows = live.alerts.map(a => `<div class="rrow needs"><button class="rrow-main" data-act="alert-ask" data-id="${esc(a.id)}">${avatarHTML(a.name, a.handle, 40)}<span class="rrow-text"><b>${esc(a.name)}</b><span class="small muted">fits “${esc(a.title)}”${a.price ? ` · ${money(a.price, a.unit)}` : ""} · found by your watch</span></span></button>
          <span class="rrow-side">${tag("New match", "wait")}<span class="row" style="gap:10px"><button class="btn accent compact" data-act="alert-ask" data-id="${esc(a.id)}">Ask their agent</button><button class="btn quiet compact" data-act="alert-done" data-id="${esc(a.id)}">Pass</button></span></span></div>`).join("");
      const background = open.length || live.watches.length ? `<div class="stack" style="gap:6px">${label("In the background", "sq")}${open.map(goalRow).join("")}${live.watches.map(w => `<div class="card slim"><div class="row"><span class="live-dot"></span><b class="small">${esc(w.title)}</b><span class="small faint">live · looking every ${w.every >= 60 ? `${w.every / 60} h` : `${w.every} min`} until ${new Date(w.expires * 1000).toLocaleDateString()}</span>
          <button class="btn quiet compact end" data-act="watch-stop" data-id="${esc(w.id)}">Stop</button></div></div>`).join("")}</div>` : "";
      const body = pick === "need" ? `${alertRows}${waiting.map(e => rowOf(e, why(e))).join("")}` || `<p class="small muted">Nothing waits on you. Your agents ask only when a decision is yours.</p>`
        : pick === "talks" ? `${talking.map(e => rowOf(e, why(e))).join("") || `<p class="small muted">No conversations running right now.</p>`}${background}`
        : pick === "agreed" ? `${agreedAll.map(e => rowOf(e, why(e))).join("") || `<p class="small muted">Nothing agreed yet.</p>`}
          ${deals.length ? `<div class="card slim deals-sum"><div class="row" style="flex-wrap:wrap;gap:14px">${sold.length ? `<span><b>${sold.length}</b> sold${soldSum ? ` · ${soldSum} paid` : ""}</span>` : ""}${bought.length ? `<span><b>${bought.length}</b> bought${boughtSum ? ` · ${boughtSum} paid` : ""}</span>` : ""}<span><b>${deals.filter(e => e.fulfilment?.state === "accepted").length}</b> completed</span>${sold.length ? `<button class="btn quiet compact end" data-act="preview-card">See your card</button>` : ""}</div></div>` : ""}`
        : `${gone.map(e => rowOf(e, why(e))).join("") || `<p class="small muted">Nothing closed yet.</p>`}${doneGoals.length ? `<details class="more"><summary>Finished goals · ${doneGoals.length}</summary>${doneGoals.map(goalRow).join("")}</details>` : ""}`;
      return frame("Activity", "What your agents are doing", `${boards.map(applicantsBoard).join("")}${radar}
        <div class="row small"><span class="muted">${moves ? `<b>${moves}</b> move${moves === 1 ? "" : "s"} today${closed ? ` · <b>${closed}</b> agreed inside your rules` : ""}` : "Your agents are standing by."}</span><button class="btn quiet compact end" data-act="agent-stream">Agent log ›</button></div>
        <div class="rlist">${body}</div>
        ${!list.length && !goals.length ? `<p class="small muted">Ask for something in chat — “Need a tabla teacher online” — or open someone's card. Your agents' work shows up here.</p>` : ""}`);
    },
  },

  activity: {
    async html() {
      const es = [...live.engagements.values()], me = session.uid;
      const sold = es.filter(e => (e.seller ?? "provider") === (e.provider.uid === me ? "provider" : "requester") && e.phase === "agreed");
      const bought = es.filter(e => e.phase === "agreed" && !sold.includes(e));
      const paid = x => x.payment?.status === "paid" || x.payment?.status === "outside", done = x => x.fulfilment?.state === "accepted";
      const sum = xs => xs.reduce((n, e) => n + (e.payment?.cart?.total?.value ?? e.negotiation.deal?.price ?? 0), 0);
      const stat = (n, l) => `<div><b>${n}</b><span class="small muted">${l}</span></div>`;
      const numbers = `<div class="card">${label("Your numbers", "sq")}<div class="stats">
        ${stat(es.filter(e => e.provider.uid === me).length, "asked you")}${stat(es.filter(e => e.requester.uid === me).length, "you asked")}${stat(es.filter(e => e.phase === "agreed").length, "deals")}
        ${stat(sold.filter(paid).length, "paid to you")}${stat(bought.filter(paid).length, "you paid")}${stat(es.filter(done).length, "completed")}</div>
        ${sold.length ? `<span class="small muted">Sold ${money(sum(sold.filter(paid)), null, sold[0]?.offer?.currency)} paid · ${sold.filter(done).length} handed over and accepted</span>` : ""}
        <span class="small faint">Counted on this device from your conversations. Nobody else sees these.</span></div>`;
      const log = await sharedLog();
      return frame("Privacy", "What your agent shared", `${numbers}<p class="small muted">What your agent shared, and with whom. Private notes never appear.</p><div class="stack">${log.html}</div>`);
    },
  },

  settings: {
    async html(S) {
      const anon = session.user?.isAnonymous;
      let look = "auto"; try { look = localStorage.getItem("collab-theme") || "auto"; } catch { /* private window */ }
      return frame("Settings", "You and your agent", `
        <form class="card set-card" data-form="profile">
          <div class="set-head">${avatarHTML(S.profile.name, S.profile.handle, 48)}<div><b>${esc(S.profile.name)}</b><span class="small faint">@${esc(S.profile.handle)}</span></div></div>
          <label class="set-field"><span>Name</span><input class="field" name="name" value="${esc(S.profile.name)}"></label>
          <label class="set-field"><span>Handle</span><div class="row" style="flex-wrap:nowrap;gap:6px"><span class="faint">@</span><input class="field" name="handle" value="${esc(S.profile.handle)}"></div></label>
          <label class="set-field"><span>About you · public</span><input class="field" name="bio" value="${esc(S.profile.bio)}" placeholder="One line others see"></label>
          <label class="set-field"><span>Area</span><input class="field" name="area" value="${esc(S.profile.area?.name ?? "")}" placeholder="e.g. Koramangala"></label>
          <button class="btn" data-act="save-profile">Save</button></form>
        <div class="card set-card">
          <div class="set-row"><div><b>Theme</b><span class="small faint">Auto follows your device</span></div><div class="seg">${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, v]) => `<button class="${(["light", "dark"].includes(look) ? look : "auto") === k ? "on" : ""}" aria-pressed="${(["light", "dark"].includes(look) ? look : "auto") === k}" data-act="theme" data-value="${k}">${v}</button>`).join("")}</div></div>
          <div class="set-row"><div><b>Don't keep history</b><span class="small faint">${S.incognito ? "On — new chats aren't kept or synced, and nothing you say is remembered" : "New chats aren't kept and nothing is remembered while it's on"}</span></div><div class="seg">${[["off", "Off"], ["on", "On"]].map(([k, v]) => `<button class="${(S.incognito ? "on" : "off") === k ? "on" : ""}" aria-pressed="${(S.incognito ? "on" : "off") === k}" data-act="incognito" data-value="${k}">${v}</button>`).join("")}</div></div></div>
        <div class="card set-card">${label("Privacy & AI", "sq")}
          <div class="plain-facts">
            <div>${icon("user")}<span><b>Kept in your Collab account.</b> Only you and your agent can read it.</span></div>
            <div>${icon("activity")}<span><b>Other people's agents get answers, not your notes.</b> Your agent answers from what you've told it — never your limits, money in private notes, phone or address.</span></div>
            <div>${icon("shield")}<span><b>Gemini, Google's AI, does the work:</b> it reads your requests and answers other agents for you.</span></div>
          </div>
          <details class="more"><summary>Advanced · your own questions about your notes</summary>
            <span class="small muted">When you ask your agent about your own notes ("what's my landlord's number?"), Gemma — Google's open model — can answer on your phone or laptop instead, even offline.</span>
            <div class="seg wide">${[["cloud", "Gemini (default)"], ["cloud-only", "Gemini only"], ["my-devices", "My devices only"], ["device-only", "Only this device"]].map(([v, t]) => `<button class="${engine.mode === v ? "on" : ""}" aria-pressed="${engine.mode === v}" data-act="processing" data-value="${v}">${t}</button>`).join("")}</div>
            <div class="set-row"><div><b>Gemma on this device</b><span class="small faint">${deviceAI()}</span></div></div>
          </details>
</div>
        
        <div class="card">${label("App & notifications", "sq")}
          <span class="small muted">Get told when your agent needs you, even with Collab closed. Never prices or notes.</span>
          <dl class="kv"><dt>Browser check</dt><dd>${session.appCheckOk ? `<span style="color:var(--fresh)">● Verified by Google reCAPTCHA</span>`
            : session.appCheckError ? `<span style="color:var(--stale)">● Couldn't verify this browser</span> <span class="small faint">(${esc(session.appCheckError.code)})</span><br><span class="small muted">Chat and requests still work. Payments, pickups and price checks need it: reload Collab, or allow google.com in your content blocker.</span>`
            : `<span class="small muted">Checking…</span>`}</dd>
          <dt>App</dt><dd>${standalone() ? `<span style="color:var(--fresh)">● Installed</span>`
            : `<button class="btn secondary compact" data-act="install-app">Install Collab</button>`}</dd>
          <dt>Notifications</dt><dd>${session.pushOn ? `<span style="color:var(--fresh)">● On for this device</span> <button class="btn quiet compact" data-act="push-test">Send a test notification</button>`
            : "Notification" in window && Notification.permission === "denied" ? `Blocked — allow notifications for this site in your browser's site settings, then reload.`
            : `<button class="btn secondary compact" data-act="push-on">Turn on notifications</button>`}</dd></dl></div>
        <div class="card">${label("Account", "sq")}
          ${session.google && anon ? `<span class="small muted">You're a guest. Sign in with Google to keep your handle and context on other devices.</span><button class="btn secondary" data-act="google">Sign in with Google</button>` : `<span class="small muted">${esc(session.user?.email ?? "Signed in")}</span>`}
          <div class="row">${session.signOut ? `<button class="btn secondary compact" data-act="sign-out">Sign out</button>` : ""}<button class="btn quiet compact" data-act="clear-device">Delete chat history</button></div></div>
        <details class="more danger-zone"><summary>Danger zone</summary><div class="card danger-card"><div class="row"><div class="stack" style="gap:2px;flex:1;min-width:200px"><b>Delete account</b><span class="small">Your agent stops at once and everything you keep here is removed. Deals you made stay with the other person, as do their receipts.</span></div><button class="btn danger compact" data-act="delete-account">Delete</button></div></div></details>`);
    },
    async act(a, el, S, h) {
      // Incognito: chats started while it's on are never kept or synced, and nothing said is remembered (see app.js).
      if (a === "incognito") {
        S.incognito = el.dataset.value === "on";
        try { localStorage.setItem("collab-incognito", S.incognito ? "on" : "off"); } catch {}
        session.incognito = S.incognito;
        h.toast(S.incognito ? "On — new chats aren't kept, and nothing is remembered." : "History is kept again.");
        h.paint(); return true;
      }
      if (a === "theme") {
        // Light, dark, or the device's own setting — kept on this device.
        const t = el.dataset.value;
        try { if (t === "auto") localStorage.removeItem("collab-theme"); else localStorage.setItem("collab-theme", t); } catch { /* private window: this session only */ }
        window.applyLook?.();
        h.paint(); return true;
      }
      if (a === "save-profile") { const f = new FormData(el.closest("form")); busy(el, true); S.profile = await api("/api/me", { name: f.get("name"), handle: String(f.get("handle")).toLowerCase(), bio: f.get("bio"), areaName: f.get("area") }); h.toast("Saved."); h.paint(); return true; }
      if (a === "device-download") {
        el.disabled = true;
        try { await downloadModel(() => h.paint()); h.toast(`${MODEL.label} is on this device — your notes are answered here, even offline.`); }
        catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "gemma-remove") { busy(el, true); await removeGemma(); await detectEngine(); refreshServing(); h.toast(`${MODEL.label} removed from this device.`); h.paint(); return true; }
      if (a === "processing") {
        setProcessingMode((el.dataset.value ?? el.value));
        h.toast((el.dataset.value ?? el.value) === "device-only" ? `Your notes are answered by ${MODEL.label} on this device only.` : (el.dataset.value ?? el.value) === "cloud" ? `Gemini answers. Add ${MODEL.label} below and your notes are read on your device first.` : (el.dataset.value ?? el.value) === "cloud-only" ? "Your notes are answered by Gemini in the cloud." : `Your notes are answered by ${MODEL.label} on your own devices only — never the cloud.`);
        h.paint(); return true;
      }
      if (a === "device-rename") { busy(el, true); await renameDevice(document.querySelector("[data-device-name]")?.value ?? ""); h.toast("Renamed."); h.paint(); return true; }
      if (a === "device-serve") { await setServe(el.checked); h.toast(el.checked ? "This device answers your other devices' questions while Collab is open." : "This device no longer answers for your other devices."); h.paint(); return true; }
      if (a === "device-remove") { busy(el, true); await removeDevice(el.dataset.id).catch(err => h.toast(err.message, null, "error")); h.paint(); return true; }
      if (a === "push-test") {
        busy(el, true, "Sending");
        try { const r = await api("/api/push/test", {}); h.toast(r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"} — it should appear in a few seconds.` : "The notification service didn't accept it — try turning notifications off and on."); }
        catch (err) { h.toast(err.message, null, "error"); }
        busy(el, false); return true;
      }

      if (a === "push-on") {
        busy(el, true);
        try { if (await session.push()) h.toast("Notifications are on for this device."); } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "google") {
        busy(el, true, "Opening Google");
        try {
          const r = await session.google();
          if (r === "switched") { h.toast("That Google account already has Collab — switching to it."); setTimeout(() => location.reload(), 800); return true; }
          if (r === "linked") h.toast("Signed in with Google. Your handle and context now follow you to any device.");
        } catch (err) { h.toast(err.message, null, "error"); }
        h.paint(); return true;
      }
      if (a === "delete-account") {
        if ((await ask({ title: "Delete your account?", detail: "Your agent stops at once; notes, listings, rules, requests and chats are removed; your handle is freed. This can't be undone.", ok: "Delete account", danger: true, input: { label: "Type DELETE to confirm", required: true, match: "DELETE", placeholder: "DELETE" } })) === null) return true;
        busy(el, true, "Deleting");
        try { await api("/api/me/delete", {}); await local.clear().catch(() => {}); try { localStorage.clear(); } catch {} if (session.user?.delete) await session.user.delete().catch(() => {}); if (session.signOut) await session.signOut(); else location.href = "/"; }
        catch (err) { busy(el, false); h.toast(err.message, null, "error"); }
        return true;
      }
      if (a === "clear-device") { if ((await ask({ title: "Delete your chat history on every device?", detail: "Your context, facts, people and deals stay.", ok: "Delete history", danger: true })) !== null) { await api("/api/chats/clear", {}); await local.clear(); location.reload(); } return true; }
      if (a === "sign-out") {
        if (session.user?.isAnonymous && (await ask({ title: "Sign out of this guest account?", detail: "Signing out loses this identity for good. Sign in with Google first to keep it.", ok: "Sign out anyway", danger: true })) === null) return true;
        try { localStorage.removeItem(`collab.me.${session.uid}`); } catch {}
        await session.signOut(); return true;
      }
    },
  },
};

document.addEventListener("submit", e => { if (e.target.dataset.form) e.preventDefault(); });

/** Scans a Collab QR code with the camera (where the browser can read codes); the phone camera works everywhere. */
async function scan(h) {
  const box = document.getElementById("scanner");
  if (!("BarcodeDetector" in window) || !navigator.mediaDevices?.getUserMedia) {
    h.toast("Use your phone's camera app to scan a Collab QR code — it opens the chat here.");
    return;
  }
  const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } }).catch(() => null);
  if (!stream) return h.toast("Camera not available.");
  box.innerHTML = `<div class="card"><video autoplay playsinline muted style="width:100%;max-height:320px;background:#000"></video><button class="btn quiet compact" id="scan-stop">Close</button></div>`;
  const video = box.querySelector("video");
  video.srcObject = stream;
  const stop = () => { stream.getTracks().forEach(t => t.stop()); box.innerHTML = ""; };
  box.querySelector("#scan-stop").onclick = stop;
  const detector = new BarcodeDetector({ formats: ["qr_code"] });
  for (let i = 0; i < 600 && box.contains(video); i++) {
    const codes = await detector.detect(video).catch(() => []);
    const raw = codes[0]?.rawValue;
    if (raw) {
      const to = (() => { try { return new URL(raw).searchParams.get("to"); } catch { return null; } })();
      stop();
      if (to) return h.openDirect(to);
      try { const u = new URL(raw); if (u.origin === location.origin && u.pathname === "/pickup.html") return h.openPass(u.pathname + u.hash); } catch {}
      return h.toast("That isn't a Collab QR code.");
    }
    await new Promise(r => setTimeout(r, 250));
  }
  stop();
}
export { time };
