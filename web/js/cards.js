// The dynamic cards in chat (Collab's ComponentViews): each card is data in a chat message, rendered from that data
// plus live state, with buttons that act through `act`. A request is shaped with Gemini (its questions come with
// tap-to-answer options), sent, matched, and each conversation between agents is a live card that shows progress
// and asks the owner exactly when it needs them.
import { session } from "./api.js";
import { drafts, needsLimit } from "./agent.js";
import { live } from "./live.js";
import { byTag, esc, label, money, shortName, tag, tierTag, time } from "./ui.js";

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
    case "suggest": return `<div class="row">${card.options.map(o => `<button class="chip" data-act="send-text" data-text="${esc(o.text)}">↗ ${esc(o.label)}</button>`).join("")}<span class="small faint">Saved to your private context.</span></div>`;
    case "engagement": return engagementCard(live.engagements.get(card.id), card.id);
    case "store": return storeCard(card);
    default: return "";
  }
}

// MARK: - A person's or shop's agent, opened from a QR code

/**
 * Someone's card, opened from their QR code or a link: what they offer, with what can be done right there — pick how
 * many and buy (stock shown), pick a free time and book, ask to visit, or make an offer — and questions to ask. A person
 * with nothing on offer gets questions about them. `preview`: the owner looking at their own card (nothing is sent).
 */
export function storeCard(c, { preview = false } = {}) {
  const p = c.profile, first = esc(shortName(p.name));
  const items = c.shop ?? fallbackItems(c);
  const off = preview ? "disabled" : "";
  const head = `<div class="row eng-head"><span class="avatar" aria-hidden="true">${esc(p.name.slice(0, 1).toUpperCase())}</span><div class="eng-who"><b>${esc(p.name)}</b><span class="small faint">@${esc(p.handle)}${p.bio ? ` · ${esc(p.bio)}` : ""}</span></div>
      ${preview ? tag("Your card · preview", "accent") : `<button class="btn secondary compact end" data-act="add-contact-direct" data-handle="${esc(p.handle)}">Add to people</button>`}</div>`;
  if (c.paused) return `<div class="card">${head}<span class="small">${esc(p.name)} isn't taking requests right now.</span></div>`;
  if (!items.length) {
    const qs = c.suggestions?.length ? c.suggestions.map(x => x.text) : ["What are you looking for right now?", "Are you free this weekend?"];
    return `<div class="card">${head}
      <span class="small faint">${first} hasn't listed anything for sale. Their agent answers from what they share and passes anything else to them.</span>
      <div class="row">${qs.map(q => `<button class="chip" data-act="send-text" data-text="${esc(q)}" ${off}>${esc(q)}</button>`).join("")}</div></div>`;
  }
  const shown = items.slice(0, 3), more = items.slice(3);
  return `<div class="card">${head}
    ${preview ? `<span class="small muted">This is what customers see when they scan your QR. Buttons are off in the preview.</span>` : ""}
    ${shown.map(it => shopItem(it, p, off)).join("")}
    ${more.length ? `<details class="more"><summary>${more.length} more on offer</summary>${more.map(it => shopItem(it, p, off)).join("")}</details>` : ""}
    <span class="small faint">Or type any question below — ${esc(p.name)}'s agent answers from what they share and asks them the rest. No queue.</span>
  </div>`;
}

const slotText = (s, tz) => new Date(s.start * 1000).toLocaleString([], { timeZone: tz || undefined, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });

function shopItem(it, p, off) {
  const price = it.price != null ? money(it.price, it.unit === "each" ? null : it.unit, it.currency) : "Price on request";
  const stock = !it.stock ? "" : it.stock.state === "out" ? tag("Out of stock", "danger") : it.stock.state === "low" ? tag(`Only ${it.stock.available} left`, "stale")
    : it.stock.state === "in" ? tag(`${it.stock.available} in stock`, "fresh") : tag("Stock not confirmed", "");
  const data = `data-shop-item data-handle="${esc(p.handle)}" data-fact="${esc(it.factId)}" data-price="${it.price ?? ""}" data-currency="${esc(it.currency)}" data-unit="${esc(it.unit ?? "")}" data-max="${it.maxQuantity}" data-name="${esc(it.name)}"`;
  const offer = it.price != null ? `<button class="btn secondary compact" data-act="store-offer-open" ${off}>Make an offer</button>` : "";
  let act = "";
  if (it.action === "buy") {
    const out = it.stock?.state === "out";
    act = out
      ? `<div class="row"><button class="btn compact" disabled>Out of stock</button><button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`When will ${it.name} be back in stock?`)}" ${off}>Ask when it's back</button></div>`
      : `<div class="row">${it.maxQuantity <= 1 ? "" : `<div class="stepper" role="group" aria-label="How many"><button class="btn quiet compact" data-act="qty" data-d="-1" aria-label="One fewer" ${off}>−</button><input class="qty" type="number" inputmode="numeric" min="1" max="${it.maxQuantity}" value="1" aria-label="How many" ${off}><button class="btn quiet compact" data-act="qty" data-d="1" aria-label="One more" ${off}>+</button></div>`}
          <button class="btn accent compact" data-act="store-order" data-kind="buy" ${off}>Buy for ${money(it.price, null, it.currency)}</button>${offer}</div>`;
  } else if (it.action === "book") {
    act = it.slots?.length
      ? `<span class="small muted">Pick a time:</span><div class="row slots">${it.slots.map(s => `<button class="chip" data-act="slot-pick" data-slot="${esc(s.id)}" data-label="${esc(slotText(s, it.timezone))}" ${off}>${esc(slotText(s, it.timezone))}</button>`).join("")}</div>
         <div class="row"><button class="btn accent compact" data-act="store-order" data-kind="book" disabled>Pick a time to book</button>${offer}</div>`
      : it.slots ? `<div class="row"><span class="small muted">No free times in the next two weeks.</span><button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`When are you next free for ${it.name}?`)}" ${off}>Ask when they're free</button></div>`
      : `<div class="row"><button class="btn accent compact" data-act="store-order" data-kind="book" ${off}>Request a booking · ${price}</button>${offer}</div>`;
  } else if (it.action === "visit") {
    act = `<div class="row"><button class="btn accent compact" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`I'm interested in ${it.name}. Can I visit this weekend?`)}" ${off}>I'm interested — ask to visit</button>${offer}</div>`;
  } else {
    act = `<div class="row"><button class="btn accent compact" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`How much is ${it.name}?`)}" ${off}>Ask for a price</button></div>`;
  }
  return `<div class="shop-item" ${data}>
    <div class="row"><b>${esc(it.title.split(" · ")[0])}</b><b class="end">${price}</b></div>
    ${it.details && it.details !== it.title ? `<span class="small muted">${esc(it.details)}</span>` : ""}
    ${stock ? `<div class="row">${stock}</div>` : ""}
    ${act}
    <div class="offer-box" hidden><div class="row"><input class="field compact" type="number" inputmode="numeric" min="1" placeholder="Your price${it.action === "buy" ? " each" : ""} (${esc(it.currency)})" data-offer-price><button class="btn accent compact" data-act="store-offer-send" ${off}>Send offer</button></div>
      <span class="small faint">${esc(shortName(p.name))} confirms or says no. Nothing is final until both of you do.</span></div>
    <div class="row qs">${(it.questions ?? []).map(q => `<button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(q.text)}" ${off}>${esc(q.text)}</button>`).join("")}</div>
  </div>`;
}

/** A card saved before cards carried the storefront: its offerings, with plain questions that name the item. */
function fallbackItems(c) {
  return (c.facts ?? []).filter(f => f.offer).map(f => {
    const name = f.offer.title.split(" · ")[0];
    return { factId: f.id, title: f.offer.title, name, details: "", category: f.offer.category, price: f.offer.price?.amount ?? null, currency: f.offer.price?.currency ?? "INR",
      unit: f.offer.price?.period ?? null, action: f.offer.price?.amount != null ? "buy" : "ask", stock: null, maxQuantity: 20, slots: null, timezone: null,
      questions: [{ text: `Do you have ${name}?` }, { text: `What's your best price for ${name}?` }] };
  });
}

// MARK: - A request, shaped with Gemini

function briefCard(c, at) {
  const d = c.draft, s = d.shared, need = d.need;
  if (c.step === "matches") return matchesCard(c, at);
  if (c.step === "engaged") return `<div class="card"><div class="row">${label("Request sent", "sq ink")}${tag(s.title)}</div><p class="small muted">Your agent is talking to ${c.engaged.length} agent${c.engaged.length === 1 ? "" : "s"} over A2A. Their progress is below and under Requests.</p></div>`;
  const mode = { online: "Online", in_person: "In person", either: "Online or in person" }[need.mode] ?? null;
  const where = [need.place.name, need.place.name !== "Online" && need.mode !== "online" ? `within ${need.radiusKm} km` : null, mode].filter(Boolean).join(" · ");
  // What needs the owner now (Gemini's questions, the requirements, the limit) is in view; the rest is under More options.
  return `<div class="card brief" ${at}>
    <div class="row">${label("Request", "sq accent")}<span class="end">${tag(need.category.replace(/-/g, " "))}</span></div>
    <input class="field bare title-edit" data-edit="title" value="${esc(s.title)}" aria-label="Title">
    <textarea class="field bare" data-edit="summary" rows="2" aria-label="Summary">${esc(s.summary)}</textarea>
    <p class="small faint">📍 ${esc(where)}</p>
    ${d.clarify?.length ? `<div class="card peri slim">${label("Gemini asks · tap to answer", "peri")}
      ${d.clarify.map((q, j) => `<div class="stack" style="gap:6px"><span class="small">${esc(q.question)}</span><div class="row">${q.options.map((o, k) => `<button class="chip" data-act="brief-clarify" data-j="${j}" data-k="${k}" ${at}>${esc(o)}</button>`).join("")}</div></div>`).join("")}</div>` : ""}
    ${s.requirements.length ? `<div class="row">${s.requirements.map((r, j) => `<span class="chip req ${r.strength === "required" ? "on" : ""}"><button class="linkish" data-act="brief-strength" data-j="${j}" ${at} title="Tap to switch must-have / nice-to-have">${esc(r.value)} · ${r.strength === "required" ? "must" : "nice"}</button><button class="linkish x" data-act="brief-drop" data-j="${j}" ${at} aria-label="Remove ${esc(r.label)}">×</button></span>`).join("")}</div>` : ""}
    <div class="row"><span class="small">Most you'll pay</span><input class="field" style="max-width:150px" type="number" min="1" data-edit="limit" value="${d.mandate?.price.limit ?? ""}" placeholder="optional">
      <span class="small faint">${s.budget ? `private · they see “${esc(s.budget)}”` : "private · never shown"}</span></div>
    <details class="more"><summary>More options${s.questions.length ? ` · your agent will ask ${s.questions.length}` : ""}${c.insights?.length ? " · past deals" : ""}</summary>
      ${s.questions.length ? `<div class="stack" style="gap:6px">${label("Your agent will ask")}<div class="row">${s.questions.map((q, j) => `<span class="chip">${esc(q)} <button class="linkish x" data-act="brief-dropq" data-j="${j}" ${at} aria-label="Remove">×</button></span>`).join("")}</div></div>` : ""}
      <div class="stack" style="gap:6px">${label("While you're away")}${autonomyPick(c)}</div>
      ${c.insights?.length ? `<div class="stack" style="gap:4px">${label("What similar deals closed at", "peri")}${c.insights.map(l => `<div class="small">${esc(l)}</div>`).join("")}</div>` : ""}
    </details>
    <div><button class="btn secondary compact" data-act="price-check" data-item="${esc(s.title)}" data-area="${esc(need.place.name)}" data-unit="${esc(need.unit ?? "")}">Check fair price</button><span class="small faint"> Prices from the web for this item · only you see them</span><div data-price-result></div></div>
    <div class="row"><button class="btn accent" data-act="brief-send" ${at}>Find people</button><span class="small faint">Nothing is sent until you choose who.</span></div>
  </div>`;
}

const autonomyPick = (c) => `<select class="field" data-edit="autonomy">
    <option value="" ${!c.autonomy ? "selected" : ""}>Ask me for every move</option>
    <option value="negotiate" ${c.autonomy === "negotiate" ? "selected" : ""}>My always-on agent negotiates inside my limit; I confirm the deal</option>
    <option value="close" ${c.autonomy === "close" ? "selected" : ""}>My always-on agent negotiates and closes inside my limit</option></select>
  ${c.autonomy ? `<select class="field" data-edit="days" style="max-width:110px">${[1, 7, 30].map(n => `<option value="${n}" ${(c.days ?? 7) === n ? "selected" : ""}>${n} days</option>`).join("")}</select>` : ""}`;

function matchesCard(c, at) {
  const found = c.found ?? [];
  const real = found.filter(f => !f.over).length;
  const watch = c.watching ? `<span class="small" style="color:var(--fresh)">● Your agent is watching — checks every hour for 14 days and tells you when someone new fits.</span>`
    : `<button class="btn secondary compact" data-act="watch" ${at}>Keep watching</button>`;
  if (!found.length) return `<div class="card" ${at}>${label("No one yet", "sq")}<p class="small muted">No public offering fits “${esc(c.draft.shared.title)}” yet. Try a wider area or fewer requirements — or let your agent keep looking.</p><div class="row">${watch}
      <button class="btn secondary compact" data-act="nearby" data-item="${esc(c.draft.shared.title)}" data-area="${esc(c.draft.shared.area ?? "")}">Look on Google Maps nearby</button></div><div data-nearby></div></div>`;
  return `<div class="card" ${at}>
    <div class="row">${label(real ? `${real} ${real === 1 ? "match" : "matches"}` : "No exact match", "sq ink")}${c.rankedByModel && real ? `<span class="small faint">ranked by Gemini</span>` : ""}${found.length > real ? `<span class="small faint">· ${found.length - real} above your budget</span>` : ""}</div>
    ${found.map((f, j) => `<label class="match-row">
      <input type="checkbox" data-pick="${j}" ${c.picked?.includes(j) ? "checked" : ""} ${at}>
      <span class="avatar" aria-hidden="true">${esc(f.profile.name.slice(0, 1).toUpperCase())}</span>
      <span class="match-main"><span class="row"><b>${esc(f.profile.name)}</b>${f.profile.demo ? tag("demo") : ""}${f.profile.stats?.kept ? tag(`${f.profile.stats.kept} deal${f.profile.stats.kept === 1 ? "" : "s"} done`, "fresh") : ""}
          <span class="end">${f.fact.offer ? `<b>${money(f.fact.offer.price.amount, f.fact.offer.price.period)}</b>` : ""}</span></span>
        <span class="small muted">${esc(f.why ?? f.fact.offer?.title ?? f.fact.text.slice(0, 120))}</span>
        ${f.over ? `<span class="small" style="color:var(--stale)">Above your budget — ticking it lets your agent try to bring the price down.</span>` : ""}
        <span class="small faint">${[f.distanceKm ? `${f.distanceKm} km` : null, ...f.met.slice(0, 2).map(x => `✓ ${x}`), f.unknown.length ? `${f.unknown.length} to ask` : null].filter(Boolean).map(esc).join(" · ")}</span></span>
    </label>`).join("")}
    <div class="row"><button class="btn accent" data-act="brief-engage" ${at}>Ask their agents</button>${watch}<span class="small faint">Your limit and private notes are never shared.</span></div>
  </div>`;
}

// MARK: - An offering

function offerCard(c, at) {
  if (c.step === "published") return `<div class="card"><div class="row">${label("Published", "sq fresh")}${tag("Public")}</div><p class="small">${esc(c.publicText)}</p><p class="small muted">Anyone's agent can find this now. Your agent answers from it and from what your rules share; your floor${c.floor ? ` (${money(c.floor)})` : ""} is never revealed — ${c.autonomy === "close" ? `your always-on agent negotiates and closes inside it (${c.days ?? 7} days)` : c.autonomy ? "your always-on agent negotiates inside it; you confirm" : "your agent asks you for each move"}.</p></div>`;
  const o = c.offer;
  return `<div class="card" ${at}>
    <div class="row">${label("Offering · read by Gemini", "sq accent")}${o ? `<span class="end"><b>${money(o.price.amount, o.price.period)}</b></span>` : ""}</div>
    ${o ? `<b>${esc(o.title)}</b><p class="small muted">${esc(o.place.name)} · ${esc(o.category.replace(/-/g, " "))}</p>
      ${Object.keys(o.attributes).length ? `<dl class="kv">${Object.entries(o.attributes).filter(([k]) => k !== "negotiable").map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}` : ""}
    ${label("What the directory shows (public)")}
    <textarea class="field" data-edit="publicText" rows="3">${esc(c.publicText ?? c.text)}</textarea>
    ${o ? `${label("Lowest you'll accept · private, never shown to anyone", "peri")}
      <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-edit="floor" value="${c.floor ?? o.price.amount}"></div>
      ${autonomyPick(c)}
      ${c.insights?.length ? `<div class="card peri slim">${label("What similar listings agreed at", "peri")}${c.insights.map(l => `<div class="small">${esc(l)}</div>`).join("")}</div>` : ""}` : ""}
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
      ${["private", "protected", "public"].map(t => `<button class="chip ${f.tier === t ? "on" : ""}" data-act="tier" data-tier="${t}" ${at}>${{ private: "Only me", protected: "People my rules name", public: "Anyone (discoverable)" }[t]}</button>`).join("")}</div>
    ${c.suggestPublic && f.tier === "private" ? `<p class="small" style="color:var(--accent)">This sounds like something you offer — make it Public so others' agents can find you.</p>` : ""}
  </div>`;
}

function sourcesCard(c) {
  return `<div class="card slim">${label(c.on === "device" ? "From your notes · answered on this device (Gemini Nano)" : "From your notes · Gemini", "peri")}
    ${c.notes.map(n => `<div class="row">${tierTag(n.tier)}<span class="small">${esc(n.text)}</span></div>`).join("")}</div>`;
}

// MARK: - A conversation between agents (live)

/** Offers in the order they were made (the provider opens, then turns alternate), on one shared axis. */
function offersChart(e) {
  const pts = [...e.negotiation.provider.map(q => ({ q, side: "provider", t: q.round * 2 })), ...e.negotiation.requester.map(q => ({ q, side: "requester", t: q.round * 2 + 1 }))].sort((a, b) => a.t - b.t);
  if (pts.length < 2) return "";
  const prices = pts.map(p => p.q.price), lo = Math.min(...prices), hi = Math.max(...prices), last = pts.length - 1;
  const x = i => 70 + (i / Math.max(1, last)) * 470, y = v => (hi === lo ? 55 : 95 - ((v - lo) / (hi - lo)) * 80);
  const line = (side, color) => {
    const own = pts.map((p, i) => ({ ...p, i })).filter(p => p.side === side);
    return `<polyline fill="none" stroke="${color}" stroke-width="2" points="${own.map(p => `${x(p.i)},${y(p.q.price)}`).join(" ")}"/>${own.map(p => `<rect x="${x(p.i) - 3}" y="${y(p.q.price) - 3}" width="6" height="6" fill="${color}"/>`).join("")}`;
  };
  const deal = e.negotiation.deal ? `<line x1="60" x2="560" y1="${y(e.negotiation.deal.price)}" y2="${y(e.negotiation.deal.price)}" stroke="var(--fresh)" stroke-dasharray="3 3"/>` : "";
  return `<div class="chart"><svg viewBox="0 0 580 110" role="img" aria-label="Offers by turn">${deal}${line("provider", "var(--stale)")}${line("requester", "var(--accent)")}
    <text x="0" y="${y(hi) + 4}">${esc(money(hi, null, e.offer.currency))}</text><text x="0" y="${y(lo) + 4}">${esc(money(lo, null, e.offer.currency))}</text></svg>
    <span class="small faint"><span style="color:var(--accent)">■</span> requester · <span style="color:var(--stale)">■</span> provider · dashed: deal</span></div>`;
}

// The conversation card follows the usual guidance for agent UI: the default view answers "where is this, and do you
// need to do anything?" (who, a 5-step progress bar, one plain status line, at most one action); the evidence — every
// question and answer, the offers chart, the A2A log, the receipt — is one tap away under Details.
const STEPS = ["Asked", "Questions", "Offers", "Deal", "Confirmed"];

function stepOf(e) {
  if (e.phase === "agreed") return 4;
  if (e.phase === "deal") return 3;
  if (e.negotiation.requester.length || e.negotiation.provider.length) return 2;
  if (e.qa.some(q => q.answer) || e.qa.length) return 1;
  return 0;
}

function stepper(e) {
  const at = stepOf(e), ended = ["closed", "declined"].includes(e.phase);
  return `<ol class="steps ${ended ? "ended" : ""}" aria-label="Progress: ${STEPS[at]}">${STEPS.map((s, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}"><span>${s}</span></li>`).join("")}</ol>`;
}

/** A resting conversation: who spoke last, and that either person can carry on. */
function openLine(e, mine, them) {
  const first = esc(shortName(them.name));
  const last = e.qa.filter(q => q.answer).at(-1);
  if (!last) return `Open — send ${first}'s agent a message below.`;
  return last.from === mine ? `${first} answered. Ask something else, or tap Done.` : `You answered ${first}. Send something back, or tap Done.`;
}

/** One sentence: what's happening now, from this owner's side. */
function statusLine(e, mine, them, items, talking) {
  const first = shortName(them.name);
  const mineOffers = mine === "requester" ? e.negotiation.requester : e.negotiation.provider;
  const theirOffers = mine === "requester" ? e.negotiation.provider : e.negotiation.requester;
  if (e.phase === "agreed") return `Deal agreed at <b>${dealAmount(e)}</b>.`;
  if (e.phase === "closed" || e.phase === "declined") return esc(e.events.filter(x => x.who !== "system").at(-1)?.text ?? "This conversation ended.");
  if (items.length) return "Your agent needs you — see below.";
  if (e.phase === "deal") return `Deal at <b>${dealAmount(e)}</b> — waiting for ${esc(first)} to confirm.`;
  if (theirOffers.length || mineOffers.length) {
    const t = theirOffers.at(-1), m = mineOffers.at(-1);
    return `${talking ? "Negotiating · " : ""}${m ? `you ${money(m.price, e.offer.unit, e.offer.currency)}` : ""}${m && t ? " · " : ""}${t ? `${esc(first)} ${money(t.price, e.offer.unit, e.offer.currency)}` : ""}`;
  }
  const answered = e.qa.filter(q => q.answer).length;
  if (talking) return e.qa.length ? `Asking questions · ${answered} of ${e.qa.length} answered` : `Talking to ${esc(first)}'s agent…`;
  return e.qa.length ? `${answered} of ${e.qa.length} questions answered · waiting for ${esc(first)}` : `Waiting for ${esc(first)}…`;
}

/** The answer that matters most, shown without opening Details: the latest one to your own question. */
function keyAnswer(e, mine) {
  if (["closed", "declined"].includes(e.phase)) return "";
  const q = e.qa.filter(x => x.from === mine && x.answer && x.status === "answered").at(-1);
  return q ? `<p class="small muted keyline">“${esc(q.answer)}”</p>` : "";
}

/** What to price: the listing's own name when it's specific, plus what was asked for (a generic category title like
 *  "Water Bottles · items for sale" alone finds nothing comparable). */
/**
 * What to price on the web: the item the buyer named ("a 500 ml steel bottle") with the listing's own title. A question
 * ("What's your best rate for guitar lessons?") or Hinglish filler isn't an item, so only the listing is searched.
 */
export function priceItem(e) {
  const listed = (e.offer?.title ?? "").split(" · ")[0].trim();
  let asked = (e.brief?.title ?? "").trim().replace(/[.!?]+$/, "")
    .replace(/^(hi|hello|hey|bhaiya|bhai|sir|madam|ji)[,!\s]+/i, "")
    .replace(/^(what('?s| is) (your |the )?(best |lowest |last |final )?(price|rate|cost)( for| of)?|how much (is|are|for|does|do)( the| a| an)?|do you (have|sell|make)|have you got|is (the|there|it)|are (the|there)|can i (get|order|buy|book)|i('d| would)? (want|need|like)( to buy)?|i'?m looking for|looking for|need|what times are free( this week)? for|are you free( this week)? for)\s+/i, "")
    .replace(/\s+(in stock|available|still available|today|tomorrow|this week|now|please)\??$/i, "")
    .replace(/^(a|an|the|some)\s+/i, "").trim();
  if (asked.length < 3 || asked.includes("?") || asked.split(/\s+/).length > 8 || asked.toLowerCase() === listed.toLowerCase()
    || /\b(kitne|kitna|chahiye|doge|milega|hai|kya|bhaiya)\b/i.test(asked)) asked = "";
  return [asked, listed].filter(Boolean).join(" — ").slice(0, 160) || e.title;
}

/** "₹800 for 2 (₹400 each)" for a deal on several; the price and its unit for one. */
export function dealAmount(e) {
  const d = e.negotiation.deal, n = d?.terms?.quantity > 1 ? d.terms.quantity : 1;
  if (!d) return "";
  if (n === 1 && !d.items?.length) return money(d.price, e.offer.unit, e.offer.currency);
  const total = d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : d.price * n;
  return `${money(total, null, e.offer.currency)} for ${n} (${money(Math.round((total / n) * 100) / 100, null, e.offer.currency)} each)`;
}

/** The pass a paid deal gets, by what changes hands (the server decides the same way: core/pickup.ts passKind). */
const BOOKING = new Set(["lessons", "services", "tasks", "pets", "stays", "rides", "events", "freight", "equipment-rental"]);
const HANDOVER = new Set(["property-rent", "commercial-lease", "property-sale", "vehicles", "jobs"]);
export const passKind = e => (e.reservation?.slotId || BOOKING.has(e.offer?.category) ? "booking" : HANDOVER.has(e.offer?.category) ? "handover" : "pickup");
export const PASS = {
  pickup: { name: "Pickup pass", sellerHint: "Scan their pickup pass when they collect", buyerHint: them => `Show your pickup pass to ${them} when you collect.`, done: "Collected" },
  booking: { name: "Booking pass", sellerHint: "Scan their booking pass when they arrive", buyerHint: them => `Show your booking pass to ${them} when you arrive.`, done: "Checked in" },
  handover: { name: "Handover pass", sellerHint: "Scan their handover pass when you hand over", buyerHint: them => `Show your handover pass to ${them} at the handover.`, done: "Handed over" },
};

/** "3 of 5 left today", from the server's policy (the numbers it enforces). */
function quotaText(name) {
  const q = session.policy?.quotas?.[name];
  return q?.limit ? `${q.remaining} of ${q.limit} left today` : "private";
}

export function engagementCard(e, id) {
  if (!e) return `<div class="card slim"><span class="thinking"><span class="spinner"></span><span class="small faint">Connecting to their agent…</span></span></div>`;
  const mine = e.requester.uid === session.uid ? "requester" : "provider";
  const them = mine === "requester" ? e.provider : e.requester;
  const [ph, tone] = PHASE[e.phase] ?? [e.phase, ""];
  const items = live.inbox.filter(i => i.engagementId === e.id && !(i.kind === "move" && !i.question && i.owner === session.uid && !needsLimit.has(i.id)));
  const autoMove = live.inbox.some(i => i.engagementId === e.id && i.kind === "move" && !i.question && i.owner === session.uid && !needsLimit.has(i.id));
  // A conversation with nothing to negotiate (no price) rests once every question is answered: it's open for a
  // follow-up from either person, not "still talking".
  const unanswered = e.qa.some(q => q.status === "open" || q.status === "pending");
  const open = ["asking", "negotiating"].includes(e.phase) && e.offer.price == null && !e.outbox && !e.waiting?.requester && !e.waiting?.provider && !items.length && !autoMove && !unanswered;
  const talking = !open && (autoMove || !!e.outbox || (["asking", "negotiating"].includes(e.phase) && !e.waiting?.requester && !e.waiting?.provider && !items.length));
  const live_ = ["asking", "negotiating", "deal"].includes(e.phase);
  return `<div class="card eng ${items.length ? "needs-card" : ""}" data-engagement="${esc(e.id)}">
    <div class="row eng-head"><span class="avatar" aria-hidden="true">${esc(them.name.slice(0, 1).toUpperCase())}</span>
      <div class="eng-who"><b>${esc(them.name)}</b><span class="small faint">${mine === "requester" ? "You asked" : "Asked you"} · ${esc(e.title)}</span></div>
      <span class="end">${tag(ph, tone)}</span></div>
    ${stepper(e)}
    ${e.phase === "agreed" ? "" : `<p class="status ${talking ? "busy" : ""}">${talking ? `<span class="spinner"></span>` : ""}<span>${open ? openLine(e, mine, them) : statusLine(e, mine, them, items, talking)}</span>${e.offer.price ? `<span class="end faint small">listed ${money(e.offer.price, e.offer.unit)}</span>` : ""}</p>`}
    ${items.length || e.phase === "agreed" ? "" : keyAnswer(e, mine)}
    ${items.map(inboxBlock).join("")}
    ${open ? `<div class="row reply"><input class="field" data-followup="${esc(e.id)}" maxlength="300" placeholder="${mine === "requester" ? "Ask" : "Message"} ${esc(shortName(them.name))}'s agent…" aria-label="Follow-up">
      <button class="btn accent compact" data-act="eng-ask" data-id="${esc(e.id)}">Send</button><button class="btn quiet compact" data-act="eng-close" data-id="${esc(e.id)}">Done</button></div>
      <span class="small faint">To make an offer, name a price — “${mine === "requester" ? "I'll buy it for ₹350" : "I'll sell it for ₹400"}”. They confirm or say no; nothing is final until both do.</span>` : ""}
    ${["asking", "deal", "agreed", "negotiating"].includes(e.phase) && mine === "requester" && !["paid", "outside"].includes(e.payment?.status) ? `<div><button class="btn secondary compact" data-act="price-check" data-item="${esc(priceItem(e))}" data-area="${esc(e.brief.area ?? "India")}" data-unit="${esc(e.offer?.unit ?? "")}">Check fair price</button><span class="small faint"> Prices from the web · only you see them</span><div data-price-result></div></div>` : ""}
    ${e.phase === "agreed" && e.negotiation.deal ? dealBlock(e, mine) : ""}
    <details class="more"><summary>Details · ${e.qa.length} question${e.qa.length === 1 ? "" : "s"}${e.negotiation.requester.length + e.negotiation.provider.length ? ` · ${e.negotiation.requester.length + e.negotiation.provider.length} offers` : ""} · A2A log</summary>
      ${e.qa.length ? `<div class="qa">${e.qa.map(q => `<div><span class="faint">${STATUS_ICON[q.status] ?? "○"}</span>
        <span><span class="faint small">${q.from === mine ? "You" : "They"} asked:</span> ${esc(q.question)}${q.answer ? `<br><span class="muted">→ ${esc(q.answer)}</span>` : q.status === "pending" ? `<br><span class="faint small">waiting for ${q.from === mine ? esc(them.name) : "you"}…</span>` : ""}</span>
        <span class="row" style="gap:4px">${q.source ? SOURCE[q.source] ?? "" : ""}${q.verdict ? VERDICT[q.verdict] : ""}</span></div>`).join("")}</div>` : ""}
      ${offersChart(e)}
      <div class="timeline">${e.events.map(ev => `<div class="ev ${ev.who}">${ev.who === "system" ? `<span>${esc(ev.text)}</span>` : `<span class="who">${esc(whoLabel(ev.who, mine, them.name))}</span><span>${esc(ev.text)} ${byTag(ev.by)}</span>`}</div>`).join("")}</div>
      ${live_ ? `<div class="row"><button class="btn quiet compact end" data-act="eng-close" data-id="${esc(e.id)}">End conversation</button></div>` : ""}
    </details>
  </div>`;
}

/** The agreed deal: the price, what to do next, and the receipt — plain words first, the cryptography on request. */
/** Stock or a slot held for this deal: until when, or that it's gone, or that a slot needs picking. */
function reservationLine(e, mine, buyer) {
  const r = e.reservation;
  if (!r || e.payment?.status === "paid" && r.state === "committed" && !r.slot) return "";
  const when = t => new Date(t * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  if (r.state === "choose_slot") return mine === buyer
    ? `<div class="stack" data-slots="${esc(e.id)}"><span class="small">Pick a time to book it:</span><button class="btn secondary compact" data-act="slots-load" data-id="${esc(e.id)}">Show open slots</button></div>`
    : `<span class="small muted">Waiting for them to pick a time slot.</span>`;
  if (r.state === "unavailable") return `<span class="small" style="color:var(--danger)">Out of stock — ${mine === buyer ? "you can't pay until the seller restocks; nothing was charged" : "restock to let them pay"}.</span>`;
  if (r.state === "held") return `<span class="small muted">${r.slot ? `Slot ${when(r.slot.start)} held` : `${r.qty} reserved`} until ${when(r.expiresAt)}${mine === buyer ? " — pay before then to keep it" : ""}.</span>`;
  if (r.state === "committed" && r.slot) return `<span class="small" style="color:var(--fresh)">✓ Booked for ${when(r.slot.start)}</span>`;
  if (r.state === "released") return `<span class="small faint">Reservation released.</span>`;
  return "";
}

function dealBlock(e, mine) {
  const p = e.payment, seller = e.seller ?? "provider", buyer = seller === "requester" ? "provider" : "requester";
  const them = esc(shortName((mine === "requester" ? e.provider : e.requester).name));
  const amount = dealAmount(e);
  // The buttons say the total to pay; the line above them says what it's for.
  const total = money(e.payment?.cart?.total?.value ?? e.negotiation.deal.price, null, e.payment?.cart?.total?.currency ?? e.offer.currency);
  const id = esc(e.id);
  // AP2: the seller's agent signed a cart for the agreed terms; the buyer pays against it (test mode: no money moves).
  // A payment settles whether it went ahead — nobody is asked separately.
  let pay;
  if (!p) pay = `<span class="small faint"><span class="spinner"></span> ${mine === seller ? "Your" : `${them}'s`} agent is preparing the cart…</span>`;
  else if (p.status === "paid") pay = `<span class="small" style="color:var(--fresh)">✓ ${p.by === mine ? "You paid" : `${them} paid`} ${amount}</span><span class="small faint">Test payment · no money moved</span>`;
  else if (p.status === "outside") pay = `<span class="small" style="color:var(--fresh)">✓ ${p.by === mine ? "You" : them} marked it paid outside the app</span>`;
  else if (mine === buyer) pay = `<div class="row"><button class="btn gpay compact" data-act="eng-pay" data-gpay="1" data-id="${id}" data-amount="${e.payment?.cart?.total?.value ?? e.negotiation.deal.price}" data-currency="${esc(e.offer.currency ?? "INR")}" data-item="${esc(e.offer.title || e.title)}"><b>G</b> Pay ${total} with Google Pay</button><button class="btn accent compact" data-act="eng-pay" data-id="${id}">Pay ${total}</button><button class="btn quiet compact" data-act="eng-paid-outside" data-id="${id}">Paid another way</button></div>
      <span class="small faint">Test payment: nothing is charged. Your agent records it so ${them} can hand over.</span>`;
  else pay = `<div class="row"><span class="small muted">Waiting for ${them} to pay.</span><button class="btn quiet compact" data-act="eng-paid-outside" data-id="${id}">Got paid another way</button></div>`;
  // After payment: handover / delivery, then the buyer's acceptance — tracked apart from the payment.
  const f = e.fulfilment?.state ?? (p?.status === "paid" || p?.status === "outside" ? "not_started" : null);
  let fulfil = "";
  if (f === "accepted") fulfil = `<span class="small" style="color:var(--fresh)">✓ ${mine === buyer ? "You" : them} confirmed it arrived as agreed</span>`;
  else if (f === "disputed") fulfil = `<span class="small" style="color:var(--danger)">⚠ ${mine === buyer ? "You" : them} reported a problem${e.fulfilment?.note ? `: “${esc(e.fulfilment.note)}”` : ""}</span>`;
  else if (f === "delivered") fulfil = mine === buyer
    ? `<div class="row"><span class="small muted">${them} handed it over.</span><button class="btn accent compact" data-act="eng-received" data-id="${id}" data-ok="1">Received it ✓</button><button class="btn quiet compact" data-act="eng-received" data-id="${id}" data-ok="0">Report a problem</button></div>`
    : `<span class="small muted">✓ Delivered · waiting for ${them} to confirm</span>`;
  else if (f === "not_started") fulfil = mine === seller
    ? `<div class="row"><span class="small muted">${PASS[passKind(e)].sellerHint}, or</span><button class="btn secondary compact" data-act="eng-delivered" data-id="${id}">Mark delivered</button></div>`
    : `<span class="small muted">${PASS[passKind(e)].buyerHint(them)}</span>`;
  const fell = e.outcome?.[mine] === "fell_through" ? `<span class="small faint">You marked it as fell through.</span>`
    : p?.status === "paid" ? "" : `<button class="linkish small faint" data-act="eng-outcome" data-id="${id}" data-happened="0">It fell through</button>`;
  return `<div class="deal">
    <div class="row"><span class="deal-price">${amount}</span><span class="small muted">confirmed by both of you · ${mine === seller ? "you sell" : "you buy"}</span></div>
    ${reservationLine(e, mine, buyer)}
    ${pay}
    ${fulfil}
    ${(p?.status === "paid" || p?.status === "outside") && !["accepted", "disputed"].includes(f) ? `<div data-pickup="${id}"><button class="btn secondary compact" data-act="eng-pickup" data-id="${id}">${PASS[passKind(e)].name}</button></div>` : ""}
    <div class="row" data-receipt="${id}"><button class="btn quiet compact receipt-btn" data-act="eng-receipt" data-id="${id}">✓ Deal record · verify</button><span class="end">${fell}</span></div>
  </div>`;
}

function whoLabel(who, mine, themName) {
  const sideOf = who.startsWith("requester") ? "requester" : "provider";
  const agent = who.endsWith("_agent");
  if (sideOf === mine) return agent ? "Your agent" : "You";
  return agent ? `${shortName(themName)}'s agent` : shortName(themName);
}

/** What the owner's device is asked, inline in the conversation. */
function inboxBlock(i) {
  const demo = i.owner !== session.uid;
  const as = demo ? `<span class="small faint">Their phone is simulated in the demo — you're answering as them.</span>` : "";
  // Every decision says when it's due and what happens otherwise — silence is never taken as a yes.
  const due = i.deadline ? `<span class="small faint">Decide by ${new Date(i.deadline * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })} · ${i.onTimeout === "lapse" ? "if you don't, the deal lapses and nothing is agreed" : "if you don't, your agent keeps waiting"}</span>` : "";
  const box = (title, body) => `<div class="card slim accent" data-item="${esc(i.id)}">${label(title, "accent")}${as}${body}${due}</div>`;
  if (i.kind === "answer") {
    const d = drafts.get(i.id);
    return box(demo ? "Their agent needs them" : "Your agent needs you", `<span class="small">${i.side === "provider" ? "The requester's agent asks" : "Their agent asks"}: <b>${esc(i.question)}</b></span>
      ${d ? `<div class="card peri slim">${label(`Found in your private notes · ${d.on === "device" ? "on this device" : "Gemini"}`, "peri")}<span class="small">“${esc(d.text)}”</span>
        <div class="row"><button class="btn accent compact" data-act="inbox-share" data-id="${esc(i.id)}">Share this</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div></div>` : ""}
      <textarea class="field" rows="2" data-reply="${esc(i.id)}" placeholder="${d ? "Or write your own answer" : "Your answer"}"></textarea>
      <div class="row"><button class="btn compact" data-act="inbox-answer" data-id="${esc(i.id)}">Send</button><button class="btn quiet compact" data-act="inbox-decline" data-id="${esc(i.id)}">I'd rather not say</button></div>`);
  }
  if (i.kind === "approve") return box("Check before sharing", `<span class="small">Asked: <b>${esc(i.question)}</b></span>
    <div class="card slim">${label("Drafted from a Protected fact your rule covers")}<span class="small">“${esc(i.draft)}”</span></div>
    <div class="row"><button class="btn accent compact" data-act="inbox-approve" data-id="${esc(i.id)}">Share</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div>`);
  if (i.kind === "move" && !i.question && !demo && !needsLimit.has(i.id)) return `<span class="thinking small"><span class="spinner"></span><span class="faint">Your agent is making a move with your private limit…</span></span>`;
  if (i.kind === "move") return box(i.question ? "No deal inside your limit yet" : "Your agent needs your limit", `${i.question ? `<span class="small">${esc(i.question)}</span>` : `<span class="small">Set the most you'll pay (or least you'll take). It's never shared; your agent uses it for each move.</span>`}
    ${i.hint ? `<span class="small faint">${esc(i.hint)}</span>` : ""}
    <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-limit="${esc(i.id)}" placeholder="${i.listPrice ? money(i.listPrice) : "amount"}">
    <button class="btn accent compact" data-act="inbox-move" data-id="${esc(i.id)}">Keep negotiating</button><button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div>`);
  if (i.kind === "confirm") {
    const e = live.engagements.get(i.engagementId);
    const deal = e?.negotiation.deal;
    return box("Confirm the deal?", `<span class="small">${deal ? `<b>${dealAmount(e)}</b> for “${esc(e.offer?.title?.split(" · ")[0] || e.title)}”.` : ""} Nothing is final until both of you confirm.</span>
      <div class="row"><button class="btn accent compact" data-act="inbox-confirm" data-id="${esc(i.id)}">Confirm</button><button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">${e?.negotiation.chatOffer ? "Say no" : "Walk away"}</button></div>`);
  }
  return "";
}

export function messageHTML(m) {
  if (m.role === "user") return `<div class="msg-user"><div class="bubble">${esc(m.text)}</div>${label(time(m.at))}</div>`;
  return `<div class="msg-agent"><div class="row">${label("Collab", "sq ink")}${label("· " + (m.engine ?? "Gemini"))}${label("· " + time(m.at))}</div>
    ${m.pending ? `<span class="thinking"><span class="spinner"></span>${label(m.pending)}</span>` : m.text ? `<div class="text">${esc(m.text)}</div>` : ""}
    ${(m.cards ?? []).map((c, i) => renderCard(c, m, i)).join("")}</div>`;
}
