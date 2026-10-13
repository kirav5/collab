// The dynamic cards in chat (Collab's ComponentViews): each card is data in a chat message, rendered from that data
// plus live state, with buttons that act through `act`. A request is shaped with Gemini (its questions come with
// tap-to-answer options), sent, matched, and each conversation between agents is a live card that shows progress
// and asks the owner exactly when it needs them.
import { session } from "./api.js";
import { drafts, needsLimit } from "./agent.js";
import { live } from "./live.js";
import { byTag, esc, label, money, tag, tierTag, time } from "./ui.js";

const PHASE = { asking: ["Agents talking", "accent"], negotiating: ["Negotiating", "accent"], deal: ["Deal to confirm", "fresh"], agreed: ["Agreed", "fresh"], declined: ["Declined", "danger"], closed: ["Closed", ""] };
const STATUS_ICON = { open: "○", pending: "◔", answered: "●", declined: "✕" };
const VERDICT = { met: tag("met", "fresh"), unmet: tag("not met", "danger"), unclear: tag("unclear", "stale") };
const SOURCE = { public: tag("Public", "fresh"), protected: tag("Protected", "accent"), owner: tag("Owner", "ink"), brief: tag("Brief"), listing: tag("Listing") };

export function renderCard(card, m, i) {
  const at = `data-msg="${esc(m.id)}" data-card="${i}"`;
  switch (card.type) {
    case "brief": return briefCard(card, at);
    case "offer": return offerCard(card, at);
    case "saved": return savedCard(card, at);
    case "sources": return sourcesCard(card);
    case "engagement": return engagementCard(live.engagements.get(card.id), card.id);
    default: return "";
  }
}

// MARK: - A request, shaped with Gemini

function briefCard(c, at) {
  const d = c.draft, s = d.shared, need = d.need;
  if (c.step === "matches") return matchesCard(c, at);
  if (c.step === "engaged") return `<div class="card"><div class="row">${label("Request sent", "sq ink")}${tag(s.title)}</div><p class="small muted">Your agent is talking to ${c.engaged.length} agent${c.engaged.length === 1 ? "" : "s"} over A2A. Their progress is below and under Requests.</p></div>`;
  const mode = { online: "Online", in_person: "In person", either: "Online or in person" }[need.mode] ?? null;
  return `<div class="card" ${at}>
    <div class="row">${label("Request · drafted with Gemini", "sq accent")}<span class="end">${tag(need.category.replace(/-/g, " "))}</span></div>
    <input class="field" data-edit="title" value="${esc(s.title)}" aria-label="Title">
    <textarea class="field" data-edit="summary" rows="2" aria-label="Summary">${esc(s.summary)}</textarea>
    <p class="small muted">${esc(need.place.name)}${need.place.name !== "Online" && need.mode !== "online" ? ` · within ${need.radiusKm} km` : ""}${mode ? ` · ${mode}` : ""}</p>
    ${s.requirements.length ? `<div class="stack" style="gap:6px">${label("Requirements")}
      <div class="row">${s.requirements.map((r, j) => `<span class="chip" style="cursor:default">${esc(r.label)}: ${esc(r.value)}
        <button class="btn quiet compact" data-act="brief-strength" data-j="${j}" ${at}>${r.strength === "required" ? "must" : "nice"}</button>
        <button class="btn quiet compact" data-act="brief-drop" data-j="${j}" ${at} aria-label="Remove">×</button></span>`).join("")}</div></div>` : ""}
    ${d.clarify?.length ? `<div class="card peri slim">${label("Gemini asks — tap an answer", "peri")}
      ${d.clarify.map((q, j) => `<div class="stack" style="gap:6px"><span class="small">${esc(q.question)}</span><div class="row">${q.options.map((o, k) => `<button class="chip" data-act="brief-clarify" data-j="${j}" data-k="${k}" ${at}>${esc(o)}</button>`).join("")}</div></div>`).join("")}</div>` : ""}
    ${s.questions.length ? `<div class="stack" style="gap:6px">${label("Your agent will ask")}<div class="row">${s.questions.map((q, j) => `<span class="chip" style="cursor:default">${esc(q)} <button class="btn quiet compact" data-act="brief-dropq" data-j="${j}" ${at} aria-label="Remove">×</button></span>`).join("")}</div></div>` : ""}
    <div class="stack" style="gap:6px">
      ${label("Most you'll pay · private, stays on this device", "peri")}
      <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-edit="limit" value="${d.mandate?.price.limit ?? ""}" placeholder="optional">
      <span class="small muted">${s.budget ? `Providers see only “${esc(s.budget)}”.` : "Providers see no budget."}</span></div>
      <label class="small muted"><input type="checkbox" data-edit="delegate" ${c.delegate ? "checked" : ""}> Let my always-on agent negotiate while I'm away (hands it this limit)</label>
    </div>
    <div class="row"><button class="btn accent" data-act="brief-send" ${at}>Find people</button><span class="small faint">Nothing is sent until you choose who.</span></div>
  </div>`;
}

function matchesCard(c, at) {
  const found = c.found ?? [];
  if (!found.length) return `<div class="card" ${at}>${label("No one yet", "sq")}<p class="small muted">No public offering fits “${esc(c.draft.shared.title)}” yet. Your request is kept; try a wider area or fewer requirements.</p></div>`;
  return `<div class="card" ${at}>
    <div class="row">${label(`${found.length} ${found.length === 1 ? "person" : "people"} whose public offering fits`, "sq ink")}${c.rankedByModel ? tag("✦ Ranked by Gemini", "accent") : ""}</div>
    ${found.map((f, j) => `<label class="card slim" style="cursor:pointer">
      <div class="row"><input type="checkbox" data-pick="${j}" ${c.picked?.includes(j) ? "checked" : ""} ${at}>
        <b>${esc(f.profile.name)}</b><span class="faint small">@${esc(f.profile.handle)}</span>${f.profile.demo ? tag("demo") : ""}
        <span class="end">${f.fact.offer ? `<b>${money(f.fact.offer.price.amount, f.fact.offer.price.period)}</b>` : ""}</span></div>
      <span class="small">${esc(f.fact.offer?.title ?? f.fact.text.slice(0, 120))}</span>
      ${f.why ? `<span class="small" style="color:var(--accent)">✦ ${esc(f.why)}</span>` : ""}
      <div class="row">${f.distanceKm ? tag(`${f.distanceKm} km`) : ""}${f.met.map(x => tag("✓ " + x, "fresh")).join("")}${f.unknown.map(x => tag("? " + x + " — will ask", "stale")).join("")}</div>
    </label>`).join("")}
    <div class="row"><button class="btn accent" data-act="brief-engage" ${at}>Ask their agents</button><span class="small faint">Over A2A. Your limit and private notes stay with you.</span></div>
  </div>`;
}

// MARK: - An offering

function offerCard(c, at) {
  if (c.step === "published") return `<div class="card"><div class="row">${label("Published", "sq fresh")}${tag("Public")}</div><p class="small">${esc(c.publicText)}</p><p class="small muted">Anyone's agent can find this now. Your agent answers from it and from what your rules share; your floor${c.floor ? ` (${money(c.floor)})` : ""} stays ${c.delegate ? "with your always-on agent" : "on this device"}.</p></div>`;
  const o = c.offer;
  return `<div class="card" ${at}>
    <div class="row">${label("Offering · read by Gemini", "sq accent")}${o ? `<span class="end"><b>${money(o.price.amount, o.price.period)}</b></span>` : ""}</div>
    ${o ? `<b>${esc(o.title)}</b><p class="small muted">${esc(o.place.name)} · ${esc(o.category.replace(/-/g, " "))}</p>
      ${Object.keys(o.attributes).length ? `<dl class="kv">${Object.entries(o.attributes).filter(([k]) => k !== "negotiable").map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}` : ""}
    ${label("What the directory shows (public)")}
    <textarea class="field" data-edit="publicText" rows="3">${esc(c.publicText ?? c.text)}</textarea>
    ${o ? `${label("Lowest you'll accept · private, stays on this device", "peri")}
      <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-edit="floor" value="${c.floor ?? o.price.amount}"></div>
      <label class="small muted"><input type="checkbox" data-edit="delegate" ${c.delegate ? "checked" : ""}> Let my always-on agent negotiate while I'm away (hands it this floor)</label>` : ""}
    <div class="row"><button class="btn accent" data-act="offer-publish" ${at}>Publish</button><span class="small faint">Public: discoverable by anyone's agent.</span></div>
  </div>`;
}

// MARK: - Context

function savedCard(c, at) {
  const f = c.fact;
  if (!f) return "";
  return `<div class="card slim" ${at}>
    <div class="row">${tierTag(f.tier, f.topics)}<span class="small">${esc(f.text)}</span></div>
    <div class="row">${label("Who sees it")}
      ${["private", "protected", "public"].map(t => `<button class="chip ${f.tier === t ? "on" : ""}" data-act="tier" data-tier="${t}" ${at}>${{ private: "Only me (on device)", protected: "People my rules name", public: "Anyone (discoverable)" }[t]}</button>`).join("")}</div>
    ${c.suggestPublic && f.tier === "private" ? `<p class="small" style="color:var(--accent)">This sounds like something you offer — make it Public so others' agents can find you.</p>` : ""}
  </div>`;
}

function sourcesCard(c) {
  return `<div class="card slim">${label(c.on === "device" ? "From your notes · answered on this device (Gemini Nano)" : "From your notes · Gemini, nothing stored", "peri")}
    ${c.notes.map(n => `<div class="row">${tierTag(n.tier)}<span class="small">${esc(n.text)}</span></div>`).join("")}</div>`;
}

// MARK: - A conversation between agents (live)

function offersChart(e) {
  const r = e.negotiation.requester, p = e.negotiation.provider;
  const all = [...r, ...p].map(x => x.price);
  if (all.length < 2) return "";
  const lo = Math.min(...all), hi = Math.max(...all), n = Math.max(r.length, p.length);
  const x = i => 40 + (i / Math.max(1, n - 1)) * 500, y = v => (hi === lo ? 55 : 95 - ((v - lo) / (hi - lo)) * 80);
  const line = (ps, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${ps.map((q, i) => `${x(i)},${y(q.price)}`).join(" ")}"/>${ps.map((q, i) => `<rect x="${x(i) - 3}" y="${y(q.price) - 3}" width="6" height="6" fill="${color}"/>`).join("")}`;
  const deal = e.negotiation.deal ? `<line x1="30" x2="560" y1="${y(e.negotiation.deal.price)}" y2="${y(e.negotiation.deal.price)}" stroke="var(--fresh)" stroke-dasharray="3 3"/>` : "";
  return `<div class="chart">${label("Offers by round · requester vs provider")}<svg viewBox="0 0 580 110" role="img" aria-label="Offers converging">${deal}${line(p, "var(--stale)")}${line(r, "var(--accent)")}
    <text x="0" y="${y(hi) + 4}">${esc(money(hi))}</text><text x="0" y="${y(lo) + 4}">${esc(money(lo))}</text></svg></div>`;
}

export function engagementCard(e, id) {
  if (!e) return `<div class="card slim"><span class="thinking"><span class="spinner"></span>${label("Connecting to their agent")}</span></div>`;
  const mine = e.requester.uid === session.uid ? "requester" : "provider";
  const them = mine === "requester" ? e.provider : e.requester;
  const [ph, tone] = PHASE[e.phase] ?? [e.phase, ""];
  const items = live.inbox.filter(i => i.engagementId === e.id);
  const waitingOther = e.waiting?.[mine === "requester" ? "provider" : "requester"];
  const talking = !!e.outbox || (["asking", "negotiating"].includes(e.phase) && !e.waiting?.requester && !e.waiting?.provider && !items.length);
  return `<div class="card ${items.some(i => i.owner === session.uid || i.owner.startsWith("demo-")) ? "needs-card" : ""}" data-engagement="${esc(e.id)}">
    <div class="row">${label(mine === "requester" ? "You asked" : "Asked you", "sq ink")}<b>${esc(them.name)}</b><span class="small faint">@${esc(them.handle)}</span><span class="end">${tag(ph, tone)}</span></div>
    <div class="row small"><span>${esc(e.title)}</span>${e.offer.price ? `<span class="end faint">listed ${money(e.offer.price, e.offer.unit)}</span>` : ""}</div>
    ${e.qa.length ? `<div class="qa">${e.qa.map(q => `<div><span class="faint">${STATUS_ICON[q.status] ?? "○"}</span>
      <span><span class="faint small">${q.from === mine ? "You" : "They"} asked:</span> ${esc(q.question)}${q.answer ? `<br><span class="muted">→ ${esc(q.answer)}</span>` : q.status === "pending" ? `<br><span class="faint small">waiting for ${q.from === mine ? esc(them.name) : "you"}…</span>` : ""}</span>
      <span class="row" style="gap:4px">${q.source ? SOURCE[q.source] ?? "" : ""}${q.verdict ? VERDICT[q.verdict] : ""}</span></div>`).join("")}</div>` : ""}
    ${offersChart(e)}
    <details ${e.events.length <= 6 ? "open" : ""}><summary class="label" style="cursor:pointer">A2A conversation · ${e.events.length} events</summary>
      <div class="timeline" style="margin-top:8px">${e.events.map(ev => `<div class="ev ${ev.who}">${ev.who === "system" ? `<span>${esc(ev.text)}</span>` : `<span class="who">${esc(whoLabel(ev.who, mine, them.name))}</span><span>${esc(ev.text)} ${byTag(ev.by)}</span>`}</div>`).join("")}</div></details>
    ${talking ? `<span class="thinking small"><span class="spinner"></span><span class="faint">agents are talking…</span></span>` : ""}
    ${items.map(inboxBlock).join("")}
    ${!items.length && waitingOther ? `<p class="small faint">Waiting for ${esc(them.name)}${waitingOther.kind === "confirm" ? " to confirm" : ""}…</p>` : ""}
    ${e.phase === "agreed" && e.negotiation.deal ? `<div class="card slim" style="border-color:var(--fresh)">${label("Deal agreed", "fresh")}<b>${money(e.negotiation.deal.price, e.offer.unit)}</b><span class="small muted">Both owners confirmed. Arrange the details directly — nothing private was shared by the agents.</span></div>` : ""}
    ${["asking", "negotiating", "deal"].includes(e.phase) ? `<div class="row"><button class="btn quiet compact end" data-act="eng-close" data-id="${esc(e.id)}">End conversation</button></div>` : ""}
  </div>`;
}

function whoLabel(who, mine, themName) {
  const sideOf = who.startsWith("requester") ? "requester" : "provider";
  const agent = who.endsWith("_agent");
  if (sideOf === mine) return agent ? "Your agent" : "You";
  return agent ? `${themName.split(" ")[0]}'s agent` : themName.split(" ")[0];
}

/** What the owner's device is asked, inline in the conversation. */
function inboxBlock(i) {
  const demo = i.owner !== session.uid;
  const as = demo ? `<span class="small faint">Their phone is simulated in the demo — you're answering as them.</span>` : "";
  const box = (title, body) => `<div class="card slim accent" data-item="${esc(i.id)}">${label(title, "accent")}${as}${body}</div>`;
  if (i.kind === "answer") {
    const d = drafts.get(i.id);
    return box(demo ? "Their agent needs them" : "Your agent needs you", `<span class="small">${i.side === "provider" ? "The requester's agent asks" : "Their agent asks"}: <b>${esc(i.question)}</b></span>
      ${d ? `<div class="card peri slim">${label(`Found in your private notes · ${d.on === "device" ? "on this device" : "Gemini, not stored"}`, "peri")}<span class="small">“${esc(d.text)}”</span>
        <div class="row"><button class="btn accent compact" data-act="inbox-share" data-id="${esc(i.id)}">Share this</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div></div>` : ""}
      <textarea class="field" rows="2" data-reply="${esc(i.id)}" placeholder="${d ? "Or write your own answer" : "Your answer"}"></textarea>
      <div class="row"><button class="btn compact" data-act="inbox-answer" data-id="${esc(i.id)}">Send</button><button class="btn quiet compact" data-act="inbox-decline" data-id="${esc(i.id)}">I'd rather not say</button></div>`);
  }
  if (i.kind === "approve") return box("Check before sharing", `<span class="small">Asked: <b>${esc(i.question)}</b></span>
    <div class="card slim">${label("Drafted from a Protected fact your rule covers")}<span class="small">“${esc(i.draft)}”</span></div>
    <div class="row"><button class="btn accent compact" data-act="inbox-approve" data-id="${esc(i.id)}">Share</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div>`);
  if (i.kind === "move" && !i.question && !demo && !needsLimit.has(i.id)) return `<span class="thinking small"><span class="spinner"></span><span class="faint">Your agent is making a move with your private limit (on this device)…</span></span>`;
  if (i.kind === "move") return box(i.question ? "No deal inside your limit yet" : "Your agent needs your limit", `${i.question ? `<span class="small">${esc(i.question)}</span>` : `<span class="small">Set the most you'll pay (or least you'll take). It stays on this device; your agent uses it for each move.</span>`}
    <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-limit="${esc(i.id)}" placeholder="${i.listPrice ? money(i.listPrice) : "amount"}">
    <button class="btn accent compact" data-act="inbox-move" data-id="${esc(i.id)}">Keep negotiating</button><button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div>`);
  if (i.kind === "confirm") {
    const e = live.engagements.get(i.engagementId);
    const deal = e?.negotiation.deal;
    return box("Confirm the deal?", `<span class="small">${deal ? `<b>${money(deal.price, e.offer.unit)}</b> for “${esc(e.title)}”.` : ""} Nothing is final until both of you confirm.</span>
      <div class="row"><button class="btn accent compact" data-act="inbox-confirm" data-id="${esc(i.id)}">Confirm</button><button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div>`);
  }
  return "";
}

export function messageHTML(m) {
  if (m.role === "user") return `<div class="msg-user"><div class="bubble">${esc(m.text)}</div>${label(time(m.at))}</div>`;
  return `<div class="msg-agent"><div class="row">${label("Collab", "sq ink")}${label("· " + (m.engine ?? "Gemini"))}${label("· " + time(m.at))}</div>
    ${m.pending ? `<span class="thinking"><span class="spinner"></span>${label(m.pending)}</span>` : m.text ? `<div class="text">${esc(m.text)}</div>` : ""}
    ${(m.cards ?? []).map((c, i) => renderCard(c, m, i)).join("")}</div>`;
}
