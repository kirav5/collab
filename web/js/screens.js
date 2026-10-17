// The screens beside chat (Collab's Screens.swift): Context (what your agent knows, and who sees each thing),
// People, Sharing (rules for Protected topics, pause everything), Requests (every conversation between agents, live),
// Activity (what your agent shared, with whom) and Settings.
import { api, ios, session, standalone, cached } from "./api.js";
import { detectEngine, downloadModel, engine, setProcessingMode } from "./agent.js";
import { MODEL, removeGemma } from "./gemma.js";
import { me, others, refreshServing, removeDevice, renameDevice, setServe } from "./mydevices.js";
import { defaultHours, engagementCard, hoursOk, hoursText } from "./cards.js";
import { local } from "./local.js";
import { live } from "./live.js";
import { busy, esc, label, money, tag, tierTag, time } from "./ui.js";
import { pendingWrites, saveNote } from "./outbox.js";

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
    case "absent": return `${MODEL.label} can run on this device, in this browser on its GPU — no internet needed after a one-time download of about 2 GB. Nothing it reads leaves the device.
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
  if (session.user?.isAnonymous) return `<div class="card">${label("My devices", "sq")}<p class="small">To use Collab on your other devices — and have your laptop's Gemma answer your phone — keep this account with Google first (below), then sign in with the same Google account on each device.</p></div>`;
  const ago = ms => { const m = Math.round((Date.now() - ms) / 60000); return m < 2 ? "online now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const row = d => `<div class="card slim"><div class="row"><b>${esc(d.name ?? "Device")}</b>${d.gemma ? tag(MODEL.label, "fresh") : tag("No Gemma", "")}${d.gemma && d.serve ? tag("Answers for my devices", "peri") : ""}<span class="end small faint">${ago(d.seen)}</span></div>
      <div class="row"><button class="btn quiet compact" data-act="device-remove" data-id="${esc(d.id)}">Remove</button></div></div>`;
  return `<div class="card">${label("My devices", "sq")}
    <p class="small muted">Your devices signed in with the same Google account. One that has ${MODEL.label} can answer questions about your notes for the others — end-to-end encrypted between your devices, so neither Google nor Collab can read them.</p>
    <div class="card slim"><div class="row"><b>This device</b><input class="field compact" data-device-name value="${esc(me.name ?? "")}" maxlength="60" aria-label="This device's name"><button class="btn quiet compact" data-act="device-rename">Rename</button></div>
      <label class="row small" style="gap:6px"><input type="checkbox" data-act="device-serve" ${me.serve ? "checked" : ""} ${engine.here ? "" : "disabled"}> Answer questions from my other devices with ${MODEL.label}${engine.here ? "" : " (download it here first)"}</label>
      <span class="small faint">Keep Collab open on it (a tab or the installed app) for it to answer.</span></div>
    ${others.length ? others.map(row).join("") : `<p class="small faint">No other devices yet.</p>`}
    <details class="more"><summary>Add a device</summary><p class="small">On your other phone, tablet or computer, open <b>${esc(location.origin)}</b> (or scan your QR in People) and choose <b>Continue with Google</b> with the same Google account. It appears here by itself.</p></details>
  </div>`;
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
            ${connected(r) || `<div class="row small"><button class="btn quiet compact" data-act="conn-pos" data-id="${esc(r.id)}">Connect a POS</button><span class="faint">its sales update this count</span></div>`}<div data-conn="${esc(r.id)}"></div>`;
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
      const termsRow = f => {
        if (f.tier !== "public" || !f.offer) return "";
        const ps = f.offer.policies ?? [];
        return `<details class="more"><summary>Your terms for buyers${ps.length ? ` · ${ps.length} set` : ""}${f.offer.instant ? " · instant booking on" : ""}</summary>
          <p class="small muted">Shown on your card and sealed into each deal's receipt exactly as you write them. Collab never writes terms for you. Don't put a phone number or home address here unless you want every buyer to see it.</p>
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
          ${stockRow(f)}${termsRow(f)}
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
          document.querySelector(`[data-conn="${CSS.escape(el.dataset.id)}"]`).innerHTML = `<div class="card slim"><b class="small">Give these to your POS (the key is shown once):</b>
            <code class="small" style="overflow-wrap:anywhere">${esc(r.eventsUrl)}</code><code class="small" style="overflow-wrap:anywhere">${esc(r.signingKey)}</code><span class="small faint">${esc(r.howTo)}</span></div>`;
        } catch (err) { h.toast(err.message); busy(el, false); }
        return true;
      }
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
            <span class="small muted">Anyone who scans it with their phone camera talks to your agent — no app to install. Put it on your shop counter: customers ask about stock, prices and orders without waiting in the queue.</span>
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

  sharing: {
    async html(S) {
      const [rules, contacts, facts] = await Promise.all([cached("/api/rules").catch(() => []), cached("/api/contacts").catch(() => []), allFacts()]);
      const topics = [...new Set(facts.filter(f => f.tier === "protected").flatMap(f => f.topics))];
      const shapeText = { yesNo: "Yes / no only", oneLine: "One line", summary: "A summary", full: "Everything in the fact" };
      return frame("Sharing", "Who sees what", `
        <div class="card ${S.profile.paused ? "accent" : ""}"><div class="row">${label(S.profile.paused ? "Sharing is paused" : "Sharing is on", "sq " + (S.profile.paused ? "stale" : "fresh"))}
          <button class="btn ${S.profile.paused ? "accent" : "secondary"} compact end" data-act="pause">${S.profile.paused ? "Resume" : "Pause everything"}</button></div>
          <span class="small muted">${S.profile.paused ? "While paused, your always-on agent answers nobody — not even from Public facts." : "Your always-on agent answers from your Public facts and from Protected facts a rule allows. Pause to stop it answering anyone."} Private facts are never shared either way.</span></div>
        <form class="card" data-form="rule">${label("New rule — Protected topics", "sq")}
          <div class="row"><span class="small">Who</span><select class="field" name="audience" style="max-width:280px"><option value="anyone">Anyone who contacts my agent</option>${contacts.map(c => `<option value="${esc(c.handle)}">${esc(c.name)} (@${esc(c.handle)})</option>`).join("")}</select></div>
          <div class="row"><span class="small">Topics</span><input class="field" name="topics" placeholder="availability, work" style="max-width:280px" value="${esc(topics.slice(0, 2).join(", "))}"></div>
          ${topics.length ? `<span class="small faint">Your Protected topics: ${topics.map(esc).join(", ")}</span>` : `<span class="small faint">Make a fact Protected in Context first; it gets topics.</span>`}
          <div class="row"><span class="small">How much</span><select class="field" name="shape" style="max-width:220px">${Object.entries(shapeText).map(([k, v]) => `<option value="${k}" ${k === "oneLine" ? "selected" : ""}>${v}</option>`).join("")}</select>
            <select class="field" name="approval" style="max-width:220px"><option value="review">Check with me first</option><option value="auto">Answer automatically</option></select>
            <select class="field" name="days" style="max-width:160px"><option value="1">For a day</option><option value="7">For a week</option><option value="30" selected>For a month</option><option value="">Until I remove it</option></select></div>
          <button class="btn" data-act="add-rule">Add rule</button></form>
        <div class="stack">${rules.map(r => `<div class="card slim"><div class="row"><b>${esc(r.audienceName)}</b><span class="end">${tag(r.approval === "auto" ? "Automatic" : "Check with me", r.approval === "auto" ? "fresh" : "stale")}</span></div>
          <span class="small">${r.topics.map(t => tag(t, "accent")).join(" ")} · ${esc(shapeText[r.shape])}${r.expires ? ` · until ${new Date(r.expires * 1000).toLocaleDateString()}` : ""}</span>
          <div class="row"><button class="btn danger compact end" data-act="revoke" data-id="${esc(r.id)}">Remove</button></div></div>`).join("") || `<p class="muted">No rules: Protected facts go to no one.</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "pause") { S.profile = await api("/api/me/pause", { paused: !S.profile.paused }); h.paint(); return true; }
      if (a === "add-rule") {
        const f = new FormData(el.closest("form"));
        busy(el, true);
        await api("/api/rules", { audience: f.get("audience"), topics: String(f.get("topics")).split(",").map(t => t.trim()).filter(Boolean), shape: f.get("shape"), approval: f.get("approval"), days: f.get("days") ? Number(f.get("days")) : null });
        h.paint(); return true;
      }
      if (a === "revoke") { await api(`/api/rules/${el.dataset.id}/revoke`, {}); h.paint(); return true; }
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
      if (a === "watch-stop") { await api(`/api/watches/${el.dataset.id}/stop`, {}); live.watches = live.watches.filter(x => x.id !== el.dataset.id); h.paint(); return true; }
    },
    async html() {
      const list = [...live.engagements.values()].sort((a, b) => {
        const need = e => (live.inbox.some(i => i.engagementId === e.id) ? 1 : 0);
        return need(b) - need(a) || b.updatedAt - a.updatedAt;
      });
      const incoming = list.filter(e => e.provider.uid === session.uid), outgoing = list.filter(e => e.provider.uid !== session.uid);
      const when = t => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      // Goals first: what you wanted, where it stands, and what happens next (each conversation is one of its tasks).
      const goals = await api("/api/goals").catch(() => []);
      const STATE = { draft: ["Draft", ""], active: ["In progress", "accent"], waiting: ["Needs you", "accent"], completed: ["Done", "fresh"],
        partially_completed: ["Partly done", "peri"], cancelled: ["Cancelled", ""], failed: ["Didn't work out", "danger"] };
      const open = goals.filter(g => !["completed", "cancelled", "failed"].includes(g.state)), done = goals.filter(g => !open.includes(g)).slice(0, 5);
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
      return frame("Requests", "What your agents are doing", `
        ${goals.length ? `${label(`Your goals · ${open.length} open`, "sq ink")}${open.map(goalRow).join("")}${done.length ? `<details class="more"><summary>Finished · ${done.length}</summary>${done.map(goalRow).join("")}</details>` : ""}` : ""}
        ${live.alerts.length ? `${label(`New matches · ${live.alerts.length}`, "sq accent")}${live.alerts.map(a => `<div class="card slim needs-card">
          <div class="row"><span class="avatar" aria-hidden="true">${esc(a.name.slice(0, 1).toUpperCase())}</span><div class="eng-who"><b>${esc(a.name)}</b><span class="small faint">fits “${esc(a.title)}” · found by your scheduled agent</span></div>${a.price ? `<span class="end"><b>${money(a.price, a.unit)}</b></span>` : ""}</div>
          <span class="small muted">${esc(a.text)}</span>
          <div class="row"><button class="btn accent compact" data-act="alert-ask" data-id="${esc(a.id)}">Ask their agent</button><button class="btn quiet compact" data-act="alert-done" data-id="${esc(a.id)}">Dismiss</button></div></div>`).join("")}` : ""}
        ${live.watches.length ? `${label(`Watching · ${live.watches.length}`, "sq")}${live.watches.map(w => `<div class="card slim"><div class="row"><span class="dot pulse" style="color:var(--fresh)"></span><b class="small">${esc(w.title)}</b>
          <button class="btn quiet compact end" data-act="watch-stop" data-id="${esc(w.id)}">Stop</button></div>
          <span class="small faint">Checks every ${w.every >= 60 ? `${w.every / 60} h` : `${w.every} min`} · ${w.runs ? `last ${when(w.lastRun)} · ` : ""}next ${when(w.nextRun)} · until ${new Date(w.expires * 1000).toLocaleDateString()}</span></div>`).join("")}` : ""}
        ${label(`Asked you · ${incoming.length}`, "sq")}${incoming.map(e => engagementCard(e, e.id)).join("") || `<p class="small muted">When someone's agent contacts yours, it shows up here — and notifies you when you're needed.</p>`}
        ${label(`You asked · ${outgoing.length}`, "sq")}${outgoing.map(e => engagementCard(e, e.id)).join("") || `<p class="small muted">Ask for something in chat: “Need a tabla teacher online”.</p>`}`);
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
        ${sold.length ? `<span class="small muted">Sold ${money(sum(sold.filter(paid)), null, sold[0]?.offer?.currency)} in test payments · ${sold.filter(done).length} handed over and accepted</span>` : ""}
        <span class="small faint">Counted on this device from your conversations. Nobody else sees these.</span></div>`;
      return frame("Activity", "What your agent shared", `${numbers}<p class="small muted">Every answer your always-on agent gave from a Public or Protected fact. Private facts never appear here — they're never shared without you.</p>
        <div class="stack">${items.map(x => `<div class="card slim"><div class="row">${tag(x.tier === "protected" ? "Protected" : "Public", x.tier === "protected" ? "accent" : "fresh")}<b class="small">To ${esc(x.to)}</b><span class="end faint small">${new Date(x.at * 1000).toLocaleString()}</span></div>
          <span class="small faint">${esc(x.question)}</span><span class="small">→ ${esc(x.answer)}</span></div>`).join("") || `<p class="muted">Nothing shared yet.</p>`}</div>`);
    },
  },

  settings: {
    async html(S) {
      const anon = session.user?.isAnonymous;
      return frame("Settings", "You and your agent", `
        <form class="card" data-form="profile">${label("Profile", "sq")}
          <input class="field" name="name" value="${esc(S.profile.name)}" placeholder="Name">
          <div class="row" style="flex-wrap:nowrap"><span class="faint">@</span><input class="field" name="handle" value="${esc(S.profile.handle)}"></div>
          <input class="field" name="bio" value="${esc(S.profile.bio)}" placeholder="One line about you (public)">
          <input class="field" name="area" value="${esc(S.profile.area?.name ?? "")}" placeholder="Your area">
          <button class="btn" data-act="save-profile">Save</button></form>
        <div class="card">${label("AI engine", "sq")}<p class="small muted">Which AI does what for your agent. Gemini understands what you type, shapes requests, and answers other people's agents for you — only ever from what you chose to share.</p><dl class="kv"><dt>Gemma on this device</dt><dd>${deviceAI()}</dd>
          <dt>Answer my notes with</dt><dd class="stack" style="gap:4px">${[["device-only", "Only this device", `${MODEL.label} here; if it can't, you're told — nothing is sent`],
            ["my-devices", "My devices", `${MODEL.label} here or on another of your devices — never the cloud`], ["cloud", "My devices, then the cloud", "Gemini on Vertex AI when none of your devices can"],
            ["cloud-only", "Only the cloud", "Gemini on Vertex AI every time — Gemma isn't used"]]
            .map(([v, t, d]) => `<label class="row small" style="gap:6px"><input type="radio" name="processing" data-act="processing" value="${v}" ${engine.mode === v ? "checked" : ""}> <b>${t}</b> <span class="faint">${d}</span></label>`).join("")}</dd>
          <dt>Your always-on agent</dt><dd>Gemini ${esc(session.config.model ?? "")} on Vertex AI, from your Public and Protected facts only</dd><dt>Between agents</dt><dd>A2A protocol v1.0 (JSON-RPC)</dd></dl></div>
        ${myDevices()}
        <div class="card">${label("App & notifications", "sq")}
          <span class="small muted">Install Collab to open it like an app. Notifications tell you when your agent needs you, someone's agent contacts yours, or a watch finds someone new — even with Collab closed. They never contain prices or private notes.</span>
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
      try { const u = new URL(raw); if (u.origin === location.origin && u.pathname === "/pickup.html") { location.href = u.href; return; } } catch {}
      return h.toast("That isn't a Collab QR code.");
    }
    await new Promise(r => setTimeout(r, 250));
  }
  stop();
}
export { time };
