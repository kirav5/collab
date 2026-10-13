// The screens beside chat (Collab's Screens.swift): Context (what your agent knows, and who sees each thing),
// People, Sharing (rules for Protected topics, pause everything), Requests (every conversation between agents, live),
// Activity (what your agent shared, with whom) and Settings.
import { api, ios, session, standalone } from "./api.js";
import { engine } from "./agent.js";
import { engagementCard } from "./cards.js";
import { local } from "./local.js";
import { live } from "./live.js";
import { busy, esc, label, money, tag, tierTag, time } from "./ui.js";

const frame = (lbl, title, body) => `<div class="stack" style="gap:6px">${label(lbl, "sq")}<h1 class="headline">${title}</h1></div>${body}`;

/** Every fact the owner has — all tiers live on the server under their account; Private is never shared. */
async function allFacts() {
  return (await api("/api/facts").catch(() => [])).sort((a, b) => b.createdAt - a.createdAt);
}

export const screens = {
  context: {
    async html() {
      const facts = await allFacts();
      const n = t => facts.filter(f => f.tier === t).length;
      return frame("Context", "What your agent knows", `
        <div class="stats"><div>${label("Only me", "peri")}<b>${n("private")}</b></div><div>${label("Protected", "accent")}<b>${n("protected")}</b></div><div>${label("Public", "fresh")}<b>${n("public")}</b></div></div>
        <form class="card" data-form="add-fact">${label("Add to context", "sq")}
          <textarea class="field" name="text" rows="2" placeholder="e.g. My landlord is Kabir · I'm free weekday evenings · I teach guitar" required></textarea>
          <div class="row"><select class="field" name="tier" style="max-width:260px"><option value="private">Only me (never shared)</option><option value="protected">People my rules name (Protected)</option><option value="public">Anyone (Public, discoverable)</option></select>
          <button class="btn" data-act="add-fact">Save</button></div></form>
        <div class="stack">${facts.map(f => `<div class="card slim"><div class="row">${tierTag(f.tier, f.topics)}${f.offer ? tag("offering") : ""}${f.source === "chat" ? tag("from chat") : ""}<span class="end faint small">${new Date(f.createdAt * 1000).toLocaleDateString()}</span></div>
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
        await api("/api/facts", { text, tier });
        h.paint(); return true;
      }
      if (a === "fact-tier") {
        busy(el, true);
        const f = (await allFacts()).find(x => x.id === el.dataset.id);
        if (f) await api("/api/facts", { id: f.id, text: f.text, tier: el.dataset.tier });
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
      const contacts = await api("/api/contacts").catch(() => []);
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
              <button class="btn accent compact" data-act="scan">Scan a QR</button></div></div></div>
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
      if (a === "watch-stop") { await api(`/api/watches/${el.dataset.id}/stop`, {}); live.watches = live.watches.filter(x => x.id !== el.dataset.id); h.paint(); return true; }
    },
    async html() {
      const list = [...live.engagements.values()].sort((a, b) => {
        const need = e => (live.inbox.some(i => i.engagementId === e.id) ? 1 : 0);
        return need(b) - need(a) || b.updatedAt - a.updatedAt;
      });
      const incoming = list.filter(e => e.provider.uid === session.uid), outgoing = list.filter(e => e.provider.uid !== session.uid);
      const when = t => new Date(t * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
      return frame("Requests", "What your agents are doing", `
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
        <div class="card">${label("AI engine", "sq")}<p class="small muted">Which AI does what for your agent. Gemini understands what you type, shapes requests, and answers other people's agents for you — only ever from what you chose to share.</p><dl class="kv"><dt>Your notes</dt><dd>${engine.nano ? "Gemini Nano, on this device (Chrome built-in AI)" : "Gemini via Cloud Run"} — your Private facts are stored with your account but the policy gate never shares them.</dd>
          <dt>Your always-on agent</dt><dd>Gemini ${esc(session.config.model ?? "")} on Vertex AI, from your Public and Protected facts only</dd><dt>Between agents</dt><dd>A2A protocol v1.0 (JSON-RPC)</dd></dl></div>
        <div class="card">${label("App & notifications", "sq")}
          <span class="small muted">Install Collab to open it like an app. Notifications tell you when your agent needs you, someone's agent contacts yours, or a watch finds someone new — even with Collab closed. They never contain prices or private notes.</span>
          <dl class="kv"><dt>App</dt><dd>${standalone() ? `<span style="color:var(--fresh)">● Installed</span>`
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
