// The dynamic cards in chat (Collab's ComponentViews): each card is data in a chat message, rendered from that data
// plus live state, with buttons that act through `act`. A request is shaped with Gemini (its questions come with
// tap-to-answer options), sent, matched, and each conversation between agents is a live card that shows progress
// and asks the owner exactly when it needs them.
import { api, session } from "./api.js";
import { autonomyOf, drafts, needsLimit } from "./agent.js";
import { gpay } from "./gpay.js";
const gpayOk = () => gpay.available;
import { live, poke } from "./live.js";
import { fitsReasons } from "./fits.js";
import { avatarHTML, brand, byTag, esc, label, logo, money, shortName, tag, tierTag, time, icon, dots } from "./ui.js";
import { cap, limitPast, limitWords, listingRoles, offerWords, partyRoles, rolesOf } from "./roles.js";

const STATUS_ICON = { open: "○", pending: "◔", answered: "●", declined: "✕" };
const VERDICT = { met: tag("met", "fresh"), unmet: tag("not met", "danger"), unclear: tag("unclear", "stale") };
const SOURCE = { public: tag("Public", "fresh"), protected: tag("Protected", "accent"), owner: tag("Owner", "ink"), brief: tag("Brief"), listing: tag("Listing") };

/** The agent at work: the steps it goes through, lit one after another, the last one bold when it's nearly back. */
export const calibrating = (lines, title = "your agent") => `<div class="calib" aria-live="polite"><span class="row" style="gap:8px">${logo("live")}<span class="label">${esc(title)} is working</span>${dots()}</span><div class="calib-bar"></div>
  ${lines.map((l, i) => `<span class="calib-line" style="--i:${i}">› ${esc(l)}${i < lines.length - 1 ? "…" : ""}</span>`).join("")}</div>`;

export function renderCard(card, m, i) {
  const at = `data-msg="${esc(m.id)}" data-card="${i}"`;
  switch (card.type) {
    case "brief": return briefCard(card, at);
    case "offer": return offerCard(card, at);
    case "saved": return savedCard(card, at);
    case "sources": return sourcesCard(card, at);
    case "suggest": return `<div class="row">${card.options.map(o => (o.text ? `<button class="chip" data-act="send-text" data-text="${esc(o.text)}">↗ ${esc(o.label)}</button>` : `<label class="chip" for="photo-in">${esc(o.label)}</label>`)).join("")}<span class="small faint">${esc(card.hint ?? "Saved to your private context.")}</span></div>`;
    case "engagement": return engagementCard(live.engagements.get(card.id), card.id);
    case "discovery": return discoveryCard(card, at);
    case "store": return storeCard(card);
    default: return "";
  }
}

// MARK: - Your agent, talking to several agents at once

/**
 * One request, many conversations: your agent contacted the best matches by itself (only the shared request went
 * out) and talks to all of them at once. One live list — what needs you on top, each row opening its conversation.
 */
function discoveryCard(c, at) {
  const es = (c.engaged ?? []).map(id => live.engagements.get(id)).filter(Boolean);
  const mineSide = e => (e.requester.uid === session.uid ? "requester" : "provider");
  const items = e => live.inbox.filter(i => i.engagementId === e.id && i.status !== "done");
  // Waiting on the owner — or, in the demo, on a demo person's simulated phone that the owner answers for.
  const needs = e => items(e).some(i => (i.owner === session.uid || i.owner.startsWith("demo-")) && !(i.kind === "move" && !i.question && !needsLimit.has(i.id)));
  const rank = e => (needs(e) ? 0 : ["deal", "negotiating", "asking", "new"].includes(e.phase) ? 1 : e.phase === "agreed" ? 2 : 3);
  const sorted = [...es].sort((a, b) => rank(a) - rank(b));
  const nNeed = es.filter(needs).length, live_ = es.filter(e => !["agreed", "closed", "declined"].includes(e.phase)).length;
  const row = e => {
    const side = mineSide(e), them = side === "provider" ? e.requester : e.provider, need = needs(e);
    const [st, tone] = dealStage(e, side, need);
    // What needs the owner, said plainly: the question itself, the deal to confirm, or the limit to set.
    const ask = items(e).find(i => i.owner === session.uid || i.owner.startsWith("demo-"));
    const line = need && ask ? (ask.question ? `${ask.owner === session.uid ? "Asks you" : `Asks ${shortName(them.name)} (demo)`}: ${ask.question}` : ask.kind === "confirm" ? `Confirm ${dealAmount(e)}` : ask.kind === "move" ? "Set the most you'd pay to keep going" : "Waiting for you")
      : statusLine(e, side, them, items(e), !["agreed", "closed", "declined"].includes(e.phase)).replace(/<[^>]+>/g, "");
    return `<button class="disc-row ${need ? "needs" : ""}" data-act="eng-open" data-id="${esc(e.id)}" data-anim="dr-${esc(e.id)}" data-anim-sig="${esc(st + line)}">
      ${avatarHTML(them.name, them.handle, 36)}<span class="disc-text"><b>${esc(them.name)}</b><span class="small muted">${!need && !["agreed", "closed", "declined"].includes(e.phase) ? `<span class="live-dot" aria-hidden="true"></span> ` : ""}${esc(line)}</span></span>
      <span class="disc-side">${tag(st, tone)}<span class="small faint">${need ? "Open ›" : "›"}</span></span></button>`;
  };
  const more = (c.found ?? []).filter(f => !f.over && !(c.engaged ?? []).some(id => live.engagements.get(id)?.offer?.factId === f.fact.id)).length;
  return `<div class="card disc" ${at}>
    <div class="row">${live_ ? `<span class="live-dot" aria-hidden="true"></span>` : ""}${label(live_ ? `Talking to ${live_} agent${live_ === 1 ? "" : "s"}` : `${es.length} conversation${es.length === 1 ? "" : "s"}`, "sq ink")}${live_ ? dots() : ""}
      ${nNeed ? `<span class="end">${tag(`${nNeed} need${nNeed === 1 ? "s" : ""} you`, "wait")}</span>` : ""}</div>
    ${c.title ? `<span class="small faint">${esc(c.title)}</span>` : ""}
    ${live_ ? `<div class="work-line" aria-hidden="true"></div>` : ""}
    <div class="disc-list">${sorted.map(row).join("") || `<p class="small muted">Starting…</p>`}</div>
    <div class="row">${more ? `<button class="btn secondary compact" data-act="disc-more" ${at}>Ask ${more} more</button>` : ""}<button class="btn quiet compact" data-act="agent-stream">Agent log ›</button></div>
  </div>`;
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
  const head = `<div class="row eng-head">${avatarHTML(p.name, p.handle, 36)}<div class="eng-who"><b>${esc(p.name)}</b><span class="small faint">@${esc(p.handle)}${p.bio ? ` · ${esc(p.bio)}` : ""}</span></div>
      ${preview ? tag("Your card · preview", "accent") : `<button class="btn secondary compact end" data-act="add-contact-direct" data-handle="${esc(p.handle)}">Add to people</button>`}</div>`;
  const record = recordLine(c.record, p);
  if (c.paused) return `<div class="card">${head}${record}<span class="small">${esc(p.name)} isn't taking requests right now.</span></div>`;
  if (!items.length) {
    const qs = c.suggestions?.length ? c.suggestions.map(x => x.text) : ["What are you looking for right now?", "Are you free this weekend?"];
    return `<div class="card">${head}${record}
      <span class="small faint">${first} hasn't listed anything yet. Their agent answers from what they share and passes anything else to them.</span>
      <div class="row">${qs.map(q => `<button class="chip" data-act="send-text" data-text="${esc(q)}" ${off}>${esc(q)}</button>`).join("")}</div></div>`;
  }
  const shown = items.slice(0, 3), more = items.slice(3);
  return `<div class="card">${head}${record}
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
  const data = `data-shop-item data-handle="${esc(p.handle)}" data-fact="${esc(it.factId)}" data-price="${it.price ?? ""}" data-currency="${esc(it.currency)}" data-unit="${esc(it.unit ?? "")}" data-max="${it.maxQuantity}"${it.stock?.available != null ? ` data-stock="${it.stock.available}"` : ""} data-name="${esc(it.name)}"`;
  const offer = it.price != null ? `<button class="btn secondary compact" data-act="store-offer-open" ${off}>Make an offer</button>` : "";
  let act = "";
  if (it.action === "buy") {
    const out = it.stock?.state === "out";
    act = out
      ? `<div class="row"><button class="btn compact" disabled>Out of stock</button><button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`When will ${it.name} be back in stock?`)}" ${off}>Ask when it's back</button></div>`
      : `<div class="row">${it.maxQuantity <= 1 ? "" : `<div class="stepper" role="group" aria-label="How many"><button class="btn quiet compact" data-act="qty" data-d="-1" aria-label="One fewer" ${off}>−</button><input class="qty" type="number" inputmode="numeric" min="1" max="${it.maxQuantity}" value="1" aria-label="How many" ${off}><button class="btn quiet compact" data-act="qty" data-d="1" aria-label="One more" ${off}>+</button></div><span class="small faint qty-note" hidden></span>`}
          <button class="btn accent compact" data-act="store-order" data-kind="buy" ${off}>Buy for ${money(it.price, null, it.currency)}</button>${offer}</div>`;
  } else if (it.action === "book") {
    act = it.slots?.length
      ? `<span class="small muted">Pick a time:</span><div class="row slots">${it.slots.map(s => `<button class="chip" data-act="shop-slot" data-slot="${esc(s.id)}" data-label="${esc(slotText(s, it.timezone))}" ${off}>${esc(slotText(s, it.timezone))}</button>`).join("")}</div>
         <div class="row"><button class="btn accent compact" data-act="store-order" data-kind="book" disabled>Pick a time to book</button>${offer}</div>`
      : it.slots ? `<div class="row"><span class="small muted">No free times in the next two weeks.</span><button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`When are you next free for ${it.name}?`)}" ${off}>Ask when they're free</button></div>`
      : `<div class="row"><button class="btn accent compact" data-act="store-order" data-kind="book" ${off}>Request a booking · ${price}</button>${offer}</div>`;
  } else if (it.action === "visit" && rolesOf(it.category).respond) {
    // A job post is applied for (a job seeker's own listing: asked to work); nobody visits it.
    const [btn, said] = it.ownerPays ? ["Apply", `I'd like to apply for ${it.name}. What's the next step?`] : ["Ask to hire", `I'd like to hire you for ${it.name}. Are you available?`];
    act = `<div class="row"><button class="btn accent compact" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(said)}" ${off}>${btn}</button>${offer}</div>`;
  } else if (it.action === "visit") {
    act = `<div class="row"><button class="btn accent compact" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`I'm interested in ${it.name}. Can I visit this weekend?`)}" ${off}>I'm interested — ask to visit</button>${offer}</div>`;
  } else {
    act = `<div class="row"><button class="btn accent compact" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(`How much is ${it.name}?`)}" ${off}>Ask for a price</button></div>`;
  }
  return `<div class="shop-item" ${data}>
    ${it.photo ? `<img class="item-photo" src="${esc(it.photo)}" alt="${esc(it.name)}" loading="lazy">` : ""}
    <div class="row"><b>${esc(it.title.split(" · ")[0])}</b><b class="end">${price}</b></div>
    ${it.details && it.details !== it.title ? `<span class="small muted">${esc(it.details)}</span>` : ""}
    ${stock || it.instant || it.perBuyer ? `<div class="row">${stock}${it.instant ? tag("Instant booking", "peri") : ""}${it.perBuyer ? tag(`At most ${it.perBuyer} per person`) : ""}</div>` : ""}
    ${it.policies?.length ? `<details class="more"><summary>Their terms</summary>${it.policies.map(p => `<div class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</div>`).join("")}</details>` : ""}
    ${act}
    <div class="offer-box" hidden><div class="row"><input class="field compact" type="number" inputmode="numeric" min="1" placeholder="Your ${esc(rolesOf(it.category).price)}${it.unit && it.unit !== "each" ? ` per ${esc(it.unit)}` : it.action === "buy" ? " each" : ""} (${esc(it.currency)})" data-offer-price><input class="field compact" type="number" inputmode="numeric" min="1" placeholder="${it.ownerPays ? "At least" : "Up to"} (private)" data-offer-max title="Your agent negotiates and may agree ${it.ownerPays ? "down" : "up"} to this. Never shown to them."><button class="btn accent compact" data-act="store-offer-send" ${off}>Send offer</button></div>
      <span class="small faint">With a private limit, your agent bargains for you and only asks you if there's no deal inside it.</span>
      <span class="small faint">${esc(shortName(p.name))}'s agent answers — it may counter. Nothing is final until both of you confirm.</span></div>
    <div class="row qs">${(it.questions ?? []).map(q => `<button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(q.text)}" ${off}>${esc(q.text)}</button>`).join("")}</div>
  </div>`;
}

/**
 * A seller's record, from their registered receipts: verified sales, handovers, problems, and recent sales with each
 * receipt's fingerprint. No buyer names and no prices — those stay in the receipts the two people hold.
 */
function recordLine(r, p) {
  const member = monthOf(p?.memberSince);
  if (!r?.sales) return `<span class="small faint">No deals recorded on Collab yet${member ? ` · on Collab since ${esc(member)}` : ""}.</span>`;
  const since = r.since ? new Date(r.since * 1000).toLocaleDateString([], { month: "short", year: "numeric" }) : "";
  // Problems, then what buyers reported and the seller didn't answer in time, then what's disputed (counted per buyer, not per order).
  const rep = r.reports ?? {}, nr = rep.notReceived ?? 0, na = rep.notAsAgreed ?? 0, nd = rep.disputed ?? 0;
  const said = `${r.problems ? ` · ${r.problems} with problems` : nr || na || nd ? "" : " · no problems"}${nr ? ` · ⚠ ${nr} ${nr === 1 ? "buyer says they" : "buyers say they"} paid and didn't get it (no reply)` : ""}${na ? ` · ⚠ ${na} reported a problem (no reply)` : ""}${nd ? ` · ${nd} disputed` : ""}`;
  return `<details class="more record"><summary>✓ ${r.verified} verified ${r.verified === 1 ? "deal" : "deals"} · ${r.handedOver} completed${said}${member ? ` · on Collab since ${esc(member)}` : since ? ` · since ${esc(since)}` : ""}</summary>
    ${r.recent.map(s => `<div class="row small"><span>${esc(s.item)}${s.quantity > 1 ? ` × ${s.quantity}` : ""}</span><span class="faint">${esc(s.month)}</span>${s.report ? reportRow(s.report) : s.handedOver ? `<span style="color:var(--fresh)">handed over</span>` : s.problem ? `<span style="color:var(--danger)">problem reported</span>` : `<span class="faint">paid or pending</span>`}
      ${s.receipt ? `<code class="small faint" title="Receipt fingerprint (SHA-256), signed for them">#${esc(s.receipt.hash.slice(0, 10))}</code>` : ""}</div>`).join("")}
    <span class="small faint">From signed receipts — who and for how much stay private. <a href="/public/people/${esc(p.handle)}/record" target="_blank" rel="noopener">Check the record</a></span></details>`;
}

/** One sale's report, as the record shows it: no reply in time (red), or disputed with the seller's answer (amber). */
const SELLER_SAYS = { handed_over: "handed over", refunded: "refunded", never_paid: "never paid" };
function reportRow(r) {
  const scanned = r.passScanned ? " · pass scanned at handover" : "";
  if (r.status === "unanswered") return `<span style="color:var(--danger)">${r.reason === "not_as_agreed" ? "problem reported" : "paid, not received"} · no reply${scanned}</span>`;
  return `<span style="color:var(--stale)">disputed${r.reply ? ` · seller says ${esc(SELLER_SAYS[r.reply] ?? r.reply)}` : ""}${scanned}</span>`;
}
/** "2026-03" → "Mar 2026" (when someone joined Collab). */
export const monthOf = m => { const [y, mo] = String(m ?? "").split("-").map(Number); return y && mo ? new Date(y, mo - 1, 1).toLocaleDateString([], { month: "short", year: "numeric" }) : ""; };

/** A card saved before cards carried the storefront: its offerings, with plain questions that name the item. */
function fallbackItems(c) {
  return (c.facts ?? []).filter(f => f.offer).map(f => {
    const name = f.offer.title.split(" · ")[0];
    return { factId: f.id, title: f.offer.title, name, details: "", category: f.offer.category, price: f.offer.price?.amount ?? null, currency: f.offer.price?.currency ?? "INR",
      unit: f.offer.price?.period ?? null, action: f.offer.price?.amount != null ? "buy" : "ask", stock: null, maxQuantity: 20, slots: null, timezone: null,
      questions: f.offer.questions?.length ? f.offer.questions : [{ text: `Can I get ${name}?` }, { text: `What's your best price for ${name}?` }] };
  });
}

// MARK: - A request, shaped with Gemini


/** Rules read from the owner's words, said back: each line marked private (only their agent knows) or shown to the other side. */
export function rulesList(lines) {
  return `<div class="stack" style="gap:4px">${(lines ?? []).map(l => `<div class="row small">${tag(l.private ? "Private" : "Shown", l.private ? "peri" : "fresh")}<span>${esc(l.text)}</span></div>`).join("")}</div>`;
}

/** The gate: not specific enough for other people's agents yet — the questions that would fix it, or send it anyway. */
/** A question's options, with the owner's earlier answer marked ("· you said before"); an earlier answer in their own
 *  words that isn't one of the options is offered as one more chip. `attrs(option, k, extra)` gives each chip's data. */
function recallChips(c, q, attrs, chosen = null) {
  const r = c.recalled?.[q.question];
  const chips = q.options.map((o, k) => `<button class="chip ${chosen === o ? "on" : r?.option === o ? "suggested" : ""}" ${attrs(o, k, false)}>${esc(o)}${r?.option === o ? " · you said before" : ""}</button>`);
  if (r && !r.option) chips.push(`<button class="chip suggested" ${attrs(r.answer, -1, true)} title="Your earlier answer">${esc(r.answer.slice(0, 40))} · you said before</button>`);
  return chips.join("");
}

/** Places Google Maps found for a request with no match on Collab (kept with the card). */
export function nearbyHTML(r) {
  return r.places?.length ? `<div class="stack" style="gap:6px">${r.places.map(p => `<a class="small" href="${esc(p.uri)}" target="_blank" rel="noopener noreferrer">${icon("pin", 14)} ${esc(p.title)}</a>`).join("")}
    <span class="small faint">${esc(r.note ?? "")} · Source: Google Maps</span></div>` : `<span class="small muted">Google Maps found nothing close that fits.</span>`;
}

/** Web prices checked in this session, by what was asked — shown wherever that item's card is, through repaints. */
export const priceChecks = new Map(); // key → { state: "loading" } | { state: "done", r } | { state: "error", message }
export const priceKey = (item, area, unit) => `${item}|${area}|${unit ?? ""}`.toLowerCase();
function priceResultHTML(key) {
  const p = priceChecks.get(key);
  if (!p) return "";
  if (p.state === "loading") return `<div class="card slim working"><span class="row small">${logo("live spinner")} Your agent is searching the web for asking prices…</span></div>`;
  if (p.state === "error") return `<div class="card slim"><span class="small">${esc(p.message)}</span></div>`;
  const r = p.r, left = typeof r.remaining === "number" ? ` · ${r.remaining} checks left today` : "";
  return `<div class="card"><b>${r.status === "evidence" ? `${money(r.low)}–${money(r.high)} · usually ${money(r.typical)}${r.unit && r.unit !== "each" ? `/${esc(r.unit)}` : ""}` : "Not enough comparable prices found"}</b>
    <ul class="price-list">${r.items.map(i => `<li><span>${esc(i.label)}</span><b>${money(i.price)}</b>${i.sources.filter((x, k, all) => all.findIndex(y => (y.title || y.url) === (x.title || x.url)) === k).map(x => `<a class="small" href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || "Source")}</a>`).join(" ")}</li>`).join("")}</ul>
    <span class="small faint">${esc(r.note)}</span><span class="small faint">Only you see this${r.cached ? " · checked earlier today" : left} · ${new Date(r.checkedAt * 1000).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>
    ${r.searchEntryPoint ? `<iframe class="search-entry" title="Google Search suggestions" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(`<base target="_blank">${r.searchEntryPoint}`)}"></iframe>` : ""}</div>`;
}

function gateBanner(c, at, kind) {
  const g = c.gate;
  if (!g || g.ok || c.gateOverride) return "";
  // Answered questions aren't asked twice.
  const open = g.missing.map((q, j) => [q, j]).filter(([q, j]) => !c.gateAnswers?.[j] && !(c.answered ?? []).some(x => x.question === q.question));
  if (!open.length) return "";
  return `<div class="card slim ask-box">${label(g.broad ? "This could mean a lot of things" : "I need a little more", "accent")}
    <span class="small muted">Tap what fits and I'll do the rest — or ${kind === "offer" ? "publish" : "search"} as it is.</span>
    ${open.map(([q, j]) => `<div class="stack" style="gap:6px"><span class="small">${esc(q.question)}</span><div class="row">${recallChips(c, q, (o, k, extra) => `data-act="gate-answer" data-j="${j}" ${extra ? `data-val="${esc(o)}"` : `data-k="${k}"`} ${at}`, c.gateAnswers?.[j])}</div></div>`).join("")}
    <div class="row"><button class="btn quiet compact" data-act="gate-override" ${at}>${kind === "offer" ? "Publish" : "Search"} as it is</button></div></div>`;
}

function briefCard(c, at) {
  const d = c.draft, s = d.shared, need = d.need;
  if (c.step === "matches") return matchesCard(c, at);
  if (c.step === "engaged") return `<div class="card slim"><div class="row">${label("Sent", "sq ink")}<span class="small">${esc(s.title)}</span></div><span class="small faint">I only shared what you saw — never your limit or notes.</span></div>`;
  const mode = { online: "Online", in_person: "In person", either: "Online or in person" }[need.mode] ?? null;
  // Who receives this request, and which way the private limit points: a job seeker's is the least they'd take.
  const R = rolesOf(need.category), paid = !!need.requesterPaid, providers = paid ? R.payers : R.payees;
  const where = [need.place.name, need.place.name !== "Online" && need.mode !== "online" ? `within ${need.radiusKm} km` : null, mode].filter((x, i, all) => x && all.findIndex(y => String(y).toLowerCase() === String(x).toLowerCase()) === i).join(" · ");
  // Only what adds to the title: "guitar" on "Guitar lessons for a beginner" says nothing new.
  const titleWords = new Set(`${s.title} ${need.place.name}`.toLowerCase().split(/[^\p{L}\p{N}]+/u));
  const shown = s.requirements.map((r, j) => ({ r, j })).filter(({ r }) => r.value.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).some(w => !titleWords.has(w)));
  const who = d.who || providers;
  // What needs the owner now (Gemini's questions, the requirements, the limit) is in view; the rest is under More options.
  return `<div class="card brief" ${at}>
    ${stages(0)}
    <div class="row">${label("I'll look for", "sq accent")}<span class="end">${tag(need.category.replace(/-/g, " "))}</span></div>
    <input class="field bare title-edit" data-edit="title" value="${esc(s.title)}" aria-label="Title">
    <p class="small faint row" style="gap:6px">${icon("pin", 14)}${esc(where)}</p>
    ${(c.gate && !c.gate.ok) || d.clarify?.length ? `<span class="label sq">step 2 of 2 · tap what fits, or just go</span>` : ""}
    ${gateBanner(c, at, "brief")}
    ${(c.answered ?? []).some(x => x.before) ? `<span class="small faint">From what you said before: ${(c.answered ?? []).filter(x => x.before).map(x => `<b>${esc(x.answer)}</b> (${esc(x.question.replace(/\?$/, "").toLowerCase())})`).join(" · ")}</span>` : ""}
    ${d.clarify?.length ? `<div class="card slim ask-box">${label("Quick question before I search", "accent")}
      ${d.clarify.map((q, j) => `<div class="stack" style="gap:6px"><span class="small">${esc(q.question)}</span><div class="row">${recallChips(c, q, (o, k, extra) => `data-act="brief-clarify" data-j="${j}" ${extra ? `data-val="${esc(o)}"` : `data-k="${k}"`} ${at}`)}</div></div>`).join("")}</div>` : ""}
    ${d.profile?.length ? profileBlock(d, s, providers, at) : ""}
    ${shown.length ? `<div class="stack" style="gap:6px"><span class="small faint">What matters · tap one to make it optional</span><div class="row">${shown.map(({ r, j }) => `<span class="chip req ${r.strength === "required" ? "on" : ""}"><button class="linkish" data-act="brief-strength" data-j="${j}" ${at} title="${r.strength === "required" ? "Make it optional" : "Make it a must"}">${esc(r.value)}${r.strength === "required" ? "" : " · optional"}</button><button class="linkish x" data-act="brief-drop" data-j="${j}" ${at} aria-label="Remove ${esc(r.label)}">×</button></span>`).join("")}</div></div>` : ""}
    <div class="privacy-split">
      <div>${label(`I'll tell ${who}`, "fresh")}<span class="small">What you need, ${esc(need.place.name)}${mode ? ` · ${esc(mode.toLowerCase())}` : ""}${s.requirements.length ? " · what matters to you" : ""}${s.about?.length ? " · your profile" : ""}${s.budget ? ` · a ${esc(R.price)} range (${esc(s.budget)})` : ` · no ${esc(R.price)}`}</span></div>
      <div>${label("I keep private", "peri")}<span class="small">${cap(limitWords(paid))}, and your exact address and phone</span></div>
    </div>
    <details class="more"><summary>Exactly what I'll send</summary><dl class="kv small">
      <dt>Title</dt><dd>${esc(s.title)}</dd><dt>Details</dt><dd>${esc(s.summary)}</dd><dt>Where</dt><dd>${esc(need.place.name)}${mode ? ` · ${esc(mode.toLowerCase())}` : ""}</dd>
      ${s.requirements.length ? `<dt>What matters</dt><dd>${s.requirements.map(r => `${esc(r.value)}${r.strength === "required" ? "" : " (optional)"}`).join(" · ")}</dd>` : ""}
      <dt>${esc(cap(R.price))}</dt><dd>${s.budget ? esc(s.budget) : "Not mentioned"}</dd>${s.questions?.length ? `<dt>Asks</dt><dd>${s.questions.map(esc).join(" · ")}</dd>` : ""}</dl></details>
    <div class="row"><span class="small">${paid ? "Least you'd take" : "Most you'll pay"}</span><input class="field" style="max-width:150px" type="number" min="1" data-edit="limit" value="${d.mandate?.price.limit ?? ""}" placeholder="optional">
      <span class="small faint">${s.budget ? `private · they see “${esc(s.budget)}”` : "private · never shown"}</span></div>
    <div class="stack" style="gap:6px">${label("Or tell me your rules in your words", "peri")}
      <div class="row"><input class="field" style="flex:1;min-width:220px" data-edit="rulesText" ${at} value="${esc(c.rulesText ?? "")}" placeholder="e.g. up to ₹3,200, close yourself below ₹3,000, only if I can collect this weekend">
        <button class="btn secondary compact" data-act="brief-rules-read" ${at}>Read my rules</button></div>
      ${c.rules ? `${rulesList(c.rules.lines)}<div class="row">${c.rulesOk ? `<span class="small" style="color:var(--fresh)">✓ Your agent will follow these</span>` : `<button class="btn accent compact" data-act="brief-rules-ok" ${at}>Looks right</button>`}<button class="btn quiet compact" data-act="brief-rules-clear" ${at}>Clear</button></div>` : ""}</div>
    <details class="more"><summary>More options${s.questions.length ? ` · I'll ask them ${s.questions.length}` : ""}${c.insights?.length ? " · past deals" : ""}</summary>
      ${s.questions.length ? `<div class="stack" style="gap:6px">${label("I'll ask them")}<div class="row">${s.questions.map((q, j) => `<span class="chip">${esc(q)} <button class="linkish x" data-act="brief-dropq" data-j="${j}" ${at} aria-label="Remove">×</button></span>`).join("")}</div></div>` : ""}
      <div class="stack" style="gap:6px">${label("While you're away")}${autonomyPick(c)}</div>
      ${c.insights?.length ? `<div class="stack" style="gap:4px">${label("What similar deals closed at", "peri")}${c.insights.map(l => `<div class="small">${esc(l)}</div>`).join("")}</div>` : ""}
    </details>
    <div><button class="btn secondary compact" data-act="price-check" data-item="${esc(s.title)}" data-area="${esc(need.place.name)}" data-unit="${esc(need.unit ?? "")}">${d.who ? `What do ${esc(d.who)} charge?` : `Prices for ${esc(s.title.split(" ").slice(0, 4).join(" ").toLowerCase())}`}</button><span class="small faint"> I'll check asking prices on the web${need.place.name && need.place.name !== "Online" ? ` near ${esc(need.place.name.split(",")[0])}` : ""} · only you see them</span><div data-price-result>${priceResultHTML(priceKey(s.title, need.place.name, need.unit))}</div></div>
    <div class="row"><button class="btn accent" data-act="brief-send" ${at}>Find ${esc(who)}</button><span class="small faint">I'll talk to the best matches myself — only what I tell them above goes out.</span></div>
  </div>`;
}

/** A job seeker's short profile: what employers' agents screen for, answered once and shared — never searched on. */
function profileBlock(d, s, providers, at) {
  const rows = d.profile.map(q => {
    const cur = s.about?.find(x => x.label === q.label)?.value ?? "", typed = cur && !q.options.includes(cur);
    return `<div class="stack" style="gap:6px"><span class="small"><b>${esc(q.label)}</b> · ${esc(q.question)}</span>
      ${q.options.length ? `<div class="row">${q.options.map(o => `<button class="chip ${cur === o ? "on" : ""}" data-act="brief-about" data-key="${esc(q.label)}" data-val="${esc(o)}" ${at}>${esc(o)}</button>`).join("")}</div>` : ""}
      ${!q.options.length || typed ? `<input class="field" data-edit="about" data-key="${esc(q.label)}" value="${esc(cur)}" maxlength="120" placeholder="${q.options.length ? "Or type your own" : "e.g. React, Node.js, SQL"}" aria-label="${esc(q.label)}">` : ""}</div>`;
  }).join("");
  const done = (s.about ?? []).length;
  return `<div class="card peri slim">${label(`Your profile · shared with ${providers}`, "peri")}${rows}
    <span class="small faint">${done} of ${d.profile.length} answered. Their agents answer screening questions from this, so you're asked less. Never put your salary, phone or e-mail here.</span></div>`;
}

const autonomyPick = (c, a = autonomyOf(c)) => `<select class="field" data-edit="autonomy">
    <option value="" ${!a ? "selected" : ""}>Ask me for every move</option>
    <option value="negotiate" ${a === "negotiate" ? "selected" : ""}>My always-on agent negotiates inside my limit; I confirm the deal</option>
    <option value="close" ${a === "close" ? "selected" : ""}>My always-on agent negotiates and closes inside my limit</option></select>
  ${a ? `<select class="field" data-edit="days" style="max-width:110px">${[1, 7, 30].map(n => `<option value="${n}" ${(c.days ?? 7) === n ? "selected" : ""}>${n} days</option>`).join("")}</select>` : ""}`;

// The owner's private notes kept on this device (app.js sets them before drawing a chat with matches). They stay in
// memory here: the "Fits you" lines are worked out each time the card is drawn and never written into the card's
// data, which syncs to the account (fits.js).
let notesHere = [];
export const setNotesHere = notes => { notesHere = Array.isArray(notes) ? notes : []; };

function matchesCard(c, at) {
  const found = c.found ?? [];
  const real = found.filter(f => !f.over).length;
  const s = c.draft.shared, asked = [s.title, s.summary, ...(s.requirements ?? []).map(r => r.value)].join(" ");
  const fits = notesHere.length ? found.map(f => fitsReasons(notesHere, f.fact, asked)) : [];
  const firstFit = fits.findIndex((r, j) => r.length && (j < 3 || c.showAll)); // the one line that says where these come from
  const watch = c.watching ? `<span class="small row" style="color:var(--fresh);gap:8px"><span class="live-dot"></span>live · your agent keeps looking in the background (every hour, 14 days)</span>`
    : `<button class="btn secondary compact" data-act="watch" ${at}>Keep watching</button>`;
  if (!found.length) {
    // Nothing fits exactly — never a dead end: the closest real listings on Collab, places from Google Maps (looked up
    // on their own), and an agent that keeps looking.
    const near = (c.closest ?? []).map((f, j) => `<div class="disc-row as-div">${avatarHTML(f.profile.name, f.profile.handle, 36)}<span class="disc-text"><b>${esc(f.profile.name)}${f.profile.demo ? ` ${tag("demo")}` : ""}</b>
        <span class="small muted">${esc((f.fact.offer?.title ?? f.fact.text).split(" · ")[0])}${f.fact.offer?.price ? ` · ${money(f.fact.offer.price.amount, f.fact.offer.price.period, f.fact.offer.price.currency)}` : ""}</span></span>
        <span class="disc-side">${c.askedClosest?.[j] ? tag("Asked", "fresh") : `<button class="btn secondary compact" data-act="closest-ask" data-j="${j}" ${at}>Ask their agent</button>`}</span></div>`).join("");
    const maps = c.nearby?.loading ? `<div class="card slim working"><span class="row small">${logo("live spinner")} Looking on Google Maps nearby…</span></div>` : c.nearby ? nearbyHTML(c.nearby) : "";
    const who = c.draft.who || "anyone";
    return `<div class="card" ${at}>${label("No exact match yet", "sq")}
      <p class="small muted">I couldn't find ${esc(who)} for “${esc(c.draft.shared.title)}” on Collab yet. ${near ? "These are the closest — I can ask them." : "I'll keep looking, or try a wider area."}</p>
      ${near ? `<div class="disc-list">${near}</div>` : ""}
      <div data-nearby>${maps}</div>
      <div class="row">${watch}${c.nearby ? "" : `<button class="btn secondary compact" data-act="nearby" data-item="${esc(c.draft.shared.title)}" data-area="${esc(c.draft.shared.area ?? "")}">Look on Google Maps nearby</button>`}</div></div>`;
  }
  return `<div class="card" ${at}>
    ${stages(1)}
    <div class="row">${label(real ? `${real} ${real === 1 ? "match" : "matches"}` : "No exact match", "sq ink")}${c.rankedByModel && real ? `<span class="small faint">ranked by Gemini</span>` : ""}${found.length > real ? `<span class="small faint">· ${found.length - real} above your budget</span>` : ""}</div>
    ${found.map((f, j) => (j >= 3 && !c.showAll ? "" : `<label class="match-row">
      <input type="checkbox" data-pick="${j}" ${c.picked?.includes(j) ? "checked" : ""} ${at}>
      ${avatarHTML(f.profile.name, f.profile.handle, 36)}
      <span class="match-main"><span class="row"><b>${esc(f.profile.name)}</b>${f.profile.demo ? tag("demo") : ""}${f.profile.stats?.kept ? tag(`${f.profile.stats.kept} deal${f.profile.stats.kept === 1 ? "" : "s"} done`, "fresh") : ""}${f.profile.stats?.notReceived >= (session.config.reports?.warnAt ?? 2) ? tag(`⚠ ${f.profile.stats.notReceived} paid, not received`, "danger") : ""}
          <span class="end">${f.fact.offer ? `<b>${money(f.fact.offer.price.amount, f.fact.offer.price.period)}</b>` : ""}</span></span>
        <span class="small muted">${esc(f.why ?? f.fact.offer?.title ?? f.fact.text.slice(0, 120))}</span>
        ${fits[j]?.length ? `<span class="small fits"><b>Fits you</b> · ${fits[j].map(r => `${esc(r.reason)} <span class="faint">— you noted “${esc(r.note)}”</span>`).join(" · ")}</span>${j === firstFit ? `<span class="small faint">From your private notes, on this device</span>` : ""}` : ""}
        ${f.over ? `<span class="small" style="color:var(--stale)">Above your budget — ticking it lets your agent try to bring the price down.</span>` : ""}
        <span class="small faint">${[f.distanceKm ? `${f.distanceKm} km` : null, ...f.met.slice(0, 2).map(x => `✓ ${x}`), f.unknown.length ? `${f.unknown.length} to ask` : null].filter(Boolean).map(esc).join(" · ")}</span>
        ${f.profile.stats?.deals ? `<span class="small faint">Track record: ${f.profile.stats.deals} deal${f.profile.stats.deals === 1 ? "" : "s"} · ${f.profile.stats.kept} completed as agreed${f.profile.stats.notReceived ? ` · ⚠ ${f.profile.stats.notReceived} ${f.profile.stats.notReceived === 1 ? "says" : "say"} they paid and didn't get it` : ""}</span>` : `<span class="small faint">New on Collab — no deals yet</span>`}
        <span class="row match-actions">${c.booked?.[j] ? `<button class="btn secondary compact" data-act="match-booked" data-id="${esc(c.booked[j])}" ${at}>✓ Booked — see the deal</button>` : (() => {
          // One clear next step per match: take their price when it's within your limit (the least you'd take, for
          // someone who is paid), else let agents bargain.
          const lim = c.draft.mandate?.price?.limit, price = f.fact.offer?.price?.amount, paidMe = !!c.draft.need.requesterPaid;
          const bookable = price != null && !f.over && (lim == null || (paidMe ? price >= lim : price <= lim));
          const book = `<button class="btn ${bookable ? "accent" : "quiet"} compact" data-act="match-book" data-j="${j}" ${at}>${paidMe ? "Accept" : f.fact.offer?.instant ? "Book now" : "Book"} at ${money(price, f.fact.offer?.price?.period)}</button>`;
          const negotiate = `<button class="btn ${bookable ? "quiet" : "accent"} compact" data-act="match-negotiate" data-j="${j}" ${at}>Negotiate</button>`;
          const addons = paidMe ? "" : `<button class="btn quiet compact" data-act="match-addons" data-j="${j}" ${at}>Ask about add-ons</button>`;
          return `${bookable ? book : negotiate}<details class="more match-more"><summary>More</summary><span class="row">${bookable ? negotiate : ""}${addons}</span></details>`;
        })()}
        </span></span>
    </label>`)).join("")}
    ${found.length > 3 && !c.showAll ? `<button class="btn quiet compact" data-act="matches-more" ${at}>More found · ${found.length - 3}</button><span class="small faint">Your agent recommends the three above.</span>` : ""}
    <div class="row"><button class="btn accent" data-act="brief-engage" ${at}>Ask their agents</button>${watch}<span class="small faint">Your limit and contact details are never shared.</span></div>
  </div>`;
}

// MARK: - An offering

/** What lets the seller's agent handle buyers without them — each item missing is a question that comes back to them. */
const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Hours a seller hasn't set yet: Monday to Saturday, 10 to 7, the offering's own duration if it states one. */
export const defaultHours = o => ({ days: [1, 2, 3, 4, 5, 6], from: "10:00", to: "19:00", minutes: Math.min(240, Math.max(15, Number(o?.attributes?.duration_minutes) || 60)) });
const mins = t => Number(String(t).slice(0, 2)) * 60 + Number(String(t).slice(3, 5));
export const hoursOk = h => !!h && h.days.length > 0 && h.minutes >= 10 && mins(h.to) - mins(h.from) >= h.minutes;
/** "Open Mon–Sat, 10:00–19:00" (the server says it the same way: core/resources.ts hoursText). */
export function hoursText(h) {
  const runs = [];
  for (let i = 0; i < h.days.length; i++) {
    let j = i;
    while (j + 1 < h.days.length && h.days[j + 1] === h.days[j] + 1) j++;
    runs.push(j - i >= 2 ? `${DAY[h.days[i]]}–${DAY[h.days[j]]}` : h.days.slice(i, j + 1).map(d => DAY[d]).join(", "));
    i = j;
  }
  return `Open ${h.days.length === 7 ? "every day" : runs.join(", ")}, ${h.from}–${h.to}`;
}

/** One-tap weekly hours; the days and times below can still be changed one by one. */
const HOUR_PRESETS = [["Weekdays 10–7", [1, 2, 3, 4, 5], "10:00", "19:00"], ["Mon–Sat 10–7", [1, 2, 3, 4, 5, 6], "10:00", "19:00"], ["Evenings 5–9", [1, 2, 3, 4, 5], "17:00", "21:00"], ["Weekends 9–6", [6, 0], "09:00", "18:00"], ["Every day 9–9", [0, 1, 2, 3, 4, 5, 6], "09:00", "21:00"]];
const sameHours = (h, days, from, to) => h.from === from && h.to === to && h.days.length === days.length && days.every(d => h.days.includes(d));

/** Weekly hours on the offering card: stated once, bookable times are made from them and refill as days pass. */
function hoursPick(c, at) {
  const h = c.hours ?? defaultHours(c.offer), who = listingRoles(c).responders;
  return `<div class="stack" style="gap:6px">${label(`When ${who} can book`, "sq")}
    <label class="row small" style="gap:6px"><input type="checkbox" data-edit="hours-on" ${at} ${c.hoursOn ? "checked" : ""}> Let ${esc(who)} pick a free time in my weekly hours</label>
    ${c.hoursOn ? `<div class="row" style="gap:6px">${HOUR_PRESETS.map(([name, days, from, to]) => `<button class="chip ${sameHours(h, days, from, to) ? "on" : ""}" data-act="hours-preset" data-days="${days.join(",")}" data-from="${from}" data-to="${to}" ${at}>${name}</button>`).join("")}</div>
      <div class="row">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip ${h.days.includes(d) ? "on" : ""}"><input type="checkbox" data-edit="hours-day" data-day="${d}" ${at} ${h.days.includes(d) ? "checked" : ""} style="display:none">${DAY[d]}</label>`).join("")}</div>
      <div class="row small"><input class="field compact" type="time" data-edit="hours-from" ${at} value="${esc(h.from)}" style="max-width:120px" aria-label="Opens"><span>to</span><input class="field compact" type="time" data-edit="hours-to" ${at} value="${esc(h.to)}" style="max-width:120px" aria-label="Closes">
        <input class="field compact" type="number" min="10" max="480" step="5" data-edit="hours-minutes" ${at} value="${h.minutes}" style="max-width:80px" aria-label="Minutes per booking"><span>minutes each</span></div>
      <span class="small ${hoursOk(h) ? "faint" : ""}" ${hoursOk(h) ? "" : 'style="color:var(--danger)"'}>${hoursOk(h) ? `${esc(hoursText(h))}. Free times are made two weeks ahead and refill as days pass; booked times hold. Change them anytime in About me.` : "Pick at least one day, and leave room for one booking between opening and closing."}</span>` : ""}
  </div>`;
}


function offerCard(c, at) {
  const L = listingRoles(c);
  if (c.step === "published") return `<div class="card"><div class="row">${label("Published", "sq fresh")}${tag("Public")}</div><p class="small">${esc(c.publicText)}</p><p class="small muted">Live. ${autonomyOf(c) === "close" ? `Your agent negotiates and agrees${c.floor ? ` ${L.pays ? "up" : "down"} to ${money(c.floor)} (private)` : ""} for ${c.days ?? 7} days.` : autonomyOf(c) ? `Your agent negotiates${c.floor ? ` ${L.pays ? "up" : "down"} to ${money(c.floor)} (private)` : ""}. You confirm each deal.` : "Your agent asks you before each move."}</p><div class="row"><button class="btn secondary compact" data-act="screen" data-screen="context" title="Stock, bookable hours, your terms and your agent's rules">Manage this listing</button></div></div>`;
  const o = c.offer;
  return `<div class="card" ${at}>
    <div class="row">${label(!o && c.basics ? `Offering · ${c.basics.label}` : c.photo ? "Offering · read from your photo by Gemini" : "Offering · read by Gemini", "sq accent")}${o ? `<span class="end"><b>${money(o.price.amount, o.price.period)}</b></span>` : ""}</div>
    ${c.photo ? `<img class="item-photo" src="${esc(c.photo.url)}" alt="Your photo" onerror="this.remove()">` : ""}
    ${o ? `<b>${esc(o.title)}</b><p class="small muted">${esc(o.place.name)} · ${esc(o.category.replace(/-/g, " "))}</p>
      ${Object.keys(o.attributes).length ? `<dl class="kv">${Object.entries(o.attributes).filter(([k]) => !["negotiable", "mode", "quantity"].includes(k)).map(([k, v]) => `<dt>${esc(attrLabel(k))}</dt><dd>${esc(attrValue(k, v))}</dd>`).join("")}</dl>` : ""}` : ""}
    ${!o && c.basics ? `<p class="small muted">Your ${esc(L.price)} and area are required. The rest is optional.</p>` : ""}
    ${gateBanner(c, at, "offer")}
    ${label("What the directory shows (public)")}
    <textarea class="field" data-edit="publicText" ${at} rows="3">${esc(c.publicText ?? c.text)}</textarea>
    ${!o && c.basics ? `<div class="card peri slim">${label("To list it", "peri")}
      ${pricePick(c, at)}
      <div class="row small" style="flex-wrap:nowrap"><span style="min-width:110px">Where</span><input class="field" data-edit="basic-area" ${at} value="${esc(c.basicArea ?? c.basics.area ?? "")}" placeholder="Your area, or Online"></div>
      <span class="small faint">${L.pays ? "The most you'd pay" : "The lowest you'd accept"} comes next, and stays private.</span></div>` : ""}
    ${c.missing?.length && !o && c.basics ? `<div class="stack" style="gap:8px">${label(`What ${L.responders} usually ask · Public`, "sq")}${c.missing.map(m => askRow(c, m, at)).join("")}</div>` : ""}
    ${o ? offerEssentials(c, at) : ""}
    ${o && L.pays && rolesOf(o.category).flow === "hire" ? requirementsBlock(c, at) : ""}
    ${!o && c.basics ? `<div class="row"><button class="btn accent" data-act="offer-basics" ${at}>Make the listing</button><button class="btn quiet compact" data-act="offer-publish" ${at}>Publish as a plain note</button></div>`
      : `<div class="row"><button class="btn accent" data-act="offer-publish" ${at}>Publish</button><span class="small faint">Public: discoverable by anyone's agent.</span></div>${o ? offerImprovements(c, at) : ""}`}
  </div>`;
}

/**
 * The price: what others charge for this near here (Google-grounded asking prices, the same evidence as a fair-price
 * check) as low / typical / high buttons, the typical one filled in; "Other" opens a number field. While that's being
 * looked up, or when it can't be, the field is there on its own.
 */
function pricePick(c, at) {
  const L = listingRoles(c), h = c.priceHints, per = c.basics.unit ? `<span class="faint">per ${esc(c.basics.unit)}</span>` : "";
  const picked = String(c.basicPrice ?? "");
  const field = `<div class="row small" style="flex-wrap:nowrap"><span style="min-width:110px">Your ${esc(L.price)}</span><span>₹</span><input class="field compact" type="number" min="1" data-edit="basic-price" ${at} value="${esc(picked)}" placeholder="e.g. 500" style="max-width:140px">${per}</div>`;
  if (h === null) return `${field}<span class="small faint">${logo("live spinner")} Checking what others charge near you…</span>`;
  if (!h?.typical) return field;
  const opts = [...new Set([h.low, h.typical, h.high].filter(Boolean))].map(v => [v, v === h.low && v !== h.typical ? "low" : v === h.high && v !== h.typical ? "high" : "typical"]);
  const other = c.priceOther || (picked && !opts.some(([v]) => String(v) === picked));
  return `<div class="stack" style="gap:6px"><div class="row small" style="flex-wrap:nowrap;align-items:flex-start"><span style="min-width:110px;padding-top:6px">Your ${esc(L.price)}</span>
      <div class="row" style="gap:6px">${opts.map(([v, k]) => `<button class="chip ${!other && picked === String(v) ? "on" : ""}" data-act="offer-price-pick" data-val="${v}" ${at}><b>${money(v)}</b> <span class="faint">${k}${c.basics.unit ? ` / ${esc(c.basics.unit)}` : ""}</span></button>`).join("")}<button class="chip ${other ? "on" : ""}" data-act="offer-price-pick" data-val="other" ${at}>Other…</button></div></div>
    ${other ? field : ""}
    <span class="small faint">What others near you ask, from the web${h.sources?.length ? `: ${h.sources.slice(0, 2).map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || "source")}</a>`).join(" · ")}` : ""}. Asking prices, not a fair-price promise.</span></div>`;
}

/** A listing's details in words: "age_years" → "Age", 1 → "1 year"; "in_person" → "In person". */
const ATTR = { age_years: "Age", duration_minutes: "Duration", storage_gb: "Storage", ram_gb: "RAM", size_inches: "Size", year: "Year", km_driven: "Driven" };
function attrLabel(k) { const t = ATTR[k] ?? k.replace(/_(years|minutes|gb|inches|km)$/, "").replace(/_/g, " "); return t[0].toUpperCase() + t.slice(1); }
function attrValue(k, v) {
  const n = Number(v), unit = /_years$/.test(k) ? "year" : /_minutes$/.test(k) ? "minute" : /_gb$/.test(k) ? "GB" : /_inches$/.test(k) ? "inch" : /_km$|^km_/.test(k) ? "km" : null;
  if (unit && Number.isFinite(n)) return unit === "GB" || unit === "km" ? `${n} ${unit}` : `${n} ${unit}${n === 1 ? "" : unit === "inch" ? "es" : "s"}`;
  const s = String(v).replace(/_/g, " ");
  return s[0]?.toUpperCase() + s.slice(1);
}

/** A common question's answer: tap an option; "Other…" opens a field for your own words. */
function askRow(c, m, at) {
  const ans = c.missingAnswers?.[m.label] ?? "", sug = !String(ans).trim() ? c.suggestedAnswers?.[m.label] : null;
  const own = !!c.missingOther?.[m.label] || (ans && !(m.options ?? []).includes(ans));
  // Gemini's likely answer is marked on its option (a guess says so); the owner's tap makes it theirs.
  const mark = op => (ans === op && c.fromMemory?.[m.label] ? " · from before" : sug === op ? (c.guessedAnswers?.[m.label] ? " · guess — check" : " · suggested") : "");
  const sugOwn = sug && !(m.options ?? []).includes(sug) ? `<button class="chip suggested" data-act="offer-ask-pick" data-key="${esc(m.label)}" data-val="${esc(sug)}" ${at}>${esc(String(sug).slice(0, 40))}${c.fromMemory?.[m.label] ? " · you said before" : " · suggested"}</button>` : "";
  return `<div class="stack" style="gap:4px"><span class="small"><b>${esc(m.label)}</b> · ${esc(m.ask)}</span>
    ${m.options?.length ? `<div class="row">${m.options.map(op => `<button class="chip ${ans === op ? "on" : sug === op ? "suggested" : ""}" data-act="offer-ask-pick" data-key="${esc(m.label)}" data-val="${esc(op)}" ${at}>${esc(op)}${mark(op)}</button>`).join("")}${sugOwn}<button class="chip ${own ? "on" : ""}" data-act="offer-ask-other" data-key="${esc(m.label)}" ${at}>Other…</button></div>` : ""}
    ${own || !m.options?.length ? `<input class="field" data-missing="${esc(m.label)}" data-edit="missing" data-key="${esc(m.label)}" ${at} value="${esc(own ? ans : "")}" placeholder="${m.options?.length ? "In your own words" : esc(m.ask)}">` : ""}</div>`;
}

/** What a listing needs to go live without you: the lowest you'd take (private), and how many you have or your hours. */
function offerEssentials(c, at) {
  const o = c.offer, kind = passKind({ offer: { category: o.category } }), L = listingRoles(c);
  return `<div class="card slim stack" style="gap:8px">
    <div class="row small" style="flex-wrap:nowrap"><span style="min-width:150px">${L.pays ? "Most you'd pay" : "Lowest you'll accept"}</span><input class="field compact" style="max-width:140px" type="number" min="1" data-edit="floor" value="${c.floor ?? ""}" placeholder="${esc(money(Math.round(o.price.amount * (L.pays ? 1.1 : 0.9)), null, o.price.currency).replace(/^[^\d]*/, ""))}"><span class="faint">private · empty: your agent asks you</span></div>
    ${kind === "pickup" ? `<div class="row small" style="flex-wrap:nowrap"><span style="min-width:150px">How many you have</span><input class="field compact" type="number" min="0" style="max-width:140px" data-edit="stock" ${at} value="${c.stock ?? ""}" placeholder="e.g. 5"><span class="faint">sold units come off</span></div>` : ""}
    ${kind === "booking" ? hoursPick(c, at) : ""}</div>`;
}

/**
 * Everything else that makes a listing better, after Publish and optional: each a chip (✓ once done) that opens its
 * part right here — what buyers usually ask, your terms, how your agent bargains, instant orders, similar prices,
 * and who sees what. Publishing never waits on any of them.
 */
function offerImprovements(c, at) {
  const o = c.offer, kind = passKind({ offer: { category: o.category } }), L = listingRoles(c);
  // Each part: [key, title, done, shown, what it says now] — the status line means nothing has to be opened to know.
  const answered = (c.missing ?? []).filter(m => String(c.missingAnswers?.[m.label] ?? "").trim()).length;
  const pending = (c.missing ?? []).filter(m => !String(c.missingAnswers?.[m.label] ?? "").trim() && c.suggestedAnswers?.[m.label]).length;
  const mode = { "": "Asks you every move", negotiate: "Bargains inside your limit; you confirm", close: "Bargains and agrees inside your limit" }[autonomyOf(c) || ""];
  const parts = [
    ["questions", `What ${L.responders} usually ask`, !(c.missing?.length) || answered === c.missing.length, !!c.missing?.length, `${answered} of ${c.missing?.length ?? 0} answered${pending ? ` · ${pending} suggested` : ""}`],
    ["terms", "Your terms", !!c.terms?.length, true, c.termsLoading && Date.now() - c.termsLoading < 60_000 ? "Finding what others state…" : c.terms?.length ? `${c.terms.length} set — edit any` : "None yet"],
    ["agent", "How your agent bargains", !!autonomyOf(c) || !!c.rulesOk, true, `${mode}${c.rulesOk ? " · your rules" : ""}`],
    ["instant", kind === "booking" ? "Instant booking" : "Instant orders", !!c.instant, !L.pays, c.instant ? "On — your listed price is accepted at once" : "Off — you confirm each"],
    ["prices", "Similar prices", false, !!c.insights?.length, `${c.insights?.length ?? 0} found`],
    ["privacy", "Who sees what", false, true, "Public vs private"],
  ].filter(p => p[3]);
  const open = c.openParts ?? {};
  const body = {
    questions: () => `<div class="stack" style="gap:8px">${pending ? `<div class="row"><button class="btn accent compact" data-act="offer-use-suggested" ${at}>Use these ${pending} suggested answers</button><span class="small faint">From your words, or Gemini's best guess — tap any to change</span></div>` : ""}${c.missing.map(m => askRow(c, m, at)).join("")}<span class="small faint">Public — answered once, so others' agents don't ask you.</span></div>`,
    terms: () => `<div class="stack" style="gap:6px"><span class="small muted">Shown on your card and in every receipt. Edit or clear any.</span>
      ${(c.terms ?? []).map((t, j) => `<div class="term-edit"><input class="field term-label" data-term-label data-edit="term-label" data-j="${j}" ${at} value="${esc(t.label)}" aria-label="Term name"><textarea class="field term-text" rows="2" data-term-text data-edit="term-text" data-j="${j}" ${at} aria-label="${esc(t.label)}">${esc(t.text)}</textarea></div>
        ${t.sources?.length ? `<span class="small faint">As ${esc(L.owner)}s state it: ${t.sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || "source")}</a>`).join(" · ")}</span>` : ""}`).join("")}
      ${c.starters?.length ? `<span class="small faint">Common for ${esc(o.category.replace(/-/g, " "))} — tap to add:</span><div class="row" style="gap:6px">${c.starters.map((t, j) => `<button class="chip" data-act="offer-term-add" data-j="${j}" ${at} title="${esc(t.text)}">+ ${esc(t.label)}</button>`).join("")}${c.starters.length > 1 ? `<button class="chip" data-act="offer-term-add" data-j="all" ${at}>Add all</button>` : ""}</div>` : ""}
      <div class="row"><button class="btn secondary compact" data-act="offer-suggest-terms" ${at}>${c.terms?.length ? "Suggest again" : "Suggest terms for this offering"}</button></div></div>`,
    agent: () => `<div class="stack" style="gap:6px">${autonomyPick(c)}
      <div class="row"><input class="field" style="flex:1;min-width:220px" data-edit="rulesText" ${at} value="${esc(c.rulesText ?? "")}" placeholder="Or in your words: never below ₹400, max 10 per person, close yourself above ₹420">
        <button class="btn secondary compact" data-act="offer-rules-read" ${at}>Read my rules</button></div>
      ${c.rules ? `${rulesList(c.rules.lines)}<div class="row">${c.rulesOk ? `<span class="small" style="color:var(--fresh)">✓ Applied when you publish</span>` : `<button class="btn accent compact" data-act="offer-rules-ok" ${at}>Looks right</button>`}<button class="btn quiet compact" data-act="offer-rules-clear" ${at}>Clear</button></div>` : ""}</div>`,
    instant: () => `<label class="row small" style="gap:6px"><input type="checkbox" data-instant-new data-edit="instant" ${at} ${c.instant ? "checked" : ""}> ${kind === "booking" ? "Accept bookings at my listed price automatically" : "Accept orders at my listed price automatically — no need to confirm each one"}</label>`,
    prices: () => `<div class="stack" style="gap:4px">${(c.insights ?? []).map(l => `<div class="small">${esc(l)}</div>`).join("")}</div>`,
    privacy: () => `<div class="privacy-split">
        <div>${label(`Public — ${L.responders}' agents see`, "fresh")}<span class="small">The text above, your ${esc(L.price)} (${money(o.price.amount, o.price.period)}), ${esc(o.place.name)}${c.missing?.length ? ", the details you answer" : ""}${c.hoursOn ? ", your free times" : ""} and your terms</span></div>
        <div>${label("Private — never shared", "peri")}<span class="small">${L.pays ? "The most you'd pay" : "The lowest you'll accept"}</span></div></div>`,
  };
  return `<div class="stack" style="gap:6px">${label("Improve your listing · optional", "sq")}
    <div class="improve-list">${parts.map(([k, t, done, , status]) => `<details class="improve ${done ? "done" : ""}" ${open[k] ? "open" : ""}>
      <summary data-act="offer-improve" data-k="${k}" ${at}><span class="improve-title">${done ? "✓ " : ""}${esc(t)}</span><span class="improve-status">${esc(status)}</span></summary>
      <div class="improve-body">${body[k]()}</div></details>`).join("")}</div></div>`;
}

/** A job post's requirements, read from the JD: the employer keeps, edits or adds them; applicants are screened
 *  against these (public, like the JD). */
function requirementsBlock(c, at) {
  const rs = c.offer.requirements ?? [];
  return `<div class="stack" style="gap:6px">${label("What applicants are screened against · from your JD (public)", "sq")}
    ${rs.length ? `<div class="row">${rs.map((r, j) => `<span class="chip req ${r.strength === "must" ? "on" : ""}"><button class="linkish" data-act="req-strength" data-j="${j}" ${at} title="Tap to switch must-have / nice-to-have" aria-label="${esc(r.label)}: ${esc(r.value)}, ${r.strength === "must" ? "must-have" : "nice-to-have"} — tap to switch">${esc(r.label)}: ${esc(r.value)} · ${r.strength === "must" ? "must" : "nice"}</button><button class="linkish x" data-act="req-drop" data-j="${j}" ${at} aria-label="Remove ${esc(r.label)}">×</button></span>`).join("")}</div>`
      : `<span class="small muted">No clear requirements found in your JD — add the ones that matter.</span>`}
    <div class="row"><input class="field compact" data-req-new placeholder="e.g. Skills: React, Node.js" maxlength="110" aria-label="New requirement"><button class="btn secondary compact" data-act="req-add" ${at}>Add</button></div>
    <span class="small faint">Each applicant is checked against these from what they share. Anything about age, gender, religion, caste or marital status is dropped.</span></div>`;
}

// MARK: - Context

function savedCard(c, at) {
  const f = c.fact;
  if (!f) return "";
  // Saved quietly: one line, and a small way to share it. The full controls are in About me.
  if (!c.showTiers) return `<div class="saved-line" ${at}><span class="small faint">✓ Saved to your context · ${f.tier === "public" ? "public" : f.tier === "protected" ? "shared by your rules" : "your agent uses it to answer for you"}</span>
    ${f.tier === "private" ? `<button class="linkish small" data-act="saved-tiers" ${at}>${c.suggestPublic ? "Make it public" : "Change"}</button>` : ""}</div>`;
  return `<div class="card slim" ${at}>
    <div class="row">${tierTag(f.tier, f.topics)}<span class="small">${esc(f.text)}</span></div>
    <div class="row">${label("Who sees it")}
      ${["private", "protected", "public"].map(t => `<button class="chip ${f.tier === t ? "on" : ""}" data-act="tier" data-tier="${t}" ${at}>${{ private: "Only me", protected: "People my rules name", public: "Anyone (discoverable)" }[t]}</button>`).join("")}</div>
    ${c.suggestPublic && f.tier === "private" ? `<p class="small" style="color:var(--accent)">This sounds like something you offer — make it Public so others' agents can find you.</p>` : ""}
  </div>`;
}

function sourcesCard(c, at = "") {
  if (c.found) return `<div class="card slim">${label("Your notes · found on this device", "peri")}
    ${c.answer ? `<p style="margin:0">${esc(c.answer)}</p><span class="small faint">Answered by Gemini · cloud, this once</span>` : ""}
    ${c.notes.map(n => `<div class="row">${tierTag(n.tier)}<span class="small">${esc(n.text)}</span></div>`).join("")}
    ${c.answer ? "" : `<div class="row"><button class="btn quiet compact" data-act="screen" data-screen="settings">Answer on this device (Gemma)</button>${c.cloudOk ? `<button class="btn quiet compact" data-act="notes-cloud" ${at}>Ask Gemini this once</button>` : ""}</div>`}</div>`;
  return `<div class="card slim">${label(`From your notes · ${c.engine ?? (c.on === "device" ? "Gemma · this device" : "Gemini")}`, "peri")}
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
// One journey on every card: the request (intake), finding people (matching), talking and offers (negotiation), both
// confirming and paying (confirmation), then the receipt and handover.
const STEPS = ["Intake", "Matching", "Negotiation", "Confirmation", "Receipt"];

function stepOf(e) {
  if (e.phase === "agreed" && (settled(e) || e.noPayment)) return 4;
  if (e.phase === "agreed" || e.phase === "deal") return 3;
  return 2; // a conversation exists: the request was made and they were found
}

export const stages = (at, ended = false) =>
  `<ol class="steps ${ended ? "ended" : ""}" aria-label="Progress: ${STEPS[at]}">${STEPS.map((s, i) => `<li class="${i < at ? "done" : i === at ? "now" : ""}"><span>${s}</span></li>`).join("")}</ol>`;

function stepper(e) {
  return stages(stepOf(e), ["closed", "declined"].includes(e.phase));
}

/** A resting conversation: who spoke last, and that either person can carry on. */
function openLine(e, mine, them) {
  const first = esc(shortName(them.name));
  const last = e.qa.filter(q => q.answer).at(-1);
  if (!last) return `Open — send ${first}'s agent a message below.`;
  return last.from === mine ? `${first} answered. Ask something else, or tap Done.` : `You answered ${first}. Send something back, or tap Done.`;
}

/** One sentence: what's happening now, from this owner's side. */
/** An application waiting for the employer's screening decision: nobody is talking until they shortlist, invite or decline. */
const underReview = e => e.phase === "asking" && rolesOf(e.offer?.category).flow === "hire" && e.seller === "requester" && !!e.offer?.factId
  && !e.hiring?.shortlisted && !e.hiring?.interview && !e.hiring?.rejected && e.events.some(x => /reviewing applications/.test(x.text));

function statusLine(e, mine, them, items, talking) {
  const first = shortName(them.name);
  if (underReview(e) && !items.length) return mine === "requester" ? `Application sent — waiting for ${esc(first)} to review it.` : "Applied — decide from your applicants board.";
  const mineOffers = mine === "requester" ? e.negotiation.requester : e.negotiation.provider;
  const theirOffers = mine === "requester" ? e.negotiation.provider : e.negotiation.requester;
  if (e.phase === "agreed") return `Deal agreed at <b>${dealAmount(e)}</b>.`;
  if (e.phase === "closed" || e.phase === "declined") return esc(e.events.filter(x => x.who !== "system").at(-1)?.text ?? "This conversation ended.");
  if (items.length) return items.every(i => i.owner !== session.uid) ? `${esc(first)}'s agent needs them — answer for them (demo).` : "Your agent needs you — see below.";
  if (e.phase === "deal" && rolesOf(e.offer?.category).flow === "hire") {
    // A hiring deal is settled by people: the employer's letter, then the candidate's decision.
    const l = e.offerLetter, employer = (e.seller ?? "provider") !== mine;
    if (!l) return employer ? `Salary agreed at <b>${dealAmount(e)}</b> — send the offer letter.` : `Salary agreed at <b>${dealAmount(e)}</b> — waiting for ${esc(first)}'s offer letter.`;
    if (l.status === "issued") return employer ? `Offer letter sent — waiting for ${esc(first)} to decide by ${esc(day(l.validUntil))}.` : `${esc(first)} sent you an offer letter — decide by ${esc(day(l.validUntil))}.`;
    if (l.status === "changes asked") return employer ? `${esc(first)} asked for changes — revise the offer letter.` : `You asked for changes — waiting for ${esc(first)}'s revised letter.`;
  }
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
/** How many units the agreed deal is for (line items summed, else the agreed quantity). */
const unitsOf = e => { const d = e.negotiation?.deal; return d?.items?.length ? d.items.reduce((n, l) => n + l.quantity, 0) : d?.terms?.quantity > 1 ? d.terms.quantity : 1; };

/**
 * Checkout, in the side panel: what was agreed (and what the agents saved), when and where, how the handover works,
 * and how to pay — Google Pay (its TEST environment: Google's test cards, no money moves) or in the app. Once paid it
 * turns into the confirmation, with the pass and the signed receipt.
 */
export function checkoutHTML(e) {
  if (!e?.negotiation?.deal) return `<p class="small muted">This deal isn't open any more.</p>`;
  const seller = e.seller ?? "provider", them = seller === "requester" ? e.requester : e.provider, d = e.negotiation.deal, cur = e.offer.currency;
  const qty = d.terms?.quantity > 1 ? d.terms.quantity : 1, each = d.price, listed = e.offer.price ?? null;
  const total = e.payment?.cart?.total?.value ?? (d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : each * qty);
  const saved = listed != null && listed > each ? (listed - each) * qty : 0, p = e.payment, id = esc(e.id);
  const item = esc((e.offer.title || e.title).split(" · ")[0]), where = esc(e.offer.title?.split(" · ").at(-1) ?? "As arranged");
  const slot = e.reservation?.slot ? new Date(e.reservation.slot.start * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) : null;
  const kind = passKind(e) === "booking" ? "booking" : "pickup";
  const head = `<div class="card slim"><div class="row">${avatarHTML(them.name, them.handle, 40)}<div class="stack" style="gap:2px"><b>${esc(them.name)}</b><span class="small faint">@${esc(them.handle)} · agreed by both of you</span></div></div></div>`;
  if (p?.status === "outside" && !outsideOk(e)) return `${head}<div class="card slim"><span class="small muted">Waiting for ${esc(shortName(them.name))} to confirm your payment outside the app — your pass appears once they do.</span></div>`;
  if (settled(e)) return `${head}
    <div class="card co-done"><span class="co-tick" aria-hidden="true">✓</span><b>${p.status === "paid" ? `Paid ${money(total, null, cur)}` : "Settled outside the app"}</b>
      <span class="small muted">${p.status === "paid" ? `${p.ap2?.instrument?.type === "google_pay" ? "Google Pay" : "In the app"}${p.mode === "test" ? " · demo payment, no money moved" : ""}` : "Marked as paid another way"}</span>
      <div class="row" style="justify-content:center"><button class="btn accent compact" data-act="eng-pickup" data-id="${id}">${kind === "booking" ? "Show booking pass" : "Show pickup pass"}</button><button class="btn secondary compact" data-act="eng-receipt" data-id="${id}">Receipt</button></div></div>
    <span class="small faint">Show the pass at the ${kind === "booking" ? "appointment" : "handover"}; ${esc(shortName(them.name))} marks it done. The receipt is signed — anyone can verify it.</span>`;
  if (!p) return `${head}<span class="small faint">${logo("live spinner")} ${esc(shortName(them.name))}'s agent is preparing the cart…</span>`;
  return `${head}
    ${p.outsideClaim?.deniedAt ? `<span class="small" style="color:var(--danger)">⚠ ${esc(shortName(them.name))} says your payment outside the app hasn't arrived.</span>` : ""}
    <div class="card co-order">${label("Order", "sq")}
      <div class="row"><b>${item}${qty > 1 ? ` × ${qty}` : ""}</b><span class="end">${money(each, e.offer.unit, cur)}${qty > 1 ? " each" : ""}</span></div>
      ${slot ? `<div class="row small"><span class="muted">When</span><span class="end">${esc(slot)}</span></div>` : ""}
      <div class="row small"><span class="muted">Where</span><span class="end">${where}</span></div>
      <div class="co-lines">
        ${listed != null && saved > 0 ? `<div class="row small"><span>Listed</span><span class="end">${money(listed * qty, null, cur)}</span></div><div class="row small" style="color:var(--fresh)"><span>Your agent saved</span><span class="end">− ${money(saved, null, cur)}</span></div>` : ""}
        <div class="row small"><span>Platform fee</span><span class="end">${money(0, null, cur)}</span></div>
        <div class="row co-total"><b>Total</b><b class="end">${money(total, null, cur)}</b></div></div></div>
    <div class="card co-pay">${label("Pay with", "sq")}
      ${gpayOk() === false ? `<span class="small faint">Google Pay isn't available in this browser.</span>` : `<button class="btn gpay co-gpay" data-act="eng-pay" data-gpay="1" data-id="${id}" data-amount="${total}" data-currency="${esc(cur ?? "INR")}" data-item="${item}" aria-label="Pay with Google Pay"><b>G</b> Pay</button>`}
      <button class="btn secondary" data-act="eng-pay" data-id="${id}">Pay ${money(total, null, cur)} in the app</button>
      <div class="row small faint" style="justify-content:center">${tag("Demo payment", "stale")}<span>Google Pay test cards · no money moves</span></div></div>
    <ol class="co-next small muted"><li>Pay — ${esc(shortName(them.name))}'s agent signed the cart for exactly these terms.</li><li>You get a ${kind === "booking" ? "booking" : "pickup"} pass to show at the ${kind === "booking" ? "appointment" : "handover"}.</li><li>Both of you keep a signed receipt anyone can verify.</li></ol>
    ${p.outsideClaim?.deniedAt ? "" : `<button class="btn quiet compact" data-act="eng-paid-outside" data-id="${id}">Paid another way</button>`}`;
}

export function dealAmount(e) {
  const d = e.negotiation.deal, n = d?.terms?.quantity > 1 ? d.terms.quantity : 1;
  if (!d) return "";
  if (n === 1 && !d.items?.length) return money(d.price, e.offer.unit, e.offer.currency);
  const total = d.items?.length ? d.items.reduce((t, l) => t + l.quantity * l.unitPrice, 0) : d.price * n;
  return `${money(total, null, e.offer.currency)} for ${n} (${money(Math.round((total / n) * 100) / 100, null, e.offer.currency)} each)`;
}

// MARK: - A request that reached a seller

/** On the seller's side: what the buyer asked for, at a glance, and the moves a seller usually makes next. */
function sellerRequest(e, mine) {
  if (mine !== "provider" || !["asking", "negotiating"].includes(e.phase)) return "";
  // An application to the employer's own job post is handled from the applicants board (shortlist, interview, not this time).
  if (rolesOf(e.offer.category).flow === "hire" && e.seller === "requester" && e.offer.factId) return "";
  const b = e.brief ?? {}, id = esc(e.id), P = partyRoles(e, mine), asker = partyRoles(e, "requester");
  return `<div class="card slim seller-req">
    <div class="row">${label("Their request", "sq accent")}</div>
    <b class="small">${esc(b.title ?? e.title)}</b>
    ${(b.requirements ?? []).length ? `<div class="row">${b.requirements.map(r => `<span class="chip">${esc(r.label)}: ${esc(r.value)}${r.strength === "required" ? " · must" : ""}</span>`).join("")}</div>` : ""}
    ${(b.about ?? []).length ? `<div class="row"><span class="small faint">About them:</span>${b.about.map(x => `<span class="chip">${esc(x.label)}: ${esc(x.value)}</span>`).join("")}</div>` : ""}
    <span class="small faint">${[b.area, b.mode === "online" ? "online" : b.mode === "in_person" ? "in person" : null, b.budget ? `${asker.paid ? P.price : "budget"} ${b.budget}` : `no ${asker.paid ? P.price : "budget"} given`].filter(Boolean).map(esc).join(" · ")}</span>
    <div class="row">
      ${e.offer.price != null ? `<button class="btn accent compact" data-act="seller-quote" data-id="${id}" data-price="${e.offer.price}">${P.paid ? "Offer it at" : "Offer"} ${money(e.offer.price, e.offer.unit, e.offer.currency)}</button>` : ""}
      <button class="btn secondary compact" data-act="seller-counter" data-id="${id}">Offer a ${e.offer.price != null ? "different " : ""}${esc(P.price)}</button>
      <button class="btn quiet compact" data-act="seller-ask" data-id="${id}">Ask them something</button>
      <button class="btn quiet compact" data-act="eng-close" data-id="${id}">Decline politely</button>
    </div>
    <div class="row" data-counter="${id}" hidden><input class="field compact" type="number" min="1" data-counter-price="${id}" placeholder="Your ${esc(P.price)}"><button class="btn accent compact" data-act="seller-counter-send" data-id="${id}">Send offer</button></div>
    <span class="small faint">An offer goes to them to confirm; nothing is final until both of you do. ${cap(limitWords(P.paid))} is never shown.</span>
  </div>`;
}

/** An application to a demo employer: its phone is simulated, so the candidate makes its screening decision for it. */
function demoEmployer(e, mine) {
  if (mine !== "requester" || !e.provider.uid?.startsWith("demo-") || e.phase !== "asking" || !(rolesOf(e.offer.category).flow === "hire" && e.seller === "requester" && e.offer.factId)) return "";
  if (e.hiring?.shortlisted || e.hiring?.rejected || !e.events.some(x => /reviewing applications/.test(x.text))) return "";
  const id = esc(e.id), them = esc(e.provider.name);
  return `<div class="card slim needs-card">${label(`${them}'s decision · demo`, "sq accent")}
    <span class="small muted">${them} is a demo employer — its phone is simulated, so you decide for it. A real employer shortlists from their applicants board.</span>
    <div class="row"><button class="btn accent compact" data-act="app-shortlist" data-id="${id}" data-demo="1">Shortlist me (as ${them})</button><button class="btn quiet compact" data-act="app-reject" data-id="${id}" data-demo="1">Not this time</button></div></div>`;
}

// MARK: - The receipt

// Tips by kind of deal — guidance for the buyer, never terms (the seller's own terms come from their offering).
const TIPS = {
  booking: ["Arrive a few minutes early; tell them if you're running late.", "Share any reference (a photo, a style, notes) when you arrive."],
  pickup: ["Check the item before you leave with it.", "Keep your pass private until the handover."],
  handover: ["See it in person and check the papers before the handover.", "Keep a copy of anything you sign."],
  joining: ["Get the offer in writing before your first day.", "Check the start date, hours and notice period match what you agreed."],
};

/**
 * A full receipt from the sealed deal record: who, what, when and where, the price from listed to agreed with the
 * discount, fees and taxes as they actually are, the seller's own stated terms, Collab's terms, and tips (not terms).
 * Contact details appear only if the seller chose to state them in their terms.
 */
export function receiptHTML(r, e) {
  const t = r.terms, cur = t.currency ?? "INR", qty = t.terms?.quantity > 1 ? t.terms.quantity : 1;
  const total = r.payment?.cart?.total?.value ?? t.price * qty, each = total / qty;
  // Where the price started: the listed price, or (a deal made in chat) the seller's first quote.
  const sellerSide = e?.seller === "requester" ? "requester" : "provider", buyerSide = sellerSide === "requester" ? "provider" : "requester";
  // Each side by its role (the one paid, the one paying); the terms are the listing owner's (the provider's).
  const R = rolesOf(e?.offer?.category), ownerRole = sellerSide === "provider" ? R.payee : R.payer, unpaid = !!e?.noPayment;
  const other = r.parties[e && e.requester.uid === session.uid ? "provider" : "requester"];
  const firstQuote = e?.negotiation?.[sellerSide]?.[0]?.price ?? null;
  const listed = e?.offer?.price ?? firstQuote, listedLabel = e?.offer?.price != null ? `Listed ${R.price}` : `Their first ${R.price}`;
  const discount = listed != null && listed > each ? (listed - each) * qty : 0;
  const pay = r.payment, method = pay?.status === "paid" ? (pay.ap2?.instrument?.type === "google_pay" ? "Google Pay" : "In the app")
    : pay?.status === "outside" ? "Outside the app (cash or UPI)" : "Not paid yet";
  const kind = e ? passKind(e) : "pickup", slot = e?.reservation?.slot;
  const when = s => new Date(s * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const line = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `<div class="card receipt-card">
    <div class="row">${label("Receipt", "sq ink")}<span class="small faint">#${esc(String(r.engagementId ?? e?.id ?? "").slice(-8))}</span><span class="end">${r.matches ? tag("✓ Signed record", "fresh") : tag("Changed since agreed", "danger")}</span></div>
    <dl class="kv">
      ${line(esc(cap(R.payer)), `${esc(r.parties[buyerSide].name)} <span class="faint">@${esc(r.parties[buyerSide].handle)}</span>`)}
      ${line(esc(cap(R.payee)), `${esc(r.parties[sellerSide].name)} <span class="faint">@${esc(r.parties[sellerSide].handle)}</span> · <span class="small muted">message them through Collab</span>`)}
      ${line(esc(R.item ?? (kind === "booking" ? "Service" : "Item")), `${esc(t.title.split(" · ")[0])}${qty > 1 ? ` × ${qty}` : ""}`)}
      ${slot ? line("When", esc(when(slot.start))) : ""}
      ${line("Where", `${esc(e?.offer?.title?.split(" · ").at(-1) ?? e?.brief?.area ?? "As arranged")}${unpaid ? "" : ` · ${PASS[kind].name}`}`)}
    </dl>
    <div class="breakdown">
      ${listed != null ? `<div class="row small"><span>${listedLabel}</span><span class="end">${money(listed, null, cur)}${qty > 1 ? ` × ${qty}` : ""}</span></div>` : ""}
      ${discount > 0 ? `<div class="row small" style="color:var(--fresh)"><span>Discount (negotiated)</span><span class="end">− ${money(discount, null, cur)} · ${Math.round((discount / (listed * qty)) * 100)}%</span></div>` : ""}
      <div class="row small"><span>Agreed ${esc(R.price)}</span><span class="end">${money(each, e?.offer?.unit ?? t.unit ?? null, cur)}${qty > 1 ? ` × ${qty}` : ""}</span></div>
      ${unpaid ? "" : `<div class="row small"><span>Platform fee</span><span class="end">${money(0, null, cur)}</span></div>
      <div class="row small"><span>Taxes</span><span class="end faint">as included in the ${esc(R.price)}</span></div>
      <div class="row"><b>Total</b><b class="end">${money(total, null, cur)}</b></div>`}
      <div class="row small faint"><span>Paid</span><span class="end">${esc(unpaid ? `By the ${R.payer}, as agreed — not through Collab` : method)}</span></div>
    </div>
    ${t.offerLetter ? `<div class="stack" style="gap:4px">${label("The offer letter — as accepted, sealed into this record", "sq")}${letterView({ ...t.offerLetter, currency: cur }, e)}</div>` : ""}
    ${t.policies?.length ? `<div class="stack" style="gap:4px">${label(`${cap(ownerRole)}'s terms — as they stated them`, "sq")}${t.policies.map(p => `<div class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</div>`).join("")}</div>`
      : e && e.provider.uid === session.uid ? `<span class="small muted">You haven't stated ${unpaid ? "" : "cancellation, return or warranty "}terms for this — add them to your offering in Context.</span>`
      : `<span class="small muted">The ${esc(ownerRole)} hasn't stated ${unpaid ? "" : "cancellation, return or warranty "}terms for this. Ask them before you ${unpaid ? "join" : "pay"} if it matters.</span>`}
    <div class="stack" style="gap:4px">${label("After the deal", "sq")}
      ${unpaid ? "" : (() => { const after = (t.policies ?? []).filter(p => /warrant|return|refund|re-?service|re-?trim|touch|exchange|guarantee|support|repair/i.test(`${p.label} ${p.text}`));
        return after.length ? after.map(p => `<div class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</div>`).join("")
          : `<div class="small muted">No warranty, return or re-service terms were stated for this — ask the ${esc(R.payee)} in this chat if you need them.</div>`; })()}
      ${e?.offerLetter?.status === "accepted" ? `<div class="small">${esc(joiningSummary(e))}</div>` : ""}
      <div class="small">Questions or follow-ups: message ${esc(other.name)} in this conversation.</div></div>
    <div class="stack" style="gap:4px">${label("Collab's terms", "sq")}
      <div class="small">Nothing was final until both of you confirmed; this record is signed and anyone can verify it.</div>
      ${unpaid ? `<div class="small">No money moves through Collab for this: the ${esc(R.payer)} pays the ${esc(R.price)} as agreed. It's done once the ${esc(R.payee)} marks it and the ${esc(R.payer)} confirms.</div>`
        : `<div class="small">${esc(PASS[kind].name)}: shown once at the ${kind === "booking" ? "appointment" : "handover"}; the ${esc(R.payee)} marks it ${PASS[kind].done.toLowerCase()}.</div>`}
      <div class="small">If something isn't as agreed, use “Report a problem” here — the other side sees it and it's part of the record.</div></div>
    <details class="more"><summary>Tips before you go (not terms)</summary>${((unpaid ? TIPS.joining : TIPS[kind]) ?? []).map(x => `<div class="small muted">• ${esc(x)}</div>`).join("")}</details>
  </div>`;
}

/** Joining, in one line for the record (marked after the agreement, so not part of what was signed). */
function joiningSummary(e) {
  const j = e.joining ?? { state: "awaiting", start: e.offerLetter.start }, c = e[e.seller ?? "provider"].name, emp = e[(e.seller ?? "provider") === "requester" ? "provider" : "requester"].name;
  return { confirmed: `Joined on ${day(j.joinedOn)} — marked by ${c}, confirmed by ${emp}.`, joined: `${c} says they joined on ${day(j.joinedOn)}; ${emp} hasn't confirmed yet.`,
    no_show: `${emp} says ${c} didn't join.`, disputed: `Disputed: ${c} says they joined on ${day(j.joinedOn)}, ${emp} says they didn't.`,
    withdrawn: `${j.by === (e.seller ?? "provider") ? c : emp} withdrew${j.reason ? `: “${j.reason}”` : "."}` }[j.state] ?? `Starts on ${day(j.start)} — not marked as joined yet.`;
}

/** The pass a paid deal gets, by what changes hands (the server decides the same way: core/pickup.ts passKind). */
const BOOKING = new Set(["lessons", "services", "tasks", "pets", "stays", "rides", "events", "freight", "equipment-rental", "beauty"]);
const HANDOVER = new Set(["property-rent", "commercial-lease", "property-sale", "vehicles", "jobs"]);
export const passKind = e => (e.reservation?.slotId || BOOKING.has(e.offer?.category) ? "booking" : HANDOVER.has(e.offer?.category) ? "handover" : "pickup");
export const PASS = {
  pickup: { name: "Pickup pass", sellerHint: "Scan their pickup pass with your phone camera when they collect", buyerHint: them => `Show your pickup pass to ${them} when you collect.`, done: "Collected",
    ask: "Did you collect it?", no: "No — I paid and didn't get it" },
  booking: { name: "Booking pass", sellerHint: "Scan their booking pass with your phone camera when they arrive", buyerHint: them => `Show your booking pass to ${them} when you arrive.`, done: "Checked in",
    ask: "Did it happen?", no: "No — I paid and it didn't happen" },
  handover: { name: "Handover pass", sellerHint: "Scan their handover pass with your phone camera when you hand over", buyerHint: them => `Show your handover pass to ${them} at the handover.`, done: "Handed over",
    ask: "Did they hand it over?", no: "No — I paid and didn't get it" },
};

/** Paid outside the app and the seller has it: they marked it, confirmed the buyer's word, or it predates confirming
 *  (the server decides the same way: core/pay.ts outsideConfirmed). */
export const outsideOk = e => { const p = e.payment; return p?.status === "outside" && (p.by === (e.seller ?? "provider") || !!p.confirmedAt || !p.outsideClaim); };
/** Paid in the app, or outside it with the seller's word: the pass exists and "Did you get it?" can be asked. */
export const settled = e => e.payment?.status === "paid" || outsideOk(e);
/** When the buyer can first report it wasn't handed over (the server's rule: core/reports.ts reportWindow): once it's
 *  marked handed over, else a day after paying or the end of the booked time, whichever is later. 0: not known here. */
export function reportFrom(e) {
  const p = e.payment, r = session.config.reports ?? { waitHours: 24 };
  const base = p?.status === "paid" || p?.status === "outside" ? p.paidAt : p?.outsideClaim?.deniedAt ? p.outsideClaim.at : null;
  if (base == null) return 0;
  if (e.fulfilment?.state === "delivered") return e.fulfilment.deliveredAt ?? base;
  return Math.max(base + (r.waitHours ?? 24) * 3600, e.reservation?.slot?.end ?? 0);
}
/** "Tue, 15 Oct, 6:00 pm" (or the day alone). */
export const when = (t, time = true) => new Date(t * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", ...(time ? { hour: "numeric", minute: "2-digit" } : {}) });

/** "3 of 5 left today", from the server's policy (the numbers it enforces). */
function quotaText(name) {
  const q = session.policy?.quotas?.[name];
  return q?.limit ? `${q.remaining} of ${q.limit} left today` : "private";
}

/**
 * Where a deal stands, as one tag — the same words on its card, in Your deals and anywhere else it's listed: what's
 * happening, or what's next and for whom (the seller hands over, the buyer collects or confirms).
 */
export function dealStage(e, mine = e.requester.uid === session.uid ? "requester" : "provider", needsYou = false) {
  if (needsYou && !["declined", "closed"].includes(e.phase)) return ["Needs you", "wait"];
  // A hire is settled by people: the employer's review, the offer letter, then joining.
  if (underReview(e)) return ["Under review", "peri"];
  if (e.phase === "deal" && rolesOf(e.offer?.category).flow === "hire") return ["Offer letter", "wait"];
  if (e.phase === "agreed" && e.offerLetter?.status === "accepted") return JOIN_TAG[e.joining?.state ?? "awaiting"];
  if (e.phase === "declined") return ["Declined", "danger"];
  if (e.phase === "closed") return ["Closed", ""];
  if (e.phase === "asking") return ["Agents talking", "talk"];
  if (e.phase === "negotiating") return ["Negotiating", "talk"];
  if (e.phase === "deal") return ["To confirm", "wait"];
  const seller = e.seller ?? "provider", f = e.fulfilment?.state, p = e.payment?.status, paid = settled(e);
  if (f === "accepted") return ["Completed", "fresh"];
  if (f === "disputed" && e.fulfilment.report) return [e.fulfilment.report.reason === "not_received" ? "Not received" : "Problem", "danger"];
  if (f === "disputed") return ["Problem", "danger"];
  if (f === "cancelled") return [e.fulfilment.note === "Refunded" ? "Cancelled · Refunded" : "Cancelled", ""];
  // The buyer says they paid outside the app; the seller hasn't said the money arrived yet.
  if (p === "outside" && !paid) return mine === seller ? ["Check payment", "wait"] : ["Confirming payment", "wait"];
  if (!paid && Object.values(e.outcome ?? {}).includes("fell_through")) return ["Fell through", ""];
  if (f === "delivered") return mine === seller ? ["Handed over", "peri"] : ["Confirm receipt", "wait"];
  const booking = !!e.reservation?.slotId || passKind(e) === "booking";
  if (paid) return booking ? (mine === seller ? ["Booked · check them in", "accent"] : ["Booked", "accent"]) : mine === seller ? ["Paid · hand over", "accent"] : ["Paid · collect", "accent"];
  return mine === seller ? ["Awaiting payment", "stale"] : ["To pay", "stale"];
}

export function engagementCard(e, id) {
  if (!e) return `<div class="card slim"><span class="thinking">${logo("live spinner")}<span class="small faint">Connecting to their agent…</span></span></div>`;
  const mine = e.requester.uid === session.uid ? "requester" : "provider";
  const them = mine === "requester" ? e.provider : e.requester;
  const items = live.inbox.filter(i => i.engagementId === e.id && !(i.kind === "move" && !i.question && i.owner === session.uid && !needsLimit.has(i.id)));
  const [ph, tone] = dealStage(e, mine, items.length > 0);
  const autoMove = live.inbox.some(i => i.engagementId === e.id && i.kind === "move" && !i.question && i.owner === session.uid && !needsLimit.has(i.id));
  // A conversation with nothing to negotiate (no price) rests once every question is answered: it's open for a
  // follow-up from either person, not "still talking".
  const unanswered = e.qa.some(q => q.status === "open" || q.status === "pending");
  const open = ["asking", "negotiating"].includes(e.phase) && e.offer.price == null && !e.outbox && !e.waiting?.requester && !e.waiting?.provider && !items.length && !autoMove && !unanswered;
  const talking = !open && !underReview(e) && (autoMove || !!e.outbox || (["asking", "negotiating"].includes(e.phase) && !e.waiting?.requester && !e.waiting?.provider && !items.length));
  const live_ = ["asking", "negotiating", "deal"].includes(e.phase);
  return `<div class="card eng ${items.length ? "needs-card" : ""}" data-engagement="${esc(e.id)}" data-anim="e-${esc(e.id)}" data-anim-sig="${esc(`${e.phase}:${e.negotiation.deal?.id ?? ""}:${e.payment?.status ?? ""}:${items.length}`)}">
    <div class="row eng-head">${avatarHTML(them.name, them.handle, 36)}
      <div class="eng-who"><b>${esc(them.name)}</b><span class="small faint">${mine === "requester" ? "You asked" : "Asked you"} · ${esc(e.title)}</span></div>
      <span class="end">${tag(ph, tone)}</span></div>
    ${stepper(e)}
    ${e.phase === "agreed" ? "" : `<p class="status ${talking ? "busy" : ""}">${talking ? `${logo("live spinner")}` : ""}<span>${open ? openLine(e, mine, them) : statusLine(e, mine, them, items, talking)}</span>${e.offer.price ? `<span class="end faint small">listed ${money(e.offer.price, e.offer.unit)}</span>` : ""}</p>`}
    ${items.length || e.phase === "agreed" ? "" : keyAnswer(e, mine)}
    ${items.map(inboxBlock).join("")}
    ${sellerRequest(e, mine)}
    ${demoEmployer(e, mine)}
    ${open ? `<div class="row reply"><input class="field" data-followup="${esc(e.id)}" maxlength="300" placeholder="${mine === "requester" ? "Ask" : "Message"} ${esc(shortName(them.name))}'s agent…" aria-label="Follow-up">
      <button class="btn accent compact" data-act="eng-ask" data-id="${esc(e.id)}">Send</button><button class="btn quiet compact" data-act="eng-close" data-id="${esc(e.id)}">Done</button></div>
      <span class="small faint">To make an offer, name a ${esc(partyRoles(e, mine).price)} — “${esc(offerWords(e, mine, mine === "requester" ? "₹350" : "₹400"))}”. Their agent answers within their limits, or they do; nothing is final until both of you confirm.</span>` : ""}
    ${["asking", "deal", "negotiating"].includes(e.phase) && mine === "requester" && !["paid", "outside"].includes(e.payment?.status) ? `<div><button class="btn secondary compact" data-act="price-check" data-item="${esc(priceItem(e))}" data-area="${esc(e.brief.area ?? "India")}" data-unit="${esc(e.offer?.unit ?? "")}">${(() => { const p = (mine === "requester" ? e.negotiation.provider : e.negotiation.requester).at(-1)?.price ?? e.offer?.price; return p ? `Is ${money(p, e.offer?.unit, e.offer?.currency)} fair?` : "Compare prices"; })()}</button><span class="small faint"> I'll compare with asking prices on the web · only you see them</span><div data-price-result>${priceResultHTML(priceKey(priceItem(e), e.brief.area ?? "India", e.offer?.unit))}</div></div>` : ""}
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
  if (r.state === "choose_slot") return mine === buyer
    ? `<div class="stack" data-slots="${esc(e.id)}"><span class="small">Pick a time to book it:</span><button class="btn secondary compact" data-act="slots-load" data-id="${esc(e.id)}">Show open slots</button></div>`
    : `<span class="small muted">Waiting for them to pick a time slot.</span>`;
  if (r.state === "unavailable") return `<span class="small" style="color:var(--danger)">Out of stock — ${mine === buyer ? "you can't pay until they restock; nothing was charged" : "restock to let them pay"}.</span>`;
  if (r.state === "held") return `<span class="small muted">${r.slot ? `Slot ${when(r.slot.start)} held` : `${r.qty} reserved`} until ${when(r.expiresAt)}${mine === buyer && e.payment?.status !== "outside" ? " — pay before then to keep it" : ""}.</span>`;
  if (r.state === "committed" && r.slot) return `<span class="small" style="color:var(--fresh)">✓ Booked for ${when(r.slot.start)}</span>`;
  if (r.state === "released") return `<span class="small faint">Reservation released.</span>`;
  return "";
}

/** Optional notes a buyer might send once it's agreed — fetched once per deal (Gemini writes them), then kept. */
const noteCache = new Map();
function noteIdeas(e) {
  if (!noteCache.has(e.id)) { noteCache.set(e.id, []); api(`/api/engagements/${e.id}/note-ideas`).then(r => { noteCache.set(e.id, r.notes ?? []); if (r.notes?.length) poke(); }).catch(() => {}); }
  return noteCache.get(e.id);
}

/** After agreement the two people talk directly: before paying, at pickup, after. Never blocks paying. */
function dealTalk(e, mine, buyer, them, id) {
  const chats = e.events.filter(v => v.chat).slice(-6), paid = ["paid", "outside"].includes(e.payment?.status);
  const notes = mine === buyer && !paid ? noteIdeas(e).filter(n => !chats.some(c => c.text === n)) : [];
  return `<div class="deal-chat stack" style="gap:6px">
    ${chats.map(v => `<div class="small chat-line ${v.who === mine ? "me" : ""}"><b>${v.who === mine ? "You" : them}</b> ${esc(v.text)}</div>`).join("")}
    ${notes.length ? `<div class="row">${notes.map(n => `<button class="chip" data-act="deal-note" data-id="${id}" data-text="${esc(n)}">${esc(n)}</button>`).join("")}</div>` : ""}
    <div class="row"><input class="field" style="flex:1;min-width:160px" data-deal-msg="${id}" placeholder="Message ${them}${paid ? "" : " (optional)"}"><button class="btn quiet compact" data-act="deal-msg" data-id="${id}">Send</button></div>
  </div>`;
}

function dealBlock(e, mine) {
  const p = e.payment, seller = e.seller ?? "provider", buyer = seller === "requester" ? "provider" : "requester";
  const them = esc(shortName((mine === "requester" ? e.provider : e.requester).name));
  const amount = dealAmount(e);
  // The buttons say the total to pay; the line above them says what it's for.
  const total = money(e.payment?.cart?.total?.value ?? e.negotiation.deal.price, null, e.payment?.cart?.total?.currency ?? e.offer.currency);
  const id = esc(e.id);
  // AP2: the seller's agent signed a cart for the agreed terms; the buyer pays against it (test mode: no money moves).
  // Paid isn't handed over: the buyer still says whether they got it, and can report it if not.
  const P = partyRoles(e, mine), close = P.close;
  if (e.offerLetter?.status === "accepted") return `<div class="deal">
    <details class="more"><summary>Offer letter · accepted</summary>${letterView(e.offerLetter, e)}</details>
    <div class="row"><span class="deal-price">${amount}</span><span class="small muted">${esc(close.agreed)} by both of you</span></div>
    ${pay0(e, P)}
    ${joiningBlock(e, mine, them)}
    ${(() => { const other = mine === "requester" ? "provider" : "requester", o = e[other];
      if (!o.uid?.startsWith("demo-")) return "";
      const theirs = joiningBlock(e, other, esc(shortName(e[mine].name)), true);
      return /data-act="join-/.test(theirs) ? `<div class="card slim">${label(`For ${esc(shortName(o.name))} · demo`, "sq")}<span class="small faint">Their phone is simulated in the demo — you're marking it as them.</span>${theirs}</div>` : ""; })()}
    <div class="row" data-receipt="${id}"><button class="linkish small receipt-btn" data-act="eng-receipt" data-id="${id}">Receipt ›</button></div>
  </div>`;
  let pay;
  const disputed = e.fulfilment?.state === "disputed", denied = p?.status === "awaiting" && !!p.outsideClaim?.deniedAt, k = passKind(e);
  // A deal whose money doesn't move in the app (a job's salary): no cart, no pass — it closes on joining.
  if (e.noPayment) pay = `<span class="small muted">No payment in the app — ${P.paid ? `the ${esc(P.payer)} pays the ${esc(P.price)}` : `you pay the ${esc(P.price)}`} as agreed.</span>`;
  else if (e.reservation?.state === "unavailable" && !["paid", "outside"].includes(p?.status)) pay = `<span class="small" style="color:var(--danger)">${esc(e.reservation.reason ?? "Not enough in stock.")} Nothing to pay until ${mine === seller ? "you restock" : `${them} restocks`}.</span>`;
  else if (!p) pay = `<span class="small faint">${logo("live spinner")} ${mine === seller ? "Your" : `${them}'s`} agent is preparing the cart…</span>`;
  else if (p.status === "paid") pay = `<span class="small" style="color:var(--fresh)">✓ ${p.by === mine ? "You paid" : `${them} paid`} ${amount}</span>${p.mode === "test" ? tag("Demo payment", "stale") : ""}`;
  // Cash or UPI the buyer says they paid: no pass and no stock taken until the seller says the money arrived.
  else if (p.status === "outside" && !outsideOk(e)) pay = disputed || e.fulfilment?.state === "cancelled" ? `<span class="small muted">${mine === buyer ? "You said you paid" : `${them} says they paid you`} outside the app (cash or UPI).</span>`
    // A seller who never answers: once it was due, the buyer can still report it.
    : mine === buyer ? `<div class="row"><span class="small muted">You said you paid outside the app · waiting for ${them} to confirm. Your pass appears once they do.</span>${Date.now() / 1000 >= reportFrom(e) ? `<button class="btn quiet compact" data-act="eng-report" data-id="${id}" data-reason="not_received" data-from="${reportFrom(e)}" data-them="${them}">I paid and didn't get it</button>` : ""}</div>`
    : `<div class="row"><span class="small">${them} says they paid you outside the app (cash or UPI). Did it arrive?</span><button class="btn accent compact" data-act="eng-payment-check" data-id="${id}" data-got="1" data-them="${them}">Yes, I got it</button><button class="btn quiet compact" data-act="eng-payment-check" data-id="${id}" data-got="0" data-them="${them}">Not yet</button></div>`;
  else if (p.status === "outside") pay = `<span class="small" style="color:var(--fresh)">✓ ${p.by === mine ? "You" : them} marked it paid outside the app${p.confirmedAt && p.by !== seller ? ` · ${mine === seller ? "you" : them} confirmed it arrived` : ""}</span>`;
  // A report is open (on cash the seller says never arrived): it's sorted there, not by paying now.
  else if (disputed) pay = "";
  else if (mine === buyer && e.reservation?.state === "choose_slot") pay = `<span class="small muted">Pick a time above, then pay.</span>`;
  else if (mine === buyer) pay = `${denied ? `<span class="small" style="color:var(--danger)">⚠ ${them} says your payment outside the app hasn't arrived.</span>` : ""}<div class="row"><button class="btn accent" data-act="checkout" data-id="${id}">Checkout · ${total} ›</button>${denied ? "" : `<button class="btn quiet compact" data-act="eng-paid-outside" data-id="${id}">Paid another way</button>`}${p.mode === "test" ? tag("Demo payment", "stale") : ""}${denied && Date.now() / 1000 >= reportFrom(e) ? `<button class="btn quiet compact" data-act="eng-report" data-id="${id}" data-reason="not_received" data-from="${reportFrom(e)}" data-them="${them}">I paid and didn't get it</button>` : ""}</div>`;
  else pay = `<div class="row"><span class="small muted">Waiting for ${them} to pay.</span><button class="btn quiet compact" data-act="eng-paid-outside" data-id="${id}">Got paid another way</button></div>`;
  // After payment: handover / delivery, then the buyer's acceptance — tracked apart from the payment.
  const f = e.fulfilment?.state ?? (settled(e) || e.noPayment ? "not_started" : null);
  // "No, I didn't get it": the buyer's report, which the seller can answer (refused for deals with no payment in the app).
  const report = (reason, text, from = 0) => `<button class="btn quiet compact" data-act="eng-report" data-id="${id}" data-reason="${reason}" data-from="${from}" data-them="${them}">${esc(text)}</button>`;
  let fulfil = "";
  if (f === "accepted") fulfil = `<span class="small" style="color:var(--fresh)">✓ ${mine === buyer ? "You" : them} ${esc(close.confirmedLine)}</span>`;
  else if (f === "disputed") fulfil = e.fulfilment?.report ? reportBlock(e, mine, buyer, them, id) : `<span class="small" style="color:var(--danger)">⚠ ${mine === buyer ? "You" : them} reported a problem${e.fulfilment?.note ? `: “${esc(e.fulfilment.note)}”` : ""}</span>`;
  else if (f === "delivered") fulfil = mine === buyer
    ? `<div class="row"><span class="small muted">${them} ${esc(close.markedBy)}.</span><button class="btn accent compact" data-act="eng-received" data-id="${id}" data-ok="1">${esc(close.confirm)}</button>${e.noPayment ? "" : `${report("not_received", "I didn't get it")}${report("not_as_agreed", "Not as agreed")}`}</div>`
    : `<span class="small muted">✓ ${esc(close.marked.replace(/\.$/, ""))} · waiting for ${them} to confirm</span>`;
  else if (f === "not_started") fulfil = mine === seller
    ? `<div class="row"><span class="small muted">${e.noPayment ? esc(close.todo) : `${esc(PASS[k].sellerHint)}, or`}</span><button class="btn ${e.noPayment ? "accent" : "secondary"} compact" data-act="eng-delivered" data-id="${id}">${esc(close.mark)}</button></div>`
    : e.noPayment ? `<span class="small muted">${esc(close.waiting)}</span>`
    : `<span class="small muted">${PASS[k].buyerHint(them)}</span>${settled(e) ? `<div class="row"><span class="small">${esc(PASS[k].ask)}</span><button class="btn secondary compact" data-act="eng-received" data-id="${id}" data-ok="1">${esc(close.confirm)}</button>${report("not_received", PASS[k].no, reportFrom(e))}</div>` : ""}`;
  // "It fell through" is for before paying; once it's paid, "Did you get it?" gives the seller a chance to reply first.
  const fell = e.outcome?.[mine] === "fell_through" ? `<span class="small faint">You marked it as fell through.</span>`
    : ["paid", "outside"].includes(p?.status) || ["accepted", "delivered", "disputed"].includes(f) ? "" : `<button class="linkish small faint" data-act="eng-outcome" data-id="${id}" data-happened="0">It fell through</button>`;
  return `<div class="deal">
    <div class="row"><span class="deal-price">${amount}</span><span class="small muted">${f === "cancelled" ? `cancelled${e.fulfilment?.note ? ` · ${esc(e.fulfilment.note.replace(/^Cancelled by /, "by "))}` : ""}` : `${e.noPayment ? esc(close.agreed) : "confirmed"} by both of you`}</span></div>
    ${reservationLine(e, mine, buyer)}
    ${pay}
    ${fulfil}
    ${settled(e) && !["accepted", "disputed", "cancelled"].includes(f) ? `<div data-pickup="${id}"><button class="btn secondary compact" data-act="eng-pickup" data-id="${id}">${PASS[k].name}</button></div>` : ""}
    ${dealTalk(e, mine, buyer, them, id)}
    ${mine === buyer && e.offer?.factId && settled(e) && !["cancelled", "disputed"].includes(f) ? `<div class="row"><button class="btn secondary compact" data-act="buy-again" data-id="${id}">↻ ${k === "booking" ? "Book again" : "Get it again"}</button><span class="small faint">Same thing${unitsOf(e) > 1 ? ` · ${unitsOf(e)}` : ""} from ${esc(them)}, at today's price</span></div>` : ""}
    <div class="row" data-receipt="${id}"><button class="linkish small receipt-btn" data-act="eng-receipt" data-id="${id}">Receipt ›</button><span class="end">${fell}</span></div>
  </div>`;
}

/** A seller's answer to a report, as the buyer reads it and as the seller does. */
const SAYS = { handed_over: ["says they handed it over", "you handed it over"], refunded: ["says they refunded you", "you refunded them"], never_paid: ["says they were never paid", "you were never paid"] };
const NOT_COUNTED = { guest: "guest account", new_account: "new account", demo: "demo seller" };

/**
 * A report on a paid deal ("Did you get it?" answered no): what the buyer said, the seller's one reply, and where it
 * stands. It's private for the reply time, then on the seller's record next to their reply unless it's sorted. The
 * words stay between the two; the record shows only that it was reported and how the seller answered.
 */
function reportBlock(e, mine, buyer, them, id) {
  const r = e.fulfilment.report, open = Date.now() / 1000 < r.replyBy, inTime = !!r.reply && r.reply.at <= r.replyBy, by = esc(when(r.replyBy));
  const quote = n => (n ? `: “${esc(n)}”` : "."), warn = t => `<span class="small" style="color:var(--danger)">⚠ ${t}</span>`;
  const answer = (i, x = r.reply) => `${SAYS[x.says]?.[i] ?? "replied"}${x.note ? ` — “${esc(x.note)}”` : ""}`;
  // A report that doesn't count (a guest's, a new account's, a demo seller's) still reaches the seller, but stays off the record.
  const quiet = r.counts ? "" : ` This stays between you two${NOT_COUNTED[r.notCounted] ? ` (${NOT_COUNTED[r.notCounted]})` : ""}.`;
  if (r.end) return `<span class="small muted">The report on this deal is closed.</span>`;
  if (mine === buyer) {
    const where = r.reply ? `${them} replied: ${answer(0)}.${inTime ? " Both accounts are on record." : ""}`
      : open ? `${them} has until ${by} to reply.${r.counts ? " Nothing is public yet." : ""}` : `No reply from ${them}${r.counts ? " — this shows on their record." : "."}`;
    return `<div class="stack" style="gap:6px">${warn(`${r.reason === "not_as_agreed" ? "You reported it wasn't as agreed" : "You reported you paid and didn't get it"}${quote(r.note)}`)}
      <span class="small muted">${where}${quiet}</span>
      <div class="row"><button class="btn secondary compact" data-act="eng-report-settle" data-id="${id}" data-how="got_it" data-them="${them}">Got it after all ✓</button>${r.reply?.says === "refunded" ? `<button class="btn quiet compact" data-act="eng-report-settle" data-id="${id}" data-how="refunded" data-them="${them}">Got my money back</button>` : ""}</div></div>`;
  }
  const what = warn(`${them} ${r.reason === "not_as_agreed" ? "says it wasn't as agreed" : "says they paid and didn't get it"}${quote(r.note)}`);
  if (r.reply) return `<div class="stack" style="gap:6px">${what}<span class="small" style="color:var(--fresh)">✓ You replied: ${answer(1)}</span>${!inTime && r.counts ? `<span class="small faint">It came after ${by}: ${them} sees it, but your record still shows no reply.</span>` : ""}</div>`;
  const next = open ? `Reply by ${by}${r.counts ? " — after that, people looking at your shop see it, with your reply if you give one." : "."}`
    : `No reply by ${by}${r.counts ? ` — people looking at your shop see it now. A reply still reaches ${them}, but the record stays as it is.` : "."}`;
  const says = (v, t) => `<button class="btn ${v === "handed_over" ? "secondary" : "quiet"} compact" data-act="eng-report-reply" data-id="${id}" data-says="${v}" data-them="${them}">${t}</button>`;
  return `<div class="stack" style="gap:6px">${what}
    <span class="small muted">${next}${quiet} Handing it over now? Ask ${them} to tap “Got it after all”.</span>
    <input class="field" data-report-reply="${id}" maxlength="300" placeholder="Your reply (only ${them} sees the words)" aria-label="Your reply">
    <div class="row">${says("handed_over", "I handed it over")}${says("refunded", "I refunded them")}${r.payment !== "in_app" ? says("never_paid", "I was never paid") : ""}</div></div>`;
}

const JOIN_TAG = { awaiting: ["Offer accepted", "fresh"], joined: ["Joining to confirm", "wait"], confirmed: ["Joined", "fresh"], no_show: ["Didn't join", "danger"],
  withdrawn: ["Withdrawn", ""], disputed: ["Disputed", "danger"] };
const pay0 = (e, P) => `<span class="small muted">No payment in the app — ${P.paid ? `the ${esc(P.payer)} pays the ${esc(P.price)}` : `you pay the ${esc(P.price)}`} as agreed.</span>`;

/** Today in India, "YYYY-MM-DD" — an offer's dates are calendar days where the job is (the server checks the same way). */
const todayIN = () => new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);

/**
 * After an accepted offer: the candidate marks that they joined (from the start date) or withdraws; the employer
 * confirms, says they didn't join, or withdraws the offer. Each is the person's own step, with the other side told.
 */
function joiningBlock(e, mine, them, asThem = false) {
  const j = e.joining ?? { state: "awaiting", start: e.offerLetter.start }, id = esc(e.id), as = asThem ? ` data-as="them"` : "";
  const candidate = mine === (e.seller ?? "provider"), started = todayIN() >= j.start, mineBy = j.by === mine;
  const ok = t => `<span class="small" style="color:var(--fresh)">✓ ${t}</span>`, bad = t => `<span class="small" style="color:var(--danger)">⚠ ${t}</span>`;
  const why = j.reason ? `: “${esc(j.reason)}”` : ".";
  const withdraw = `<button class="btn quiet compact" data-act="join-withdraw" data-id="${id}"${as}>${candidate ? "Withdraw — I'm not joining" : "Withdraw the offer"}</button>`;
  switch (j.state) {
    case "confirmed": return ok(candidate ? `You joined on ${esc(day(j.joinedOn))} — ${them} confirmed it.` : `${them} joined on ${esc(day(j.joinedOn))}. You confirmed it.`);
    case "disputed": return bad(`${candidate ? `You said you joined on ${esc(day(j.joinedOn))}; ${them} says you didn't` : `${them} says they joined on ${esc(day(j.joinedOn))}; you said they didn't`}${why} Both accounts are on the record — sort it out in this chat.`);
    case "withdrawn": return `<span class="small muted">${mineBy ? `You withdrew${candidate ? "" : " the offer"}` : `${them} withdrew${candidate ? " the offer" : ""}`}${why}</span>`;
    case "no_show": return candidate
      ? `<div class="stack" style="gap:6px">${bad(`${them} says you didn't join${why}`)}<div class="row"><input class="field compact" type="date" data-join-date="${id}" max="${todayIN()}" value="${todayIN()}" aria-label="The day you started"><button class="btn secondary compact" data-act="join-mark" data-id="${id}"${as}>I did join</button></div></div>`
      : `<span class="small muted">You said ${them} didn't join${why}</span>`;
    case "joined": return candidate
      ? `<span class="small muted">✓ You said you joined on ${esc(day(j.joinedOn))} · waiting for ${them} to confirm.</span>`
      : `<div class="stack" style="gap:6px"><span class="small">${them} says they joined on <b>${esc(day(j.joinedOn))}</b>.</span>
          <div class="row"><button class="btn accent compact" data-act="join-confirm" data-id="${id}"${as}>Confirm they joined ✓</button><button class="btn quiet compact" data-act="join-noshow" data-id="${id}"${as}>They didn't join</button></div></div>`;
  }
  if (!started) return `<div class="stack" style="gap:6px"><span class="small muted">${candidate ? "You start" : `${them} starts`} on <b>${esc(day(j.start))}</b>. ${candidate ? "Mark it here once you've joined." : "You can confirm it from that day."}</span><div class="row">${withdraw}</div></div>`;
  return candidate
    ? `<div class="stack" style="gap:6px"><span class="small">${j.start === todayIN() ? "Your start date is <b>today</b>. Once you've joined, mark it here." : `Your start date was <b>${esc(day(j.start))}</b>. Did you join?`}</span>
        <div class="row"><input class="field compact" type="date" data-join-date="${id}" max="${todayIN()}" value="${todayIN()}" aria-label="The day you started"><button class="btn accent compact" data-act="join-mark" data-id="${id}"${as}>I've joined</button>${withdraw}</div></div>`
    : `<div class="stack" style="gap:6px"><span class="small">${j.start === todayIN() ? `${them} starts <b>today</b>.` : `${them} was due to start on <b>${esc(day(j.start))}</b>.`}</span>
        <div class="row"><button class="btn accent compact" data-act="join-confirm" data-id="${id}"${as}>They joined ✓</button><button class="btn quiet compact" data-act="join-noshow" data-id="${id}"${as}>They didn't join</button>${withdraw}</div></div>`;
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
  const by = i.deadline ? new Date(i.deadline * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const due = i.deadline ? `<span class="small faint">${i.onTimeout === "lapse" ? `Confirm by ${by} or it lapses` : `Reply by ${by}`}</span>` : "";
  const box = (title, body) => `<div class="card slim accent" data-item="${esc(i.id)}">${label(title, "accent")}${as}${body}${due}</div>`;
  if (i.kind === "answer") {
    const d = drafts.get(i.id);
    return box(demo ? "Their agent needs them" : "Your agent needs you", `<span class="small">${i.side === "provider" ? "The requester's agent asks" : "Their agent asks"}: <b>${esc(i.question)}</b></span>
      ${d ? `<div class="card peri slim">${label(d.on === "memory" ? `You answered this before${d.about ? ` · ${esc(d.about)}` : ""}` : `Found in your private notes · ${d.on === "device" ? "on this device" : "Gemini"}`, "peri")}<span class="small">“${esc(d.text)}”</span>
        <div class="row"><button class="btn accent compact" data-act="inbox-share" data-id="${esc(i.id)}">Share this</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div></div>` : ""}
      ${!d && /^(can|could|do|does|did|is|are|will|would|have|has|should)\b/i.test(i.question ?? "") && !/\bor\b|\b(what|which|how|when|where)\b/i.test(i.question ?? "") ? `<div class="row"><button class="btn secondary compact" data-act="inbox-quick" data-id="${esc(i.id)}" data-text="Yes">Yes</button><button class="btn secondary compact" data-act="inbox-quick" data-id="${esc(i.id)}" data-text="No">No</button></div>
        <details class="more"><summary>Write my own</summary><textarea class="field" rows="2" data-reply="${esc(i.id)}" placeholder="Your answer"></textarea></details>`
        : `<textarea class="field" rows="2" data-reply="${esc(i.id)}" placeholder="${d ? "Or write your own answer" : "Your answer"}"></textarea>`}
      <div class="row"><button class="btn compact" data-act="inbox-answer" data-id="${esc(i.id)}">Send</button><button class="btn quiet compact" data-act="inbox-decline" data-id="${esc(i.id)}">I'd rather not say</button></div>
      ${demo ? "" : `<span class="small faint">Asked once: your agent answers this itself next time.</span>`}`);
  }
  if (i.kind === "approve") return box("Check before sharing", `<span class="small">Asked: <b>${esc(i.question)}</b></span>
    <div class="card slim">${label("Drafted from a Protected fact your rule covers")}<span class="small">“${esc(i.draft)}”</span></div>
    <div class="row"><button class="btn accent compact" data-act="inbox-approve" data-id="${esc(i.id)}">Share</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div>`);
  if (i.kind === "move" && !i.question && !demo && !needsLimit.has(i.id)) return `<span class="thinking small">${logo("live spinner")}<span class="faint">Your agent is making a move with your private limit…</span></span>`;
  if (i.kind === "move" && i.counter) {
    const e = live.engagements.get(i.engagementId), c = i.counter, cur = e?.offer?.currency;
    return box(`${esc(shortName(c.by))} countered`, `<span class="small"><b>${c.quantity > 1 ? `${c.quantity} × ${money(c.price, null, cur)} = ${money(c.total, null, cur)}` : money(c.price, e?.offer?.unit, cur)}</b> — take it, offer another price, or walk away.</span>
      <div class="row"><button class="btn accent compact" data-act="take-price" data-eng="${esc(i.engagementId)}" data-price="${c.price}">Accept ${c.quantity > 1 ? money(c.total, null, cur) : money(c.price, null, cur)}</button></div>
      <div class="row small"><input class="field" style="min-width:200px;flex:1" data-delegate-limit="${esc(i.engagementId)}" placeholder="${(e && i.side === (e.seller ?? "provider")) ? (c.quantity > 1 ? "Let my agent handle it — e.g. down to ₹430 each" : "Let my agent handle it — e.g. down to ₹3,200") : (c.quantity > 1 ? "Let my agent handle it — e.g. up to ₹430 each" : "Let my agent handle it — e.g. up to ₹3,200")}">
        <button class="btn secondary compact" data-act="delegate" data-id="${esc(i.engagementId)}" data-autonomy="close">Hand it over</button></div>
      <details class="more"><summary>More</summary><div class="row"><input class="field compact" type="number" min="1" style="max-width:140px" data-counter-price="${esc(i.engagementId)}" placeholder="${c.quantity > 1 ? "Your price each" : "Your price"}">
        <button class="btn secondary compact" data-act="seller-counter-send" data-id="${esc(i.engagementId)}">Counter</button>
        <button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div></details>
      <span class="small faint">Private. Your agent agrees within this, or asks you.</span><div data-rules-preview="${esc(i.engagementId)}"></div>`);
  }
  if (i.kind === "move") { const e = live.engagements.get(i.engagementId), paid = !!e && i.side === (e.seller ?? "provider");
  return box(i.question ? "No deal inside your limit yet" : "Your agent needs your limit", `${i.question ? `<span class="small">${esc(i.question)}</span>` : `<span class="small">Set ${limitWords(paid)}. It's never shared; your agent uses it for each move.</span>`}
    ${i.hint ? `<span class="small faint">${esc(i.hint)}</span>` : ""}
    <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-limit="${esc(i.id)}" placeholder="${i.listPrice ? money(i.listPrice) : "amount"}">
    <button class="btn accent compact" data-act="inbox-move" data-id="${esc(i.id)}">Keep negotiating</button>${i.side === "requester" && i.listPrice ? `<button class="btn secondary compact" data-act="take-price" data-eng="${esc(i.engagementId)}" data-price="${i.listPrice}">Take their price (${money(i.listPrice)})</button>` : ""}<button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div>`); }
  if (i.kind === "offer_letter") {
    const e = live.engagements.get(i.engagementId), l = i.letter ?? {}, id = esc(i.id), revising = !!i.question;
    const who = esc(shortName((e && (i.side === "requester" ? e.provider : e.requester)?.name) || "They"));
    const field = (k, lbl, type = "text") => `<label class="stack small" style="gap:2px;flex:1"><span class="faint">${lbl}</span><input class="field compact" type="${type}" data-letter="${id}" data-k="${k}" value="${esc(l[k] ?? "")}"${type === "text" ? ' maxlength="120"' : ""}></label>`;
    // For a demo employer, the candidate fills its letter in: the words say whose letter it is.
    const asName = demo && e ? esc(shortName(e[i.side].name)) : null, salary = money(l.salary ?? e?.negotiation?.deal?.price, e?.offer?.unit, e?.offer?.currency);
    return box(revising ? `Revise ${asName ? `${asName}'s` : "the"} offer letter` : `Send ${asName ? `${asName}'s` : "the"} offer letter`, `
      ${revising ? `<span class="small">${asName ? "You" : who} asked: <b>“${esc(i.question)}”</b> — ${asName ? `as ${asName}, change what they'd change` : "change what you're willing to"}, and send it again.</span>`
        : asName ? `<span class="small">${asName} agreed <b>${salary}</b> with you. Fill in their letter as them — then you accept or decline it as yourself.</span>`
        : `<span class="small">You agreed <b>${salary}</b> with ${who}. The letter is the offer: they accept or decline it themselves.</span>`}
      <div class="stack" style="gap:6px">${field("role", "Role")}${revising ? field("salary", `Salary${e?.offer?.unit ? ` per ${esc(e.offer.unit)}` : ""}`, "number") : ""}
        <div class="row">${field("start", "Start date", "date")}${field("validUntil", "Offer open until", "date")}</div>
        ${field("mode", "Work mode / where")}${field("probation", "Probation")}${field("notice", "Notice period")}${field("note", "A note (optional)")}</div>
      <div class="row"><button class="btn accent compact" data-act="inbox-letter-send" data-id="${id}">${revising ? "Send revised letter" : "Send offer letter"}</button>
        <button class="btn quiet compact" data-act="inbox-letter-withdraw" data-id="${id}">Don't make an offer</button></div>
      <span class="small faint">Signed by ${asName ? `${asName}'s` : "your"} agent. Nothing is agreed until ${asName ? "you accept" : "they accept"} it — ${asName ? "your" : "their"} agent can't accept it for ${asName ? "you" : "them"}.</span>`);
  }
  if (i.kind === "offer") {
    const e = live.engagements.get(i.engagementId), l = i.letter ?? {}, id = esc(i.id), asName = demo && e ? esc(shortName(e[i.side].name)) : null;
    return box(asName ? `${asName} has an offer` : "You have an offer", `${letterView(l, e)}
      <div class="row"><button class="btn accent compact" data-act="inbox-offer-accept" data-id="${id}">${asName ? `Accept as ${asName}` : "Accept offer"}</button><button class="btn quiet compact" data-act="inbox-offer-decline" data-id="${id}">${asName ? `Decline as ${asName}` : "Decline"}</button></div>
      ${l.changesAsked ? `<span class="small faint">This is their revised letter, after you asked: “${esc(l.changesAsked)}”. Accept or decline it.</span>`
        : `<div class="row"><input class="field" data-changes="${id}" maxlength="300" placeholder="Or ask for a change — e.g. a later start date"><button class="btn secondary compact" data-act="inbox-offer-changes" data-id="${id}">Ask for changes</button></div>
          <span class="small faint">${asName ? `They can ask for changes once. Only ${asName} can accept — never their agent; in the demo you decide for them.` : "You can ask for changes once. Only you can accept — never your agent."}</span>`}`);
  }
  if (i.kind === "confirm") {
    const e = live.engagements.get(i.engagementId);
    const deal = e?.negotiation.deal;
    return box(rolesOf(e?.offer?.category).close.confirmAsk, `<span class="small">${deal ? `<b>${dealAmount(e)}</b> for “${esc(e.offer?.title?.split(" · ")[0] || e.title)}”.` : ""} Nothing is final until both of you confirm.</span>
      <div class="row"><button class="btn accent compact" data-act="inbox-confirm" data-id="${esc(i.id)}">Confirm</button>
        ${e?.negotiation.chatOffer ? `<input class="field compact" type="number" min="1" style="max-width:130px" data-counter-price="${esc(i.engagementId)}" placeholder="${(e.negotiation.deal?.terms?.quantity ?? 1) > 1 ? "Counter, each" : "Counter"}"><button class="btn secondary compact" data-act="seller-counter-send" data-id="${esc(i.engagementId)}">Counter</button>` : ""}
        <button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">${e?.negotiation.chatOffer ? "Say no" : "Walk away"}</button></div>
      ${e?.negotiation.chatOffer ? `<div class="row small"><span>Let your agent decide offers like this</span><input class="field" style="min-width:220px;flex:1" data-delegate-limit="${esc(i.engagementId)}" placeholder="${i.side === (e.seller ?? "provider") ? "e.g. never below ₹400, close yourself above ₹420" : "e.g. up to ₹430, close yourself below ₹410"}">
        <button class="btn secondary compact" data-act="delegate" data-id="${esc(i.engagementId)}" data-autonomy="close">Hand it over</button><span class="faint">private · ${i.side === (e.seller ?? "provider") ? "for this offering" : "for this conversation"}</span></div><div data-rules-preview="${esc(i.engagementId)}"></div>` : ""}`);
  }
  return "";
}

export function messageHTML(m) {
  if (m.role === "user") return `<div class="msg-user" data-anim="m-${esc(m.id)}"><div class="bubble">${esc(m.text)}</div>${label(time(m.at))}</div>`;
  return `<div class="msg-agent" data-anim="m-${esc(m.id)}" data-anim-sig="${m.pending ? "p" : "d"}"><div class="row">${brand()}${label("· " + (m.engine ?? "Gemini"))}${label("· " + time(m.at))}</div>
    ${m.photo ? `<img class="item-photo" src="${esc(m.photo)}" alt="" style="max-width:220px">` : ""}
    ${m.pending === "calibrating" ? calibrating(m.photo ? ["reading the photo", "working out what it is", "writing the listing", "coming back around"] : ["reading what you said", "working out what to do", "lining things up", "coming back around"])
      : m.pending ? `<span class="thinking">${logo("live spinner")}${label(m.pending)}${dots()}</span>` : m.text ? `<div class="text">${esc(m.text)}</div>` : ""}
    ${(m.cards ?? []).map((c, i) => renderCard(c, m, i)).join("")}</div>`;
}

// MARK: - An employer's applicants (one job post)

const VERDICT_MARK = { met: ["✓", "var(--fresh)"], partial: ["◐", "var(--stale)"], unmet: ["✕", "var(--danger)"], unknown: ["?", "inherit"] };
const HIRING = { new: ["New", "accent"], shortlisted: ["Shortlisted", "fresh"], interview: ["Interview", "peri"], "in talks": ["Salary talk", "accent"], offer: ["Offer to confirm", "fresh"],
  "offer to send": ["Salary agreed — send the letter", "accent"], "offer sent": ["Offer sent", "peri"], "changes asked": ["Asked for changes", "stale"], "offer declined": ["Declined the offer", ""],
  "offer accepted": ["Offer accepted", "fresh"], "says joined": ["Says they joined — confirm", "accent"], joined: ["Joined", "fresh"], "didn't join": ["Didn't join", "danger"],
  disputed: ["Joining disputed", "danger"], "offer withdrawn": ["You withdrew the offer", ""], withdrawn: ["Withdrew", ""], rejected: ["Not taken forward", ""] };

/**
 * A job post's applicants, best fit first: each requirement checked against what they shared (hover a check for their
 * own words), and the employer's moves — shortlist (salary talk starts), invite to interview, or turn them down. The
 * agent ranks; the employer decides. Applicants never see each other or this ranking.
 */
export function applicantsBoard(b) {
  const reqs = b.job.requirements ?? [];
  return `<div class="card" data-board="${esc(b.job.id)}">
    <div class="row">${label(`Applicants · ${esc(b.job.title.split(" · ")[0])}`, "sq accent")}<span class="end small faint">${b.applicants.length}</span></div>
    ${reqs.length ? `<span class="small faint">Screened against: ${reqs.map(r => `${esc(r.label)}: ${esc(r.value)}${r.strength === "nice" ? " (nice to have)" : ""}`).join(" · ")}</span>`
      : `<span class="small muted">No requirements were read from this job post, so applicants aren't screened against it yet.</span>`}
    ${hireRecord(b)}
    ${b.applicants.map(applicantRow).join("") || `<span class="small muted">No applications yet. People looking for this kind of job find your post, and their agents apply here.</span>`}
    ${b.applicants.some(a => a.demo) ? "" : `<div class="row"><button class="btn secondary compact" data-act="demo-applicants" data-id="${esc(b.job.id)}">Try it with 4 demo applicants</button><span class="small faint">Demo candidates apply through the same flow; their phones are simulated, so you answer for them, marked demo.</span></div>`}
    <span class="small faint">Your agent ranks and checks; you decide. Salary talk starts only when you shortlist someone.</span>
  </div>`;
}

/** Who accepted an offer for this post: what was agreed, when they start, and whether they joined — each as both sides marked it. */
function hireRecord(b) {
  if (!b.hires?.length) return "";
  const joined = b.hires.filter(h => h.joining.state === "confirmed").length;
  const when = h => { const j = h.joining;
    return j.state === "confirmed" ? `joined ${esc(day(j.joinedOn))} ✓` : j.state === "joined" ? `says joined ${esc(day(j.joinedOn))} — to confirm` : j.state === "no_show" ? "didn't join"
      : j.state === "disputed" ? "joining disputed" : j.state === "withdrawn" ? `withdrawn${j.reason ? ` — “${esc(j.reason)}”` : ""}` : `starts ${esc(day(h.start))}`; };
  return `<div class="card slim" data-hires="${esc(b.job.id)}">
    <div class="row">${label("Hire record", "sq ink")}<span class="end small faint">${joined} joined · ${b.hires.length} accepted</span></div>
    ${b.hires.map(h => { const [st, tone] = HIRING[h.status] ?? [h.status, ""];
      return `<div class="row small"><b>${esc(h.name)}</b><span class="muted">${esc(h.role)} · ${money(h.salary, h.unit, h.currency)} · ${when(h)}</span><span class="end">${tag(st, tone)}</span></div>`; }).join("")}
    <span class="small faint">From the signed offer letters and what each of you marked after. The agreement itself stays sealed in each deal record.</span>
  </div>`;
}

/** Board conversations the employer opened stay open across refreshes; one that needs them opens by itself. */
const openConvos = new Set();
const NEEDS_EMPLOYER = new Set(["says joined", "offer to send", "changes asked"]);
if (typeof document !== "undefined") document.addEventListener("toggle", ev => {
  const id = ev.target?.dataset?.convo;
  if (id) ev.target.open ? openConvos.add(id) : openConvos.delete(id);
}, true);

function applicantRow(a, i) {
  const s = a.screening, id = esc(a.id), [st, tone] = HIRING[a.status] ?? [a.status, ""], e = live.engagements.get(a.id);
  const open = ["new", "shortlisted", "interview"].includes(a.status);
  return `<div class="stack applicant" style="gap:6px;border-top:1px solid var(--hairline);padding-top:8px">
    <div class="row"><span class="small faint">${i + 1}</span><span class="avatar" aria-hidden="true">${esc(a.name.slice(0, 1).toUpperCase())}</span>
      <div class="eng-who"><b>${esc(a.name)}${a.demo ? ` <span class="chip">demo</span>` : ""}</b><span class="small faint">${esc(s.summary)}${a.band ? ` · salary ${esc(a.band)}` : ""}</span></div><span class="end">${tag(st, tone)}</span></div>
    <div style="height:4px;border-radius:2px;background:var(--hairline)" role="img" aria-label="Fit ${Math.round(s.score * 100)}%"><div style="height:4px;border-radius:2px;width:${Math.round(s.score * 100)}%;background:var(--accent)"></div></div>
    ${s.checks.length ? `<div class="row">${s.checks.map(c => { const [m, color] = VERDICT_MARK[c.verdict] ?? ["?", "inherit"];
      return `<span class="chip" title="${esc(c.evidence ? `“${c.evidence}”${c.by === "gemini" ? " · checked by Gemini" : ""}` : "Not shared yet — ask them")}"><span style="color:${color}">${m}</span> ${esc(c.label)}${c.strength === "nice" ? " · nice" : ""}</span>`; }).join("")}</div>` : ""}
    ${s.note ? `<span class="small muted">${esc(s.note)}</span>` : ""}
    ${a.about?.length ? `<span class="small faint">${a.about.map(x => `${esc(x.label)}: ${esc(x.value)}`).join(" · ")}</span>` : ""}
    ${open ? `<div class="row">${a.status === "new" || a.status === "interview" ? `<button class="btn accent compact" data-act="app-shortlist" data-id="${id}">Shortlist</button>` : ""}
      ${a.status !== "interview" ? `<button class="btn secondary compact" data-act="app-interview" data-id="${id}">Invite to interview</button>` : ""}
      <button class="btn quiet compact" data-act="app-reject" data-id="${id}" data-name="${esc(shortName(a.name))}">Not this time</button></div>` : ""}
    ${e ? `<details class="more" data-convo="${id}" ${openConvos.has(a.id) || NEEDS_EMPLOYER.has(a.status) || live.inbox.some(x => x.engagementId === a.id && (x.owner === session.uid || x.owner.startsWith("demo-"))) ? "open" : ""}><summary>Conversation</summary>${engagementCard(e, e.id)}</details>` : ""}
  </div>`;
}

// MARK: - An offer letter

const day = d => (d ? new Date(`${d}T00:00:00`).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "");

/** An offer letter as both people see it: what it commits to, and who signed it. */
export function letterView(l, e) {
  const employer = e ? e[(e.seller ?? "provider") === "requester" ? "provider" : "requester"]?.name : null;
  const row = (k, v) => (v ? `<dt>${k}</dt><dd>${v}</dd>` : "");
  return `<div class="card slim">${label("Offer letter", "sq ink")}
    <dl class="kv">${row("Role", esc(l.role))}${row("Salary", money(l.salary, l.unit, l.currency ?? e?.offer?.currency))}${row("Starts", esc(day(l.start)))}${row("Work mode", esc(l.mode))}
      ${row("Probation", esc(l.probation))}${row("Notice period", esc(l.notice))}${row("Open until", esc(day(l.validUntil)))}</dl>
    ${l.note ? `<span class="small muted">“${esc(l.note)}”</span>` : ""}
    ${l.signature ? `<span class="small faint">✓ Signed by ${esc(employer ?? "the employer")}'s agent${l.revision > 1 ? ` · revision ${l.revision}` : ""}</span>` : ""}</div>`;
}
