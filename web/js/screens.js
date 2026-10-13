// The screens beside chat (Collab's Screens.swift): Context (what your agent knows, and who sees each thing),
// People, Sharing (rules for Protected topics, pause everything), Requests (every conversation between agents, live),
// Activity (what your agent shared, with whom) and Settings.
import { api, session } from "./api.js";
import { engine } from "./agent.js";
import { engagementCard } from "./cards.js";
import { local } from "./local.js";
import { live } from "./live.js";
import { busy, esc, id, label, now, tag, tierTag, time } from "./ui.js";

const frame = (lbl, title, body) => `<div class="stack" style="gap:6px">${label(lbl, "sq")}<h1 class="headline">${title}</h1></div>${body}`;

/** Every fact the owner has: private ones from this device, shared ones from the server (the device keeps a copy). */
async function allFacts() {
  const mine = await local.all("facts");
  const shared = await api("/api/facts").catch(() => []);
  const byId = new Map(mine.map(f => [f.id, f]));
  for (const f of shared) {
    const cur = byId.get(f.id);
    const next = { id: f.id, text: f.text, tier: f.tier, topics: f.topics, createdAt: f.createdAt, offer: f.offer };
    if (!cur || cur.tier !== f.tier || (cur.topics ?? []).join() !== f.topics.join()) await local.put("facts", next);
    byId.set(f.id, next);
  }
  // A fact the device thinks is shared but the server no longer has (deleted elsewhere) is private again.
  for (const f of mine) if (f.tier !== "private" && !shared.some(x => x.id === f.id)) { const p = { ...f, tier: "private", topics: [] }; await local.put("facts", p); byId.set(f.id, p); }
  return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
}

export const screens = {
  context: {
    async html() {
      const facts = await allFacts();
      const n = t => facts.filter(f => f.tier === t).length;
      return frame("Context", "What your agent knows", `
        <div class="stats"><div>${label("On device", "peri")}<b>${n("private")}</b></div><div>${label("Protected", "accent")}<b>${n("protected")}</b></div><div>${label("Public", "fresh")}<b>${n("public")}</b></div></div>
        <form class="card" data-form="add-fact">${label("Add to context", "sq")}
          <textarea class="field" name="text" rows="2" placeholder="e.g. My landlord is Kabir · I'm free weekday evenings · I teach guitar" required></textarea>
          <div class="row"><select class="field" name="tier" style="max-width:260px"><option value="private">Only me (on this device)</option><option value="protected">People my rules name (Protected)</option><option value="public">Anyone (Public, discoverable)</option></select>
          <button class="btn" data-act="add-fact">Save</button></div></form>
        <div class="stack">${facts.map(f => `<div class="card slim"><div class="row">${tierTag(f.tier, f.topics)}${f.offer ? tag("offering") : ""}<span class="end faint small">${new Date(f.createdAt * 1000).toLocaleDateString()}</span></div>
          <span>${esc(f.text)}</span>
          <div class="row">${["private", "protected", "public"].filter(t => t !== f.tier).map(t => `<button class="btn secondary compact" data-act="fact-tier" data-id="${esc(f.id)}" data-tier="${t}">Make ${{ private: "private", protected: "protected", public: "public" }[t]}</button>`).join("")}
            <button class="btn danger compact end" data-act="fact-delete" data-id="${esc(f.id)}">Delete</button></div></div>`).join("") || `<p class="muted">Nothing yet. Tell your agent things in chat, or add them here.</p>`}</div>`);
    },
    async act(a, el, S, h) {
      if (a === "add-fact") {
        const form = el.closest("form"); const f = new FormData(form);
        const text = String(f.get("text") ?? "").trim(), tier = String(f.get("tier"));
        if (!text) return true;
        busy(el, true);
        if (tier === "private") await local.put("facts", { id: id(), text, tier, topics: [], createdAt: now() });
        else { const saved = await api("/api/facts", { text, tier }); await local.put("facts", { id: saved.id, text: saved.text, tier, topics: saved.topics, createdAt: saved.createdAt, offer: saved.offer }); }
        h.paint(); return true;
      }
      if (a === "fact-tier") {
        busy(el, true);
        const f = await local.get("facts", el.dataset.id);
        if (el.dataset.tier === "private") { await api(`/api/facts/${f.id}/delete`, {}).catch(() => {}); await local.put("facts", { ...f, tier: "private", topics: [] }); }
        else { const saved = await api("/api/facts", { id: f.id, text: f.text, tier: el.dataset.tier }); await local.put("facts", { ...f, id: saved.id, tier: saved.tier, topics: saved.topics, offer: saved.offer }); }
        h.paint(); return true;
      }
      if (a === "fact-delete") {
        if (!confirm("Delete this from your context?")) return true;
        const f = await local.get("facts", el.dataset.id);
        if (f && f.tier !== "private") await api(`/api/facts/${f.id}/delete`, {}).catch(() => {});
        await local.del("facts", el.dataset.id);
        h.paint(); return true;
      }
    },
  },

  people: {
    async html(S) {
      const contacts = await api("/api/contacts").catch(() => []);
      const card = `${location.origin}/a2a/${S.profile.handle}/.well-known/agent-card.json`;
      return frame("People", "Who you know", `
        <div class="card">${label("Your agent", "sq ink")}<b>${esc(S.profile.name)} <span class="faint">@${esc(S.profile.handle)}</span></b>
          <span class="small muted">Other people's agents — in this app or any A2A agent — reach yours at:</span>
          <code class="small" style="overflow-wrap:anywhere">${esc(card)}</code></div>
        <form class="card" data-form="add-contact">${label("Add someone by handle", "sq")}<div class="row"><input class="field" name="handle" placeholder="@handle" style="max-width:260px"><button class="btn" data-act="add-contact">Add</button></div>
          <span class="small faint">Contacts can be named in rules (Sharing). Try @riya, @kabir, @arjun, @meera, @dev or @sana — demo people.</span></form>
        <div class="stack">${contacts.map(c => `<div class="card slim"><div class="row"><b>${esc(c.name)}</b><span class="faint small">@${esc(c.handle)}</span>
          <button class="btn secondary compact end" data-act="view-person" data-handle="${esc(c.handle)}">Public profile</button><button class="btn quiet compact" data-act="remove-contact" data-id="${esc(c.uid)}">Remove</button></div>
          <div id="person-${esc(c.handle)}"></div></div>`).join("") || `<p class="muted">No contacts yet.</p>`}</div>`);
    },
    async act(a, el, S, h) {
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
      const [rules, contacts, facts] = await Promise.all([api("/api/rules").catch(() => []), api("/api/contacts").catch(() => []), allFacts()]);
      const topics = [...new Set(facts.filter(f => f.tier === "protected").flatMap(f => f.topics))];
      const shapeText = { yesNo: "Yes / no only", oneLine: "One line", summary: "A summary", full: "Everything in the fact" };
      return frame("Sharing", "Who sees what", `
        <div class="card ${S.profile.paused ? "accent" : ""}"><div class="row">${label(S.profile.paused ? "Sharing is paused" : "Sharing is on", "sq " + (S.profile.paused ? "stale" : "fresh"))}
          <button class="btn ${S.profile.paused ? "accent" : "secondary"} compact end" data-act="pause">${S.profile.paused ? "Resume" : "Pause everything"}</button></div>
          <span class="small muted">Paused: your always-on agent answers nobody, Public included. Private facts are never shared either way.</span></div>
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
    async html() {
      const list = [...live.engagements.values()].sort((a, b) => {
        const need = e => (live.inbox.some(i => i.engagementId === e.id) ? 1 : 0);
        return need(b) - need(a) || b.updatedAt - a.updatedAt;
      });
      const incoming = list.filter(e => e.provider.uid === session.uid), outgoing = list.filter(e => e.provider.uid !== session.uid);
      return frame("Requests", "What your agents are doing", `
        ${label(`Asked you · ${incoming.length}`, "sq")}${incoming.map(e => engagementCard(e, e.id)).join("") || `<p class="small muted">When someone's agent contacts yours, it shows up here — and notifies you when you're needed.</p>`}
        ${label(`You asked · ${outgoing.length}`, "sq")}${outgoing.map(e => engagementCard(e, e.id)).join("") || `<p class="small muted">Ask for something in chat: “Need a tabla teacher online”.</p>`}`);
    },
  },

  activity: {
    async html() {
      const items = await api("/api/activity").catch(() => []);
      return frame("Activity", "What your agent shared", `<p class="small muted">Every answer your always-on agent gave from a Public or Protected fact. Private facts never appear here — they're never shared without you.</p>
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
        <div class="card">${label("Engine", "sq")}<dl class="kv"><dt>Your notes</dt><dd>${engine.nano ? "Gemini Nano, on this device (Chrome built-in AI)" : "Gemini via Cloud Run, for that one call — nothing stored. (Chrome with built-in AI reads them on the device instead.)"}</dd>
          <dt>Your always-on agent</dt><dd>Gemini ${esc(session.config.model ?? "")} on Vertex AI, from your Public and Protected facts only</dd><dt>Between agents</dt><dd>A2A protocol v1.0 (JSON-RPC)</dd></dl></div>
        <div class="card">${label("Account", "sq")}
          ${session.google && anon ? `<span class="small muted">You're a guest. Sign in with Google to keep your handle and shared facts on other devices (private facts stay on each device).</span><button class="btn secondary" data-act="google">Sign in with Google</button>` : `<span class="small muted">${esc(session.user?.email ?? "Signed in")}</span>`}
          <div class="row"><button class="btn danger compact" data-act="clear-device">Erase this device's data</button>${session.signOut ? `<button class="btn quiet compact" data-act="sign-out">Sign out</button>` : ""}</div></div>`);
    },
    async act(a, el, S, h) {
      if (a === "save-profile") { const f = new FormData(el.closest("form")); busy(el, true); S.profile = await api("/api/me", { name: f.get("name"), handle: String(f.get("handle")).toLowerCase(), bio: f.get("bio"), areaName: f.get("area") }); h.toast("Saved."); h.paint(); return true; }
      if (a === "google") { await session.google(); h.paint(); return true; }
      if (a === "clear-device") { if (confirm("Erase every private fact and chat on this device? Shared facts stay on the server.")) { await local.clear(); location.reload(); } return true; }
      if (a === "sign-out") { await session.signOut(); return true; }
    },
  },
};

document.addEventListener("submit", e => { if (e.target.dataset.form) e.preventDefault(); });
export { time };
