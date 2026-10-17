// The screens beside chat (Collab's Screens.swift): Context (what your agent knows, and who sees each thing),
// People, Sharing (rules for Protected topics, pause everything), Requests (every conversation between agents, live),
// Activity (what your agent shared, with whom) and Settings.
import { api, ios, session, standalone, cached } from "./api.js";
import { detectEngine, downloadModel, engine, setProcessingMode } from "./agent.js";
import { MODEL, removeGemma } from "./gemma.js";
import { me, others, refreshServing, removeDevice, renameDevice, setServe } from "./mydevices.js";
import { dealAmount, defaultHours, engagementCard, hoursOk, hoursText, rulesList } from "./cards.js";
import { local } from "./local.js";
import { privacyFacts } from "./processing.js";
import { live, needsYou, needsYouCount } from "./live.js";
import { busy, esc, label, money, tag, tierTag, time } from "./ui.js";
import { pendingWrites, saveNote } from "./outbox.js";

/** Rules read from a seller's words on the Context screen, waiting for them to confirm (by offering). */
const ctxRules = new Map();

/** One of a seller's terms, editable: its name and what it says, in their words. */
const termRow = (id, l = "", t = "") => `<div class="row small" style="flex-wrap:nowrap" data-term-row="${esc(id)}"><input class="field compact" data-term-label value="${esc(l)}" placeholder="Term" maxlength="40" style="max-width:130px" aria-label="Term"><input class="field" data-term-text value="${esc(t)}" placeholder="In your own words" maxlength="240" aria-label="What it says"></div>`;

const frame = (lbl, title, body) => `<div class="stack" style="gap:6px">${label(lbl, "sq")}<h1 class="headline">${title}</h1></div>${body}`;

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
    case "downloading": return `<span class="spinner"></span> Downloading ${MODEL.label}…${pct} <span class="small faint">You can keep using Collab; if it stops, it resumes where it left off.</span>`;
    case "loading": return `<span class="spinner"></span> Loading ${MODEL.label} onto this device's GPU…`;
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
  const kinds = Object.entries(KIND).map(([k, v]) => `<button class="chip ${d.kind === k ? "on" : ""}" data-act="cm-kind" data-kind="${k}">${v.name}</button>`).join("");
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

export const screens = {
  context: {
    async html() {
      const facts = await allFacts();
      const n = t => facts.filter(f => f.tier === t).length;
      // Stock and time slots for public offerings: what reservations hold and payments commit.
      const ledgers = new Map((await api("/api/resources").catch(() => [])).map(r => [r.factId, r]));
      const grants = await api("/api/connectors").catch(() => []);
      const connected = r => grants.filter(g => g.resourceId === r.id && g.status !== "revoked").map(g => `<div class="row small"><span class="faint">${esc(g.title)} · ${g.status === "degraded" ? `<span style="color:var(--danger)">not reporting${g.lastError ? `: ${esc(g.lastError)}` : ""}</span>` : `connected${g.lastEventAt ? `, last ${new Date(g.lastEventAt * 1000).toLocaleString([], { hour: "numeric", minute: "2-digit" })}` : ""}`}</span>
        ${g.provider === "ical" ? `<button class="btn quiet compact" data-act="conn-sync" data-id="${esc(g.id)}">Sync now</button>` : ""}<button class="btn quiet compact" data-act="conn-revoke" data-id="${esc(g.id)}">Revoke</button></div>`).join("");
      const now_ = Date.now() / 1000;
      const stockRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const r = ledgers.get(f.id);
        if (!r) return `<div class="row small stock"><span class="faint">Availability not tracked — agents say you'll confirm.</span>
          <input class="field" type="number" min="0" style="max-width:90px" data-stock-new="${esc(f.id)}" placeholder="Qty"><button class="btn secondary compact" data-act="stock-track" data-id="${esc(f.id)}">Track stock</button>
          <button class="btn quiet compact" data-act="slots-track" data-id="${esc(f.id)}">Use time slots</button></div>`;
        if (r.type === "quantity") {
          const held = r.holds.filter(h => h.state === "held" && h.expiresAt > now_).reduce((n, h) => n + h.qty, 0);
          return `<div class="row small stock"><b>Stock ${r.onHand}</b>${held ? `<span class="faint">· ${held} reserved</span>` : ""}<span class="faint">· counted ${new Date(r.observedAt * 1000).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}</span>
            <input class="field" type="number" min="0" style="max-width:90px" data-stock="${esc(r.id)}" value="${r.onHand}"><button class="btn secondary compact" data-act="stock-set" data-id="${esc(r.id)}">Update</button></div>
            ${connected(r) || `<div class="row small"><button class="btn quiet compact" data-act="conn-pos" data-id="${esc(r.id)}">Connect billing software</button><span class="faint">its sales update this count</span></div>`}<div data-conn="${esc(r.id)}"></div>`;
        }
        const open = r.slots.filter(sl => sl.start > now_);
        const taken = sl => r.holds.filter(h => h.slotId === sl.id && (h.state === "committed" || (h.state === "held" && h.expiresAt > now_))).reduce((n, h) => n + h.qty, 0);
        const hrs = r.hours ?? defaultHours(f.offer), rid = esc(r.id);
        const hoursForm = `<details class="more"${r.hours || open.length ? "" : " open"}><summary>${r.hours ? `${esc(hoursText(r.hours))} · ${r.hours.minutes} min each · change` : "Set weekly hours — free times then refill on their own"}</summary>
          <div class="row">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip"><input type="checkbox" data-hours-day="${rid}" value="${d}" ${hrs.days.includes(d) ? "checked" : ""}> ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][d]}</label>`).join("")}</div>
          <div class="row"><input class="field compact" type="time" data-hours-from="${rid}" value="${esc(hrs.from)}" style="max-width:120px"><span>to</span><input class="field compact" type="time" data-hours-to="${rid}" value="${esc(hrs.to)}" style="max-width:120px">
            <input class="field compact" type="number" min="10" max="480" step="5" data-hours-mins="${rid}" value="${hrs.minutes}" style="max-width:80px"><span>min each</span></div>
          <div class="row"><button class="btn secondary compact" data-act="hours-save" data-id="${rid}">Save hours</button>${r.hours ? `<button class="btn quiet compact" data-act="hours-stop" data-id="${rid}">Stop weekly hours</button>` : ""}<span class="faint">Booked times always stay.</span></div></details>`;
        return `<div class="stack small stock"><b>Time slots · ${open.length} upcoming</b>${hoursForm}${open.slice(0, 6).map(sl => `<span class="faint">${new Date(sl.start * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} · ${taken(sl)}/${sl.capacity} booked</span>`).join("")}
          <div class="row"><input class="field" type="datetime-local" data-slot-start="${esc(r.id)}"><input class="field" type="number" min="15" step="15" style="max-width:90px" data-slot-mins="${esc(r.id)}" value="60" title="Minutes"><button class="btn secondary compact" data-act="slot-add" data-id="${esc(r.id)}">Add slot</button></div>
          ${connected(r) || `<div class="row small"><input class="field" type="url" placeholder="Calendar iCal URL (https)" data-ical="${esc(r.id)}"><button class="btn quiet compact" data-act="conn-ical" data-id="${esc(r.id)}">Connect calendar</button></div><span class="faint small">Only busy times are read — event titles stay with your calendar.</span>`}</div>`;
      };
      // The seller's own terms for an offering, and instant booking: their words, a row to add one, and Gemini's
      // suggestions for this listing on request. No headings or examples are put in front of them.
      // The seller's rules for their agent, in their words: what's in force, and a box to change them.
      const limits = new Map((await api("/api/limits").catch(() => [])).map(l => [l.key, l]));
      const rulesRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const l = limits.get(`fact:${f.id}`), id = esc(f.id);
        const now_ = [l ? `lowest ${money(l.limit)} (private)` : null, l?.autonomy === "close" ? (l.closeAt ? `closes on its own at ${money(l.closeAt)}+` : "closes on its own") : l ? "you confirm deals" : null,
          f.offer.maxPerBuyer ? `at most ${f.offer.maxPerBuyer} per buyer` : null].filter(Boolean).join(" · ");
        return `<details class="more"><summary>Your agent's rules${now_ ? ` · ${esc(now_)}` : " · none yet"}</summary>
          ${l?.rulesText ? `<span class="small faint">You said: “${esc(l.rulesText)}”</span>` : ""}
          <div class="row"><input class="field" style="flex:1;min-width:220px" data-ctx-rules="${id}" placeholder="e.g. never below ₹400 each, max 10 per buyer, close yourself above ₹420"><button class="btn secondary compact" data-act="ctx-rules-read" data-id="${id}">Read my rules</button></div>
          <div data-ctx-rules-preview="${id}"></div></details>`;
      };
      const termsRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const ps = f.offer.policies ?? [];
        return `<details class="more"><summary>Your terms for buyers${ps.length ? ` · ${ps.length} set` : ""}${f.offer.instant ? " · instant booking on" : ""}</summary>
          <p class="small muted">Shown on your card and in every receipt, exactly as written. No phone or address.</p>
          ${ps.map(p => termRow(f.id, p.label, p.text)).join("")}${termRow(f.id)}
          <label class="row small" style="gap:6px"><input type="checkbox" data-instant="${esc(f.id)}" ${f.offer.instant ? "checked" : ""}> Accept orders at my listed price automatically (instant booking) — offers below it still come to you</label>
          <div class="row"><button class="btn secondary compact" data-act="terms-save" data-id="${esc(f.id)}">Save terms</button><button class="btn quiet compact" data-act="terms-suggest" data-id="${esc(f.id)}" data-category="${esc(f.offer.category)}">Suggest terms for this offering</button></div></details>`;
      };
      return frame("Context", "What your agent knows", `
        <div class="stats"><div>${label("Only me", "peri")}<b>${n("private")}</b></div><div>${label("Protected", "accent")}<b>${n("protected")}</b></div><div>${label("Public", "fresh")}<b>${n("public")}</b></div></div>
        <form class="card" data-form="add-fact">${label("Add to context", "sq")}
          <textarea class="field" name="text" rows="2" placeholder="e.g. My landlord is Kabir · I'm free weekday evenings · I teach guitar" required></textarea>
          <div class="row"><select class="field" name="tier" style="max-width:260px"><option value="private">Only me (never shared)</option><option value="protected">People my rules name (Protected)</option><option value="public">Anyone (Public, discoverable)</option></select>
          <button class="btn" data-act="add-fact">Save</button></div></form>
        <div class="stack">${facts.map(f => `<div class="card slim"><div class="row">${tierTag(f.tier, f.topics)}${f.offer ? tag("offering") : ""}${f.source === "chat" ? tag("from chat") : ""}<span class="end faint small">${new Date(f.createdAt * 1000).toLocaleDateString()}</span></div>
          <span>${esc(f.text)}</span>
          ${stockRow(f)}${rulesRow(f)}${termsRow(f)}
          <div class="row">${["private", "protected", "public"].filter(t => t !== f.tier).map(t => `<button class="btn secondary compact" data-act="fact-tier" data-id="${esc(f.id)}" data-tier="${t}">Make ${{ private: "private", protected: "protected", public: "public" }[t]}</button>`).join("")}
            <button class="btn danger compact end" data-act="fact-delete" data-id="${esc(f.id)}">Delete</button></div></div>`).join("") || `<p class="muted">Nothing yet. Tell your agent things in chat, or add them here.</p>`}</div>`);
    },
    async act(a, el, S, h) {
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
        if (text.length < 4) { h.toast("Say your rules — e.g. “never below ₹400, close yourself above ₹420”."); return true; }
        busy(el, true, "Reading");
        try {
          const r = await api("/api/rules/read", { text, side: "seller", factId: id });
          ctxRules.set(id, { text, rules: r.rules });
          document.querySelector(`[data-ctx-rules-preview="${CSS.escape(id)}"]`).innerHTML = `<div class="card slim">${rulesList(r.lines)}<div class="row"><button class="btn accent compact" data-act="ctx-rules-confirm" data-id="${esc(id)}">Confirm rules</button><span class="small faint">Nothing applies until you confirm. New rules replace the old ones.</span></div></div>`;
        } catch (err) { h.toast(err.message); }
        busy(el, false); return true;
      }
      if (a === "ctx-rules-confirm") {
        const p = ctxRules.get(el.dataset.id);
        if (!p) return true;
        busy(el, true, "Saving");
        try { const r = await api(`/api/facts/${el.dataset.id}/rules`, p); ctxRules.delete(el.dataset.id); h.toast(r.needsFloor ? "Saved — add your lowest price so your agent can negotiate." : "Saved — your agent follows these from now on."); }
        catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "terms-suggest") {
        // Suggestions fill empty fields (and add new headings); nothing is saved until the seller taps Save terms.
        busy(el, true, "Suggesting");
        const f = (await allFacts()).find(x => x.id === el.dataset.id);
        const r = await api("/api/terms/suggest", { category: el.dataset.category, text: f?.text ?? "" }).catch(err => { h.toast(err.message); return null; });
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
          (blank ?? rows().at(-1)).insertAdjacentHTML("beforebegin", termRow(id, t.label, t.text) + (t.sources?.length ? `<span class="small faint">As sellers state it: ${t.sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || "source")}</a>`).join(" · ")}</span>` : ""));
        }
        h.toast("Suggested — edit anything, then Save terms. Nothing is saved yet.");
        return true;
      }
      if (a === "terms-save") {
        const id = el.dataset.id;
        const policies = [...document.querySelectorAll(`[data-term-row="${CSS.escape(id)}"]`)].map(r => ({ label: r.querySelector("[data-term-label]").value.trim(), text: r.querySelector("[data-term-text]").value.trim() })).filter(p => p.label && p.text);
        busy(el, true, "Saving");
        try { await api(`/api/facts/${encodeURIComponent(id)}/policies`, { policies, instant: !!document.querySelector(`[data-instant="${CSS.escape(id)}"]`)?.checked }); h.toast("Saved — buyers see these terms on your card and receipts."); }
        catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "stock-track" || a === "slots-track") {
        const qty = Number(document.querySelector(`[data-stock-new="${CSS.escape(el.dataset.id)}"]`)?.value);
        if (a === "stock-track" && !(Number.isInteger(qty) && qty >= 0)) { h.toast("Enter how many you have."); return true; }
        busy(el, true);
        try { await api("/api/resources", a === "stock-track" ? { factId: el.dataset.id, type: "quantity", onHand: qty } : { factId: el.dataset.id, type: "slots", slots: [] }); h.toast(a === "stock-track" ? "Stock tracked — deals now reserve it." : "Add your time slots below."); }
        catch (err) { h.toast(err.message); }
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
        } catch (err) { h.toast(err.message); busy(el, false); }
        return true;
      }
      if (a === "copy") { try { await navigator.clipboard.writeText(el.dataset.value); h.toast("Copied."); } catch { h.toast("Couldn't copy — select it under “For your developer”."); } return true; }
      if (a === "conn-ical") {
        const url = document.querySelector(`[data-ical="${CSS.escape(el.dataset.id)}"]`)?.value.trim();
        if (!url) { h.toast("Paste your calendar's iCal (https) address."); return true; }
        busy(el, true);
        try { const r = await api("/api/connectors", { provider: "ical", resourceId: el.dataset.id, url }); h.toast(r.grant.status === "degraded" ? `Connected, but the feed couldn't be read: ${r.grant.lastError}` : "Calendar connected — busy times now block slots."); }
        catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "conn-sync") { busy(el, true); const r = await api(`/api/connectors/${el.dataset.id}/sync`, {}).catch(e => ({ reason: e.message })); h.toast(r.synced ? `Synced — ${r.busy} busy times.` : `Couldn't sync: ${r.reason}`); h.paint(); return true; }
      if (a === "conn-revoke") {
        if (!confirm("Revoke this connection? It stops changing your availability; until you recount, availability shows as unconfirmed.")) return true;
        await api(`/api/connectors/${el.dataset.id}/revoke`, {}); h.toast("Revoked."); h.paint(); return true;
      }
      if (a === "stock-set") {
        const qty = Number(document.querySelector(`[data-stock="${CSS.escape(el.dataset.id)}"]`)?.value);
        busy(el, true);
        try { await api(`/api/resources/${el.dataset.id}/stock`, { onHand: qty }); h.toast("Stock updated."); } catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "hours-save" || a === "hours-stop") {
        const id = el.dataset.id, val = k => document.querySelector(`[data-hours-${k}="${CSS.escape(id)}"]`)?.value;
        const hours = a === "hours-stop" ? null : { days: [...document.querySelectorAll(`[data-hours-day="${CSS.escape(id)}"]:checked`)].map(i => Number(i.value)), from: val("from"), to: val("to"), minutes: Number(val("mins")) };
        if (hours && !hoursOk(hours)) { h.toast("Pick at least one day, and leave room for one booking between opening and closing."); return true; }
        busy(el, true);
        try { await api(`/api/resources/${id}/hours`, { hours, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }); h.toast(hours ? "Saved — free times are ready two weeks ahead and refill on their own." : "Weekly hours stopped. Booked times stay."); }
        catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "slot-add") {
        const start = Date.parse(document.querySelector(`[data-slot-start="${CSS.escape(el.dataset.id)}"]`)?.value ?? "") / 1000;
        const mins = Number(document.querySelector(`[data-slot-mins="${CSS.escape(el.dataset.id)}"]`)?.value) || 60;
        if (!start || start < Date.now() / 1000) { h.toast("Pick a future date and time."); return true; }
        busy(el, true);
        try { await api(`/api/resources/${el.dataset.id}/slots`, { slots: [{ start, end: start + mins * 60, capacity: 1 }] }); h.toast("Slot added."); } catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "fact-delete") {
        if (!confirm("Delete this from your context?")) return true;
        await api(`/api/facts/${el.dataset.id}/delete`, {}).catch(() => {});
        h.paint(); return true;
      }
    },
  },

  people: {
    async html(S) {
      const contacts = await cached("/api/contacts").catch(() => []);
      const card = `${location.origin}/a2a/${S.profile.handle}/.well-known/agent-card.json`;
      const link = `${location.origin}/?to=${encodeURIComponent(S.profile.handle)}`;
      let qr = "";
      try { qr = await (await import("https://esm.sh/qrcode@1.5.4")).default.toString(link, { type: "svg", margin: 1, color: { dark: "#0a0a0a", light: "#ffffff" } }); } catch { /* offline */ }
      return frame("People", "Who you know", `
        <div class="card qr-card">
          <div class="qr" aria-label="Your QR code">${qr}</div>
          <div class="stack" style="gap:6px">${label("Your QR code", "sq ink")}
            <span class="small muted">Scan with any phone camera to talk to your agent — no app. Put it on your counter.</span>
            <div class="row"><a class="btn secondary compact" download="collab-${esc(S.profile.handle)}-qr.svg" href="data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}">Download</a>
              <button class="btn secondary compact" data-act="copy-link" data-link="${esc(link)}">Copy link</button>
              <button class="btn accent compact" data-act="scan">Scan a QR</button>
              <button class="btn secondary compact" data-act="preview-card">See your card as customers do</button></div></div></div>
        <div id="scanner"></div>
        <div class="card">${label("Your agent", "sq ink")}<b>${esc(S.profile.name)} <span class="faint">@${esc(S.profile.handle)}</span></b>
          <span class="small muted">Other people's agents — in this app or any A2A agent — reach yours at:</span>
          <code class="small" style="overflow-wrap:anywhere">${esc(card)}</code></div>
        <form class="card" data-form="add-contact">${label("Add someone by handle", "sq")}<div class="row"><input class="field" name="handle" placeholder="@handle" style="max-width:260px"><button class="btn" data-act="add-contact">Add</button></div>
          <span class="small faint">Contacts can be named in rules (Sharing). Try @riya, @kabir, @arjun, @meera, @dev, @sana or @nikhil — demo people.</span></form>
        <div class="stack">${contacts.map(c => `<div class="card slim"><div class="row"><b>${esc(c.name)}</b><span class="faint small">@${esc(c.handle)}</span>
          <button class="btn secondary compact end" data-act="view-person" data-handle="${esc(c.handle)}">Public profile</button><button class="btn quiet compact" data-act="remove-contact" data-id="${esc(c.uid)}">Remove</button></div>
          <div id="person-${esc(c.handle)}"></div></div>`).join("") || `<p class="muted">No contacts yet.</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "copy-link") { await navigator.clipboard.writeText(el.dataset.link).catch(() => {}); h.toast("Link copied."); return true; }
      if (a === "scan") { await scan(h); return true; }
      if (a === "add-contact") { const handle = new FormData(el.closest("form")).get("handle"); busy(el, true); await api("/api/contacts", { handle: String(handle).replace(/^@/, "") }); h.paint(); return true; }
      if (a === "remove-contact") { await api("/api/contacts/remove", { uid: el.dataset.id }); h.paint(); return true; }
      if (a === "view-person") {
        const p = await api(`/api/people/${el.dataset.handle}`);
        document.getElementById(`person-${el.dataset.handle}`).innerHTML = `<div class="stack" style="margin-top:8px">${p.profile.bio ? `<span class="small muted">${esc(p.profile.bio)}</span>` : ""}${p.stats?.deals ? `<span class="small faint">${p.stats.deals} deal${p.stats.deals === 1 ? "" : "s"} · ${p.stats.kept} went ahead</span>` : ""}${p.facts.map(f => `<div class="row">${tag("Public", "fresh")}<span class="small">${esc(f.text)}</span></div>`).join("") || `<span class="small faint">Nothing public.</span>`}<a class="small" href="${esc(p.agentCard)}" target="_blank" rel="noopener">A2A agent card ↗</a></div>`;
        return true;
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
            <textarea class="field" name="text" rows="2" maxlength="400" placeholder="In your own words — e.g. “Cab from HSR to the office at 9 tomorrow, 2 seats” or “Anyone up for a bulk order of rice?”"></textarea>
            <div class="row"><button class="btn accent" data-act="cm-draft">Preview</button><span class="small faint">Gemini reads it into a trip, group, event, ask or offer. You check it before it goes up.</span></div></form>`}
          <div class="row" style="gap:6px;flex-wrap:wrap">${tabs.map(([k, t]) => `<button class="chip ${show === k ? "on" : ""}" data-act="cm-tab" data-tab="${k}">${esc(t)}</button>`).join("")}</div>
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
            <div class="row small" style="gap:6px;flex-wrap:wrap">${SPACES.map(([k, t], i) => `<button type="button" class="chip ${i === 0 ? "on" : ""}" data-act="cm-space" data-kind="${k}">${t}</button>`).join("")}</div>
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
      if (a === "cm-space") { form.querySelectorAll('[data-act="cm-space"]').forEach(b => b.classList.toggle("on", b === el)); form.elements.kind.value = el.dataset.kind; return true; }
      if (a === "cm-create") {
        const f = new FormData(form);
        busy(el, true, "Creating");
        try { const c = await api("/api/communities", { name: f.get("name"), kind: f.get("kind"), place: f.get("place") }); S.community = c.id; h.toast(`${c.name} is ready. Share its name so people nearby can join.`); h.paint(); }
        catch (e) { busy(el, false); h.toast(e.message); }
        return true;
      }
      if (a === "cm-join-community") { busy(el, true); try { await api(`/api/communities/${el.dataset.id}/join`, {}); S.community = el.dataset.id; h.paint(); } catch (e) { busy(el, false); h.toast(e.message); } return true; }
      if (a === "cm-leave") { if (!confirm("Leave this community? You can join again later.")) return true; await api(`/api/communities/${el.dataset.id}/join`, { leave: true }); S.community = null; h.paint(); return true; }
      if (a === "cm-message") { h.openDirect(el.dataset.handle); return true; }
      if (a === "cm-draft") {
        const text = String(new FormData(form).get("text") ?? "").trim();
        if (text.length < 4) { h.toast("Say what you'd like to post."); return true; }
        busy(el, true, "Reading");
        try { postDrafts.set(S.community, await api(`/api/communities/${S.community}/posts/draft`, { text })); h.paint(); }
        catch (e) { busy(el, false); h.toast(e.message); }
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
        } catch (e) { busy(el, false); h.toast(e.message); }
        return true;
      }
      if (a === "cm-join") {
        busy(el, true);
        try { await api(`/api/posts/${el.dataset.id}/join`, el.dataset.leave ? { leave: true } : {}); h.paint(); }
        catch (e) { busy(el, false); h.toast(e.message); }
        return true;
      }
      if (a === "cm-close") { if (!confirm("Close this post? Members won't see it any more.")) return true; await api(`/api/posts/${el.dataset.id}/close`, {}); h.paint(); return true; }
      return false;
    },
  },

  sharing: {
    async html(S) {
      const [rules, contacts, facts] = await Promise.all([cached("/api/rules").catch(() => []), cached("/api/contacts").catch(() => []), allFacts()]);
      const topics = [...new Set(facts.filter(f => f.tier === "protected").flatMap(f => f.topics))];
      const shapeText = { yesNo: "Yes or no", oneLine: "One line", summary: "A summary", full: "The whole fact" };
      // One form of taps: who, which topics (your own Protected topics as chips), how much, whether you check first, how long.
      const chip = (field, value, text, on) => `<button type="button" class="chip ${on ? "on" : ""}" data-act="rule-chip" data-field="${field}" data-value="${esc(value)}">${esc(text)}</button>`;
      return frame("Sharing", "Who sees what", `
        <div class="card ${S.profile.paused ? "accent" : ""}"><div class="row">${label(S.profile.paused ? "Paused" : "Your agent is answering", "sq " + (S.profile.paused ? "stale" : "fresh"))}
          <button class="btn ${S.profile.paused ? "accent" : "secondary"} compact end" data-act="pause">${S.profile.paused ? "Resume" : "Pause"}</button></div>
          <span class="small muted">${S.profile.paused ? "Your agent answers no one until you resume." : "It answers from Public facts and from Protected facts a rule below allows."} Private facts are never shared.</span></div>
        <form class="card" data-form="rule">${label("Share Protected facts", "sq")}
          <div class="row"><span class="small">With</span><select class="field" name="audience" style="max-width:280px"><option value="anyone">Anyone who contacts your agent</option>${contacts.map(c => `<option value="${esc(c.handle)}">${esc(c.name)} (@${esc(c.handle)})</option>`).join("")}</select></div>
          <div class="stack" style="gap:6px"><span class="small">About</span>
            ${topics.length ? `<div class="row">${topics.map((t, i) => chip("topics", t, t, i < 1)).join("")}</div><input type="hidden" name="topics" value="${esc(topics.slice(0, 1).join(","))}">`
              : `<span class="small faint">Mark a fact Protected in Context — its topics show up here.</span><input type="hidden" name="topics" value="">`}</div>
          <div class="stack" style="gap:6px"><span class="small">How much</span><div class="row">${Object.entries(shapeText).map(([k, v]) => chip("shape", k, v, k === "oneLine")).join("")}</div><input type="hidden" name="shape" value="oneLine"></div>
          <div class="stack" style="gap:6px"><span class="small">Before it answers</span><div class="row">${chip("approval", "review", "Ask me first", true)}${chip("approval", "auto", "Answer on its own", false)}</div><input type="hidden" name="approval" value="review"></div>
          <div class="stack" style="gap:6px"><span class="small">For</span><div class="row">${[["1", "A day"], ["7", "A week"], ["30", "A month"], ["", "Until removed"]].map(([k, v]) => chip("days", k, v, k === "30")).join("")}</div><input type="hidden" name="days" value="30"></div>
          <button class="btn" data-act="add-rule" ${topics.length ? "" : "disabled"}>Add rule</button></form>
        ${label(`Rules · ${rules.length}`, "sq")}
        <div class="stack">${rules.map(r => `<div class="card slim"><div class="row"><b class="small">${esc(r.audienceName)}</b><span class="end">${tag(r.approval === "auto" ? "On its own" : "Asks you", r.approval === "auto" ? "fresh" : "stale")}</span></div>
          <div class="row">${r.topics.map(t => tag(t, "accent")).join("")}<span class="small faint">${esc(shapeText[r.shape])}${r.expires ? ` · until ${new Date(r.expires * 1000).toLocaleDateString()}` : ""}</span><button class="btn quiet compact end" data-act="revoke" data-id="${esc(r.id)}">Remove</button></div></div>`).join("") || `<p class="small muted">None yet — Protected facts stay with you.</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "pause") { S.profile = await api("/api/me/pause", { paused: !S.profile.paused }); h.paint(); return true; }
      if (a === "add-rule") {
        const f = new FormData(el.closest("form"));
        busy(el, true);
        const topics = String(f.get("topics")).split(",").map(t => t.trim()).filter(Boolean);
        if (!topics.length) { h.toast("Pick at least one topic."); return true; }
        await api("/api/rules", { audience: f.get("audience"), topics, shape: f.get("shape"), approval: f.get("approval"), days: f.get("days") ? Number(f.get("days")) : null });
        h.paint(); return true;
      }
      if (a === "revoke") { await api(`/api/rules/${el.dataset.id}/revoke`, {}); h.paint(); return true; }
      if (a === "rule-chip") {
        // Topics can be several; every other choice is one.
        const form = el.closest("form"), field = el.dataset.field, input = form.querySelector(`input[name="${field}"]`);
        if (field === "topics") {
          el.classList.toggle("on");
          input.value = [...form.querySelectorAll('[data-field="topics"].on')].map(b => b.dataset.value).join(",");
        } else {
          form.querySelectorAll(`[data-field="${field}"]`).forEach(b => b.classList.toggle("on", b === el));
          input.value = el.dataset.value;
        }
        return true;
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
      if (a === "alert-done") { await api(`/api/alerts/${el.dataset.id}/done`, {}); live.alerts = live.alerts.filter(x => x.id !== el.dataset.id); h.paint(); return true; }
      if (a === "goal-budget") {
        const amount = Number(document.querySelector(`[data-goal-budget="${CSS.escape(el.dataset.id)}"]`)?.value) || 0;
        const currency = document.querySelector(`[data-goal-currency="${CSS.escape(el.dataset.id)}"]`)?.value ?? "INR";
        busy(el, true);
        try { await api(`/api/goals/${el.dataset.id}/budget`, { amount, currency }); h.toast(amount ? "Budget set — deals in this goal must fit it." : "Budget removed."); } catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "goal-plan") {
        busy(el, true, "Planning");
        try { const g = await api(`/api/goals/${el.dataset.id}/plan`, {}); h.toast(`${g.plan.length} step${g.plan.length === 1 ? "" : "s"} — ready steps are searching.`); } catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "goal-repeat" || a === "goal-repeat-stop") {
        const everyDays = a === "goal-repeat" ? Number(document.querySelector(`[data-goal-every="${CSS.escape(el.dataset.id)}"]`)?.value) || 7 : 0;
        await api(`/api/goals/${el.dataset.id}/recurrence`, { everyDays }); h.toast(everyDays ? `Your agent will look again every ${everyDays} days and tell you — it never buys on its own.` : "Stopped repeating."); h.paint(); return true;
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
      if (a === "goal-cancel") {
        if (!confirm("Cancel this goal? Conversations without a deal end; agreed deals keep their obligations.")) return true;
        await api(`/api/goals/${el.dataset.id}/cancel`, {}); h.toast("Goal cancelled."); h.paint(); return true;
      }
      if (a === "deal-jump") { const c = document.querySelector(`[data-engagement="${CSS.escape(el.dataset.id)}"]`); c?.scrollIntoView({ behavior: "smooth", block: "center" }); c?.classList.remove("flash"); void c?.offsetWidth; c?.classList.add("flash"); return true; }
      if (a === "watch-stop") { await api(`/api/watches/${el.dataset.id}/stop`, {}); live.watches = live.watches.filter(x => x.id !== el.dataset.id); h.paint(); return true; }
    },
    async html() {
      const list = [...live.engagements.values()].sort((a, b) => {
        const need = e => (live.inbox.some(i => i.engagementId === e.id) ? 1 : 0);
        return need(b) - need(a) || b.updatedAt - a.updatedAt;
      });
      const when = t => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      // Goals first: what you wanted, where it stands, and what happens next (each conversation is one of its tasks).
      const goals = await api("/api/goals").catch(() => []);
      const STATE = { draft: ["Draft", ""], active: ["In progress", "accent"], waiting: ["Needs you", "accent"], completed: ["Done", "fresh"],
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
          <div class="row small"><input class="field" type="number" min="0" style="max-width:110px" data-goal-budget="${id}" placeholder="Budget" value="${b?.amount ?? ""}"><select class="field" style="max-width:90px" data-goal-currency="${id}">${(session.policy?.currencies ?? ["INR"]).map(c => `<option ${b?.currency === c ? "selected" : ""}>${c}</option>`).join("")}</select><button class="btn secondary compact" data-act="goal-budget" data-id="${id}">Set budget</button></div>
          ${g.plan?.length ? "" : `<div class="row small"><button class="btn secondary compact" data-act="goal-plan" data-id="${id}">Plan it — several providers</button><span class="faint">Gemini splits it into steps; each step searches when ready</span></div>`}
          <div class="row small"><span>Repeat every</span><input class="field" type="number" min="1" max="90" style="max-width:70px" data-goal-every="${id}" value="${g.recurrence?.everyDays ?? 7}"><span>days</span><button class="btn quiet compact" data-act="goal-repeat" data-id="${id}">${g.recurrence && !g.recurrence.stopped ? "Update" : "Repeat"}</button>${g.recurrence && !g.recurrence.stopped ? `<button class="btn quiet compact" data-act="goal-repeat-stop" data-id="${id}">Stop</button>` : ""}</div>
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
      const STAGE = e => { const f = e.fulfilment?.state, p = e.payment?.status;
        return f === "accepted" ? ["Completed", "fresh"] : f === "disputed" ? ["Problem", "danger"] : off(e) ? ["Fell through", ""] : f === "delivered" ? (toConfirm(e) ? ["Confirm receipt", "wait"] : ["Handed over", "peri"]) : p === "paid" || p === "outside" ? ["Paid", "accent"] : ["To pay", "stale"]; };
      const dealRow = e => {
        const side = me(e), them = side === "provider" ? e.requester : e.provider, mineSold = sellerOf(e) === side;
        const d = e.negotiation.deal, n = d.items?.length ? d.items.reduce((t, l) => t + l.quantity, 0) : d.terms?.quantity > 1 ? d.terms.quantity : 1;
        const total = e.payment?.cart?.total?.value ?? (d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : d.price * n);
        const [st, tone] = STAGE(e), at = new Date((e.agreedAt ?? e.updatedAt) * 1000).toLocaleDateString([], { day: "numeric", month: "short" });
        const line = `<span class="deal-line">${tag(mineSold ? "Sold" : "Bought", mineSold ? "fresh" : "peri")}<b class="grow">${esc((e.offer?.title ?? e.title).split(" · ")[0])}${n > 1 ? ` × ${n}` : ""}</b><span class="deal-amt">${money(total, null, e.offer.currency)}</span></span>
          <span class="deal-line small"><span class="faint">${mineSold ? "to" : "from"} ${esc(them.name)} · ${esc(at)}</span>${tag(st, tone)}</span>`;
        return shownAbove.has(e.id) ? `<button class="deal-row deal-jump" data-act="deal-jump" data-id="${esc(e.id)}" data-anim="d-${esc(e.id)}" data-anim-sig="${esc(st)}" title="Open this deal above">${line}</button>`
          : `<details class="more deal-row" data-anim="d-${esc(e.id)}" data-anim-sig="${esc(st)}"><summary>${line}</summary>${engagementCard(e, e.id)}</details>`;
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
          <div class="row"><span class="avatar" aria-hidden="true">${esc(a.name.slice(0, 1).toUpperCase())}</span><div class="eng-who"><b>${esc(a.name)}</b><span class="small faint">fits “${esc(a.title)}” · found by your scheduled agent</span></div>${a.price ? `<span class="end"><b>${money(a.price, a.unit)}</b></span>` : ""}</div>
          <span class="small muted">${esc(a.text)}</span>
          <div class="row"><button class="btn accent compact" data-act="alert-ask" data-id="${esc(a.id)}">Ask their agent</button><button class="btn quiet compact" data-act="alert-done" data-id="${esc(a.id)}">Dismiss</button></div></div>`).join("");
      return frame("Requests", "What your agents are doing", `
        <div class="card slim attention ${need ? "wait" : ""}" data-anim="att" data-anim-sig="${need}"><span>${moves ? `Your agents made <b>${moves}</b> move${moves === 1 ? "" : "s"} today${closed ? ` and agreed <b>${closed}</b> deal${closed === 1 ? "" : "s"} inside your rules` : ""}.` : "Your agents are standing by."} ${need ? `<b>${need}</b> need${need === 1 ? "s" : ""} you.` : "Nothing needs you right now."}</span></div>
        ${label(`Waiting for you · ${need}`, "sq wait")}${alerts}${waiting.map(e => engagementCard(e, e.id)).join("") || (alerts ? "" : `<p class="small muted">Nothing waits on you. Your agents ask only when a decision is yours.</p>`)}
        ${talking.length ? `${label(`Agents negotiating · ${talking.length}`, "sq talk")}${talking.map(row).join("")}` : ""}
        ${toFinish.length ? `${label(`Agreed — to pay or hand over · ${toFinish.length}`, "sq fresh")}${toFinish.map(e => engagementCard(e, e.id)).join("")}` : ""}
        ${goals.length ? `${label(`Your goals · ${open.length} open`, "sq ink")}${open.map(goalRow).join("")}${doneGoals.length ? `<details class="more"><summary>Finished goals · ${doneGoals.length}</summary>${doneGoals.map(goalRow).join("")}</details>` : ""}` : ""}
        ${live.watches.length ? `${label(`Watching · ${live.watches.length}`, "sq")}${live.watches.map(w => `<div class="card slim"><div class="row"><span class="dot pulse" style="color:var(--fresh)"></span><b class="small">${esc(w.title)}</b>
          <button class="btn quiet compact end" data-act="watch-stop" data-id="${esc(w.id)}">Stop</button></div>
          <span class="small faint">Checks every ${w.every >= 60 ? `${w.every / 60} h` : `${w.every} min`} · ${w.runs ? `last ${when(w.lastRun)} · ` : ""}next ${when(w.nextRun)} · until ${new Date(w.expires * 1000).toLocaleDateString()}</span></div>`).join("")}` : ""}
        ${deals.length ? `${label(`Your deals · ${deals.length}`, "sq ink")}
          <div class="card slim deals-sum"><div class="row" style="flex-wrap:wrap;gap:14px">${sold.length ? `<span><b>${sold.length}</b> sold${soldSum ? ` · ${soldSum} paid` : ""}</span>` : ""}${bought.length ? `<span><b>${bought.length}</b> bought${boughtSum ? ` · ${boughtSum} paid` : ""}</span>` : ""}<span><b>${deals.filter(e => e.fulfilment?.state === "accepted").length}</b> completed</span></div>
            ${sold.length ? `<div class="row small"><span class="muted">Your sales are on your public card as a verified record — buyers and prices stay private.</span><button class="btn quiet compact end" data-act="preview-card">See your card</button></div>` : ""}</div>
          ${deals.map(dealRow).join("")}` : ""}
        ${gone.length ? `<details class="more"><summary>Ended · ${gone.length}</summary>${gone.map(e => row(e).replace('class="more eng-row"', 'class="more eng-row ended"')).join("")}</details>` : ""}
        ${!list.length && !goals.length ? `<p class="small muted">Ask for something in chat — “Need a tabla teacher online” — or open someone's card. Your agents' work shows up here.</p>` : ""}`);
    },
  },

  activity: {
    async html() {
      const items = await cached("/api/activity").catch(() => []);
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
      return frame("Activity", "What your agent shared", `${numbers}<p class="small muted">What your agent shared, and with whom. Private notes never appear.</p>
        <div class="stack">${items.map(x => `<div class="card slim"><div class="row">${tag(x.tier === "protected" ? "Protected" : "Public", x.tier === "protected" ? "accent" : "fresh")}<b class="small">To ${esc(x.to)}</b><span class="end faint small">${new Date(x.at * 1000).toLocaleString()}</span></div>
          <span class="small faint">${esc(x.question)}</span><span class="small">→ ${esc(x.answer)}</span></div>`).join("") || `<p class="muted">Nothing shared yet.</p>`}</div>`);
    },
  },

  settings: {
    async html(S) {
      const anon = session.user?.isAnonymous;
      let look = "auto"; try { look = localStorage.getItem("collab-theme") || "auto"; } catch { /* private window */ }
      return frame("Settings", "You and your agent", `
        <div class="card">${label("Appearance", "sq")}<div class="row">${[["auto", "Auto"], ["light", "Light"], ["dark", "Dark"]].map(([k, v]) => `<button class="chip ${(["light", "dark"].includes(look) ? look : "auto") === k ? "on" : ""}" data-act="theme" data-value="${k}">${v}</button>`).join("")}<span class="small faint">Auto follows your device.</span></div>
          <div class="row"><span class="small">Animations</span>${[["on", "On"], ["off", "Off"]].map(([k, v]) => `<button class="chip ${(document.documentElement.dataset.motion ?? "on") === k ? "on" : ""}" data-act="motion" data-value="${k}">${v}</button>`).join("")}</div></div>
        <form class="card" data-form="profile">${label("Profile", "sq")}
          <input class="field" name="name" value="${esc(S.profile.name)}" placeholder="Name">
          <div class="row" style="flex-wrap:nowrap"><span class="faint">@</span><input class="field" name="handle" value="${esc(S.profile.handle)}"></div>
          <input class="field" name="bio" value="${esc(S.profile.bio)}" placeholder="One line about you (public)">
          <input class="field" name="area" value="${esc(S.profile.area?.name ?? "")}" placeholder="Your area">
          <button class="btn" data-act="save-profile">Save</button></form>
        <div class="card">${label("AI engine", "sq")}<dl class="kv small">${privacyFacts(engine.mode).map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join("")}</dl><dl class="kv"><dt>Gemma on this device</dt><dd>${deviceAI()}</dd>
          <dt>Answer my notes with</dt><dd class="stack" style="gap:4px">${[["device-only", "Only this device", "nothing sent"],
            ["my-devices", "My devices", "never the cloud"], ["cloud", "My devices, then the cloud", "Gemini if none can"],
            ["cloud-only", "Only the cloud", "always Gemini"]]
            .map(([v, t, d]) => `<label class="row small" style="gap:6px"><input type="radio" name="processing" data-act="processing" value="${v}" ${engine.mode === v ? "checked" : ""}> <b>${t}</b> <span class="faint">${d}</span></label>`).join("")}</dd>
          <dt>Your always-on agent</dt><dd>Gemini ${esc(session.config.model ?? "")} on Vertex AI, from your Public and Protected facts only</dd><dt>Between agents</dt><dd>A2A protocol v1.0 (JSON-RPC)</dd></dl></div>
        ${myDevices()}
        <div class="card">${label("App & notifications", "sq")}
          <span class="small muted">Get told when your agent needs you, even with Collab closed. Never prices or notes.</span>
          <dl class="kv"><dt>Browser check</dt><dd>${session.appCheckOk ? `<span style="color:var(--fresh)">● Verified by Google reCAPTCHA</span>`
            : session.appCheckError ? `<span style="color:var(--stale)">● Couldn't verify this browser</span> <span class="small faint">(${esc(session.appCheckError.code)})</span><br><span class="small muted">Chat and requests still work. Payments, pickups and price checks need it: reload Collab, or allow google.com in your content blocker.</span>`
            : `<span class="small muted">Checking…</span>`}</dd>
          <dt>App</dt><dd>${standalone() ? `<span style="color:var(--fresh)">● Installed</span>`
            : session.install ? `<button class="btn secondary compact" data-act="install">📲 Install Collab</button>`
            : ios() ? `In Safari, tap <b>Share</b> (the square with an arrow), then <b>Add to Home Screen</b>. Open Collab from the home screen — notifications on iPhone only work there.`
            : `In your browser's menu choose <b>Install app</b> or <b>Add to Home screen</b>.`}</dd>
          <dt>Notifications</dt><dd>${session.pushOn ? `<span style="color:var(--fresh)">● On for this device</span> <button class="btn quiet compact" data-act="push-test">Send a test notification</button>`
            : "Notification" in window && Notification.permission === "denied" ? `Blocked — allow notifications for this site in your browser's site settings, then reload.`
            : `<button class="btn secondary compact" data-act="push-on">🔔 Turn on notifications</button>`}</dd></dl></div>
        <div class="card">${label("Account", "sq")}
          ${session.google && anon ? `<span class="small muted">You're a guest. Sign in with Google to keep your handle and context on other devices.</span><button class="btn secondary" data-act="google">Sign in with Google</button>` : `<span class="small muted">${esc(session.user?.email ?? "Signed in")}</span>`}
          <div class="row"><button class="btn danger compact" data-act="clear-device">Delete chat history</button>${session.signOut ? `<button class="btn quiet compact" data-act="sign-out">Sign out</button>` : ""}</div></div>`);
    },
    async act(a, el, S, h) {
      if (a === "motion") {
        try { localStorage.setItem("collab-motion", el.dataset.value); } catch { /* this session only */ }
        window.applyLook?.(); h.paint(); return true;
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
        catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "gemma-remove") { busy(el, true); await removeGemma(); await detectEngine(); refreshServing(); h.toast(`${MODEL.label} removed from this device.`); h.paint(); return true; }
      if (a === "processing") {
        setProcessingMode(el.value);
        h.toast(el.value === "device-only" ? `Your notes are answered by ${MODEL.label} on this device only.` : el.value === "cloud" ? "Your devices first, then Gemini in the cloud if none can." : el.value === "cloud-only" ? "Your notes are answered by Gemini in the cloud." : `Your notes are answered by ${MODEL.label} on your own devices only — never the cloud.`);
        h.paint(); return true;
      }
      if (a === "device-rename") { await renameDevice(document.querySelector("[data-device-name]")?.value ?? ""); h.toast("Renamed."); h.paint(); return true; }
      if (a === "device-serve") { await setServe(el.checked); h.toast(el.checked ? "This device answers your other devices' questions while Collab is open." : "This device no longer answers for your other devices."); h.paint(); return true; }
      if (a === "device-remove") { busy(el, true); await removeDevice(el.dataset.id).catch(err => h.toast(err.message)); h.paint(); return true; }
      if (a === "push-test") {
        busy(el, true, "Sending");
        try { const r = await api("/api/push/test", {}); h.toast(r.sent ? `Sent to ${r.sent} device${r.sent === 1 ? "" : "s"} — it should appear in a few seconds.` : "The notification service didn't accept it — try turning notifications off and on."); }
        catch (err) { h.toast(err.message); }
        busy(el, false); return true;
      }
      if (a === "install") { if (session.install && await session.install()) h.toast("Installed."); h.paint(); return true; }
      if (a === "push-on") {
        busy(el, true);
        try { if (await session.push()) h.toast("Notifications are on for this device."); } catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "google") {
        busy(el, true, "Opening Google");
        try {
          const r = await session.google();
          if (r === "switched") { h.toast("That Google account already has Collab — switching to it."); setTimeout(() => location.reload(), 800); return true; }
          if (r === "linked") h.toast("Signed in with Google. Your handle and context now follow you to any device.");
        } catch (err) { h.toast(err.message); }
        h.paint(); return true;
      }
      if (a === "clear-device") { if (confirm("Delete your chat history on every device? Your context, facts, people and deals stay.")) { await api("/api/chats/clear", {}); await local.clear(); location.reload(); } return true; }
      if (a === "sign-out") {
        if (session.user?.isAnonymous && !confirm("You're a guest: signing out loses this identity for good. Sign in with Google first to keep it. Sign out anyway?")) return true;
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
