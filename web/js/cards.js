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
import { byTag, esc, label, money, shortName, tag, tierTag, time } from "./ui.js";

const STATUS_ICON = { open: "○", pending: "◔", answered: "●", declined: "✕" };
const VERDICT = { met: tag("met", "fresh"), unmet: tag("not met", "danger"), unclear: tag("unclear", "stale") };
const SOURCE = { public: tag("Public", "fresh"), protected: tag("Protected", "accent"), owner: tag("Owner", "ink"), brief: tag("Brief"), listing: tag("Listing") };

export function renderCard(card, m, i) {
  const at = `data-msg="${esc(m.id)}" data-card="${i}"`;
  switch (card.type) {
    case "brief": return briefCard(card, at);
    case "offer": return offerCard(card, at);
    case "saved": return savedCard(card, at);
    case "sources": return sourcesCard(card, at);
    case "suggest": return `<div class="row">${card.options.map(o => `<button class="chip" data-act="send-text" data-text="${esc(o.text)}">↗ ${esc(o.label)}</button>`).join("")}<span class="small faint">${esc(card.hint ?? "Saved to your private context.")}</span></div>`;
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
  const record = recordLine(c.record, p);
  if (c.paused) return `<div class="card">${head}${record}<span class="small">${esc(p.name)} isn't taking requests right now.</span></div>`;
  if (!items.length) {
    const qs = c.suggestions?.length ? c.suggestions.map(x => x.text) : ["What are you looking for right now?", "Are you free this weekend?"];
    return `<div class="card">${head}${record}
      <span class="small faint">${first} hasn't listed anything for sale. Their agent answers from what they share and passes anything else to them.</span>
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
    <div class="offer-box" hidden><div class="row"><input class="field compact" type="number" inputmode="numeric" min="1" placeholder="Your price${it.unit && it.unit !== "each" ? ` per ${esc(it.unit)}` : it.action === "buy" ? " each" : ""} (${esc(it.currency)})" data-offer-price><input class="field compact" type="number" inputmode="numeric" min="1" placeholder="Up to (private)" data-offer-max title="Your agent negotiates and may agree up to this. Never shown to them."><button class="btn accent compact" data-act="store-offer-send" ${off}>Send offer</button></div>
      <span class="small faint">With an “up to”, your agent bargains for you and only asks you if there's no deal inside it.</span>
      <span class="small faint">${esc(shortName(p.name))}'s agent answers — it may counter. Nothing is final until both of you confirm.</span></div>
    <div class="row qs">${(it.questions ?? []).map(q => `<button class="chip" data-act="send-text" data-offer="${esc(it.factId)}" data-text="${esc(q.text)}" ${off}>${esc(q.text)}</button>`).join("")}</div>
  </div>`;
}

/**
 * A seller's record, from their registered receipts: verified sales, handovers, problems, and recent sales with each
 * receipt's fingerprint. No buyer names and no prices — those stay in the receipts the two people hold.
 */
function recordLine(r, p) {
  if (!r?.sales) return `<span class="small faint">No sales recorded on Collab yet.</span>`;
  const since = r.since ? new Date(r.since * 1000).toLocaleDateString([], { month: "short", year: "numeric" }) : "";
  return `<details class="more record"><summary>✓ ${r.verified} verified ${r.verified === 1 ? "sale" : "sales"} · ${r.handedOver} handed over${r.problems ? ` · ${r.problems} with problems` : " · no problems"}${since ? ` · since ${esc(since)}` : ""}</summary>
    ${r.recent.map(s => `<div class="row small"><span>${esc(s.item)}${s.quantity > 1 ? ` × ${s.quantity}` : ""}</span><span class="faint">${esc(s.month)}</span>${s.handedOver ? `<span style="color:var(--fresh)">handed over</span>` : s.problem ? `<span style="color:var(--danger)">problem reported</span>` : `<span class="faint">paid or pending</span>`}
      ${s.receipt ? `<code class="small faint" title="Receipt fingerprint (SHA-256), signed for them">#${esc(s.receipt.hash.slice(0, 10))}</code>` : ""}</div>`).join("")}
    <span class="small faint">From signed receipts — names and prices stay private. <a href="/public/people/${esc(p.handle)}/record" target="_blank" rel="noopener">Check the record</a></span></details>`;
}

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
function gateBanner(c, at, kind) {
  const g = c.gate;
  if (!g || g.ok || c.gateOverride) return "";
  return `<div class="card peri slim">${label(g.broad ? "Too broad for other agents to narrow down" : "A little vague for other agents to act on", "peri")}
    <span class="small muted">Answer what fits and it goes out ready — or ${kind === "offer" ? "publish" : "send"} it as it is.</span>
    ${g.missing.map((q, j) => `<div class="stack" style="gap:6px"><span class="small">${esc(q.question)}</span><div class="row">${q.options.map((o, k) => `<button class="chip ${c.gateAnswers?.[j] === o ? "on" : ""}" data-act="gate-answer" data-j="${j}" data-k="${k}" ${at}>${esc(o)}</button>`).join("")}</div></div>`).join("")}
    <div class="row"><button class="btn quiet compact" data-act="gate-override" ${at}>${kind === "offer" ? "Publish" : "Send"} as it is</button></div></div>`;
}

function briefCard(c, at) {
  const d = c.draft, s = d.shared, need = d.need;
  if (c.step === "matches") return matchesCard(c, at);
  if (c.step === "engaged") return `<div class="card"><div class="row">${label("Request sent", "sq ink")}${tag(s.title)}</div><p class="small muted">Your agent is talking to ${c.engaged.length} agent${c.engaged.length === 1 ? "" : "s"} over A2A. Their progress is below and under Requests.</p></div>`;
  const mode = { online: "Online", in_person: "In person", either: "Online or in person" }[need.mode] ?? null;
  const where = [need.place.name, need.place.name !== "Online" && need.mode !== "online" ? `within ${need.radiusKm} km` : null, mode].filter(Boolean).join(" · ");
  // What needs the owner now (Gemini's questions, the requirements, the limit) is in view; the rest is under More options.
  return `<div class="card brief" ${at}>
    ${stages(0)}
    <div class="row">${label("Request", "sq accent")}<span class="end">${tag(need.category.replace(/-/g, " "))}</span></div>
    <input class="field bare title-edit" data-edit="title" value="${esc(s.title)}" aria-label="Title">
    <textarea class="field bare" data-edit="summary" rows="2" aria-label="Summary">${esc(s.summary)}</textarea>
    <p class="small faint">📍 ${esc(where)}</p>
    ${gateBanner(c, at, "brief")}
    ${d.clarify?.length ? `<div class="card peri slim">${label("Gemini asks · tap to answer", "peri")}
      ${d.clarify.map((q, j) => `<div class="stack" style="gap:6px"><span class="small">${esc(q.question)}</span><div class="row">${q.options.map((o, k) => `<button class="chip" data-act="brief-clarify" data-j="${j}" data-k="${k}" ${at}>${esc(o)}</button>`).join("")}</div></div>`).join("")}</div>` : ""}
    ${s.requirements.length ? `<div class="row">${s.requirements.map((r, j) => `<span class="chip req ${r.strength === "required" ? "on" : ""}"><button class="linkish" data-act="brief-strength" data-j="${j}" ${at} title="Tap to switch must-have / nice-to-have">${esc(r.value)} · ${r.strength === "required" ? "must" : "nice"}</button><button class="linkish x" data-act="brief-drop" data-j="${j}" ${at} aria-label="Remove ${esc(r.label)}">×</button></span>`).join("")}</div>` : ""}
    <div class="privacy-split">
      <div>${label("Shared with them", "fresh")}<span class="small">What you need, ${esc(need.place.name)}${mode ? ` · ${esc(mode.toLowerCase())}` : ""}${s.requirements.length ? " · your must-haves" : ""}${s.budget ? ` · a price range (${esc(s.budget)})` : " · no price"}</span></div>
      <div>${label("Kept private", "peri")}<span class="small">The most you'll pay, your notes, your exact address and phone</span></div>
    </div>
    <details class="more"><summary>Exactly what their agents get</summary><dl class="kv small">
      <dt>Title</dt><dd>${esc(s.title)}</dd><dt>Details</dt><dd>${esc(s.summary)}</dd><dt>Where</dt><dd>${esc(need.place.name)}${mode ? ` · ${esc(mode.toLowerCase())}` : ""}</dd>
      ${s.requirements.length ? `<dt>Must / nice</dt><dd>${s.requirements.map(r => `${esc(r.value)} (${r.strength === "required" ? "must" : "nice"})`).join(" · ")}</dd>` : ""}
      <dt>Price</dt><dd>${s.budget ? esc(s.budget) : "Not mentioned"}</dd>${s.questions?.length ? `<dt>Asks</dt><dd>${s.questions.map(esc).join(" · ")}</dd>` : ""}</dl></details>
    <div class="row"><span class="small">Most you'll pay</span><input class="field" style="max-width:150px" type="number" min="1" data-edit="limit" value="${d.mandate?.price.limit ?? ""}" placeholder="optional">
      <span class="small faint">${s.budget ? `private · they see “${esc(s.budget)}”` : "private · never shown"}</span></div>
    <div class="stack" style="gap:6px">${label("Or tell your agent in your words", "peri")}
      <div class="row"><input class="field" style="flex:1;min-width:220px" data-edit="rulesText" ${at} value="${esc(c.rulesText ?? "")}" placeholder="e.g. up to ₹3,200, close yourself below ₹3,000, only if I can collect this weekend">
        <button class="btn secondary compact" data-act="brief-rules-read" ${at}>Read my rules</button></div>
      ${c.rules ? `${rulesList(c.rules.lines)}<div class="row">${c.rulesOk ? `<span class="small" style="color:var(--fresh)">✓ Your agent will follow these</span>` : `<button class="btn accent compact" data-act="brief-rules-ok" ${at}>Looks right</button>`}<button class="btn quiet compact" data-act="brief-rules-clear" ${at}>Clear</button></div>` : ""}</div>
    <details class="more"><summary>More options${s.questions.length ? ` · your agent will ask ${s.questions.length}` : ""}${c.insights?.length ? " · past deals" : ""}</summary>
      ${s.questions.length ? `<div class="stack" style="gap:6px">${label("Your agent will ask")}<div class="row">${s.questions.map((q, j) => `<span class="chip">${esc(q)} <button class="linkish x" data-act="brief-dropq" data-j="${j}" ${at} aria-label="Remove">×</button></span>`).join("")}</div></div>` : ""}
      <div class="stack" style="gap:6px">${label("While you're away")}${autonomyPick(c)}</div>
      ${c.insights?.length ? `<div class="stack" style="gap:4px">${label("What similar deals closed at", "peri")}${c.insights.map(l => `<div class="small">${esc(l)}</div>`).join("")}</div>` : ""}
    </details>
    <div><button class="btn secondary compact" data-act="price-check" data-item="${esc(s.title)}" data-area="${esc(need.place.name)}" data-unit="${esc(need.unit ?? "")}">Check fair price</button><span class="small faint"> Prices from the web for this item · only you see them</span><div data-price-result></div></div>
    <div class="row"><button class="btn accent" data-act="brief-send" ${at}>Find people</button><span class="small faint">Nothing is sent until you choose who.</span></div>
  </div>`;
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
  const watch = c.watching ? `<span class="small" style="color:var(--fresh)">● Your agent is watching — checks every hour for 14 days and tells you when someone new fits.</span>`
    : `<button class="btn secondary compact" data-act="watch" ${at}>Keep watching</button>`;
  if (!found.length) return `<div class="card" ${at}>${label("No one yet", "sq")}<p class="small muted">No public offering fits “${esc(c.draft.shared.title)}” yet. Try a wider area or fewer requirements — or let your agent keep looking.</p><div class="row">${watch}
      <button class="btn secondary compact" data-act="nearby" data-item="${esc(c.draft.shared.title)}" data-area="${esc(c.draft.shared.area ?? "")}">Look on Google Maps nearby</button></div><div data-nearby></div></div>`;
  return `<div class="card" ${at}>
    ${stages(1)}
    <div class="row">${label(real ? `${real} ${real === 1 ? "match" : "matches"}` : "No exact match", "sq ink")}${c.rankedByModel && real ? `<span class="small faint">ranked by Gemini</span>` : ""}${found.length > real ? `<span class="small faint">· ${found.length - real} above your budget</span>` : ""}</div>
    ${found.map((f, j) => (j >= 3 && !c.showAll ? "" : `<label class="match-row">
      <input type="checkbox" data-pick="${j}" ${c.picked?.includes(j) ? "checked" : ""} ${at}>
      <span class="avatar" aria-hidden="true">${esc(f.profile.name.slice(0, 1).toUpperCase())}</span>
      <span class="match-main"><span class="row"><b>${esc(f.profile.name)}</b>${f.profile.demo ? tag("demo") : ""}${f.profile.stats?.kept ? tag(`${f.profile.stats.kept} deal${f.profile.stats.kept === 1 ? "" : "s"} done`, "fresh") : ""}
          <span class="end">${f.fact.offer ? `<b>${money(f.fact.offer.price.amount, f.fact.offer.price.period)}</b>` : ""}</span></span>
        <span class="small muted">${esc(f.why ?? f.fact.offer?.title ?? f.fact.text.slice(0, 120))}</span>
        ${fits[j]?.length ? `<span class="small fits"><b>Fits you</b> · ${fits[j].map(r => `${esc(r.reason)} <span class="faint">— you noted “${esc(r.note)}”</span>`).join(" · ")}</span>${j === firstFit ? `<span class="small faint">From your private notes, on this device</span>` : ""}` : ""}
        ${f.over ? `<span class="small" style="color:var(--stale)">Above your budget — ticking it lets your agent try to bring the price down.</span>` : ""}
        <span class="small faint">${[f.distanceKm ? `${f.distanceKm} km` : null, ...f.met.slice(0, 2).map(x => `✓ ${x}`), f.unknown.length ? `${f.unknown.length} to ask` : null].filter(Boolean).map(esc).join(" · ")}</span>
        ${f.profile.stats?.deals ? `<span class="small faint">Track record: ${f.profile.stats.deals} deal${f.profile.stats.deals === 1 ? "" : "s"} · ${f.profile.stats.kept} completed as agreed${f.profile.stats.fellThrough ? ` · ${f.profile.stats.fellThrough} fell through` : ""}</span>` : `<span class="small faint">New on Collab — no deals yet</span>`}
        <span class="row match-actions">${c.booked?.[j] ? `<button class="btn secondary compact" data-act="match-booked" data-id="${esc(c.booked[j])}" ${at}>✓ Booked — see the deal</button>` : (() => {
          // One clear next step per seller: book at their price when it's within your limit, else let agents bargain.
          const bookable = f.fact.offer?.price?.amount != null && !f.over && (c.draft.mandate?.price?.limit == null || f.fact.offer.price.amount <= c.draft.mandate.price.limit);
          const book = `<button class="btn ${bookable ? "accent" : "quiet"} compact" data-act="match-book" data-j="${j}" ${at}>${f.fact.offer?.instant ? "Book now" : "Book"} at ${money(f.fact.offer?.price?.amount, f.fact.offer?.price?.period)}</button>`;
          const negotiate = `<button class="btn ${bookable ? "quiet" : "accent"} compact" data-act="match-negotiate" data-j="${j}" ${at}>Negotiate</button>`;
          const addons = `<button class="btn quiet compact" data-act="match-addons" data-j="${j}" ${at}>Ask about add-ons</button>`;
          return `${bookable ? book : negotiate}<details class="more match-more"><summary>More</summary><span class="row">${bookable ? negotiate : ""}${addons}</span></details>`;
        })()}
        </span></span>
    </label>`)).join("")}
    ${found.length > 3 && !c.showAll ? `<button class="btn quiet compact" data-act="matches-more" ${at}>More found · ${found.length - 3}</button><span class="small faint">Your agent recommends the three above.</span>` : ""}
    <div class="row"><button class="btn accent" data-act="brief-engage" ${at}>Ask their agents</button>${watch}<span class="small faint">Your limit and private notes are never shared.</span></div>
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

/** Weekly hours on the offering card: stated once, bookable times are made from them and refill as days pass. */
function hoursPick(c, at) {
  const h = c.hours ?? defaultHours(c.offer);
  return `<div class="stack" style="gap:6px">${label("When people can book", "sq")}
    <label class="row small" style="gap:6px"><input type="checkbox" data-edit="hours-on" ${at} ${c.hoursOn ? "checked" : ""}> Let people pick a free time in my weekly hours</label>
    ${c.hoursOn ? `<div class="row">${[1, 2, 3, 4, 5, 6, 0].map(d => `<label class="chip ${h.days.includes(d) ? "on" : ""}"><input type="checkbox" data-edit="hours-day" data-day="${d}" ${at} ${h.days.includes(d) ? "checked" : ""} style="display:none">${DAY[d]}</label>`).join("")}</div>
      <div class="row small"><input class="field compact" type="time" data-edit="hours-from" ${at} value="${esc(h.from)}" style="max-width:120px" aria-label="Opens"><span>to</span><input class="field compact" type="time" data-edit="hours-to" ${at} value="${esc(h.to)}" style="max-width:120px" aria-label="Closes">
        <input class="field compact" type="number" min="10" max="480" step="5" data-edit="hours-minutes" ${at} value="${h.minutes}" style="max-width:80px" aria-label="Minutes per booking"><span>minutes each</span></div>
      <span class="small ${hoursOk(h) ? "faint" : ""}" ${hoursOk(h) ? "" : 'style="color:var(--danger)"'}>${hoursOk(h) ? `${esc(hoursText(h))}. Free times are made two weeks ahead and refill as days pass; booked times hold. Change them anytime in About me.` : "Pick at least one day, and leave room for one booking between opening and closing."}</span>` : ""}
  </div>`;
}


function offerCard(c, at) {
  if (c.step === "published") return `<div class="card"><div class="row">${label("Published", "sq fresh")}${tag("Public")}</div><p class="small">${esc(c.publicText)}</p><p class="small muted">Live. ${autonomyOf(c) === "close" ? `Your agent negotiates and agrees${c.floor ? ` down to ${money(c.floor)} (private)` : ""} for ${c.days ?? 7} days.` : autonomyOf(c) ? `Your agent negotiates${c.floor ? ` down to ${money(c.floor)} (private)` : ""}. You confirm each deal.` : "Your agent asks you before each move."}</p><div class="row"><button class="btn quiet compact" data-act="screen" data-screen="context">Stock, hours and rules · About me</button></div></div>`;
  const o = c.offer;
  return `<div class="card" ${at}>
    <div class="row">${label(!o && c.basics ? `Offering · ${c.basics.label}` : c.photo ? "Offering · read from your photo by Gemini" : "Offering · read by Gemini", "sq accent")}${o ? `<span class="end"><b>${money(o.price.amount, o.price.period)}</b></span>` : ""}</div>
    ${c.photo ? `<img class="item-photo" src="${esc(c.photo.url)}" alt="Your photo" onerror="this.remove()">` : ""}
    ${o ? `<b>${esc(o.title)}</b><p class="small muted">${esc(o.place.name)} · ${esc(o.category.replace(/-/g, " "))}</p>
      ${Object.keys(o.attributes).length ? `<dl class="kv">${Object.entries(o.attributes).filter(([k]) => k !== "negotiable").map(([k, v]) => `<dt>${esc(k.replace(/_/g, " "))}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : ""}` : ""}
    ${!o && c.basics ? `<p class="small muted">Price and area are required. The rest is optional.</p>` : ""}
    ${gateBanner(c, at, "offer")}
    ${label("What the directory shows (public)")}
    <textarea class="field" data-edit="publicText" ${at} rows="3">${esc(c.publicText ?? c.text)}</textarea>
    ${!o && c.basics ? `<div class="card peri slim">${label("To list it", "peri")}
      <div class="row small" style="flex-wrap:nowrap"><span style="min-width:110px">Your price</span><span>₹</span><input class="field compact" type="number" min="1" data-edit="basic-price" ${at} value="${esc(c.basicPrice ?? "")}" placeholder="e.g. 500" style="max-width:140px">${c.basics.unit ? `<span class="faint">per ${esc(c.basics.unit)}</span>` : ""}</div>
      <div class="row small" style="flex-wrap:nowrap"><span style="min-width:110px">Where</span><input class="field" data-edit="basic-area" ${at} value="${esc(c.basicArea ?? c.basics.area ?? "")}" placeholder="Your area, or Online"></div>
      <span class="small faint">The lowest you'd accept comes next, and stays private.</span></div>` : ""}
    ${c.missing?.length && !o && c.basics ? `<div class="stack" style="gap:8px">${label("Common questions · Public", "sq")}${c.missing.map(m => {
      const ans = c.missingAnswers?.[m.label] ?? "";
      return `<div class="stack" style="gap:4px"><span class="small"><b>${esc(m.label)}</b> · ${esc(m.ask)}</span>
        ${m.options?.length ? `<div class="row">${m.options.map(op => `<button class="chip ${ans === op ? "on" : sug === op ? "suggested" : ""}" data-act="offer-ask-pick" data-key="${esc(m.label)}" data-val="${esc(op)}" ${at}>${esc(op)}${sug === op ? (c.guessedAnswers?.[m.label] ? " · guess — check" : " · suggested") : ""}</button>`).join("")}</div>` : ""}
        <input class="field" data-missing="${esc(m.label)}" data-edit="missing" data-key="${esc(m.label)}" ${at} value="${esc(ans)}" placeholder="${m.options?.length ? "Or type your own" : esc(m.ask)}"></div>`;
    }).join("")}</div>` : ""}
    ${o ? offerEssentials(c, at) : ""}
    ${!o && c.basics ? `<div class="row"><button class="btn accent" data-act="offer-basics" ${at}>Make the listing</button><button class="btn quiet compact" data-act="offer-publish" ${at}>Publish as a plain note</button></div>`
      : `<div class="row"><button class="btn accent" data-act="offer-publish" ${at}>Publish</button><span class="small faint">Public: discoverable by anyone's agent.</span></div>${o ? offerImprovements(c, at) : ""}`}
  </div>`;
}

/** What a listing needs to go live without you: the lowest you'd take (private), and how many you have or your hours. */
function offerEssentials(c, at) {
  const o = c.offer, kind = passKind({ offer: { category: o.category } });
  return `<div class="card slim stack" style="gap:8px">
    <div class="row small" style="flex-wrap:nowrap"><span style="min-width:150px">Lowest you'll accept</span><input class="field compact" style="max-width:140px" type="number" min="1" data-edit="floor" value="${c.floor ?? o.price.amount}"><span class="faint">private</span></div>
    ${kind === "pickup" ? `<div class="row small" style="flex-wrap:nowrap"><span style="min-width:150px">How many you have</span><input class="field compact" type="number" min="0" style="max-width:140px" data-edit="stock" ${at} value="${c.stock ?? ""}" placeholder="e.g. 5"><span class="faint">sold units come off</span></div>` : ""}
    ${kind === "booking" ? hoursPick(c, at) : ""}</div>`;
}

/**
 * Everything else that makes a listing better, after Publish and optional: each a chip (✓ once done) that opens its
 * part right here — what buyers usually ask, your terms, how your agent bargains, instant orders, similar prices,
 * and who sees what. Publishing never waits on any of them.
 */
function offerImprovements(c, at) {
  const o = c.offer, kind = passKind({ offer: { category: o.category } });
  // Each part: [key, title, done, shown, what it says now] — the status line means nothing has to be opened to know.
  const answered = (c.missing ?? []).filter(m => String(c.missingAnswers?.[m.label] ?? "").trim()).length;
  const pending = (c.missing ?? []).filter(m => !String(c.missingAnswers?.[m.label] ?? "").trim() && c.suggestedAnswers?.[m.label]).length;
  const mode = { "": "Asks you every move", negotiate: "Bargains inside your limit; you confirm", close: "Bargains and agrees inside your limit" }[autonomyOf(c) || ""];
  const parts = [
    ["questions", "Common questions", !(c.missing?.length) || answered === c.missing.length, !!c.missing?.length, `${answered} of ${c.missing?.length ?? 0} answered${pending ? ` · ${pending} suggested` : ""}`],
    ["terms", "Your terms", !!c.terms?.length, true, c.termsLoading && Date.now() - c.termsLoading < 60_000 ? "Finding what others state…" : c.terms?.length ? `${c.terms.length} set — edit any` : "None yet"],
    ["agent", "How your agent bargains", !!autonomyOf(c) || !!c.rulesOk, true, `${mode}${c.rulesOk ? " · your rules" : ""}`],
    ["instant", kind === "booking" ? "Instant booking" : "Instant orders", !!c.instant, true, c.instant ? "On — your listed price is accepted at once" : "Off — you confirm each"],
    ["prices", "Similar prices", false, !!c.insights?.length, `${c.insights?.length ?? 0} found`],
    ["privacy", "Who sees what", false, true, "Public vs private"],
  ].filter(p => p[3]);
  const open = c.openParts ?? {};
  const body = {
    questions: () => `<div class="stack" style="gap:8px">${pending ? `<div class="row"><button class="btn accent compact" data-act="offer-use-suggested" ${at}>Use these ${pending} suggested answers</button><span class="small faint">From your words, or Gemini's best guess — tap any to change</span></div>` : ""}${c.missing.map(m => {
      const ans = c.missingAnswers?.[m.label] ?? "", sug = !String(ans).trim() ? c.suggestedAnswers?.[m.label] : null;
      return `<div class="stack" style="gap:4px"><span class="small"><b>${esc(m.label)}</b> · ${esc(m.ask)}</span>
        ${m.options?.length ? `<div class="row">${m.options.map(op => `<button class="chip ${ans === op ? "on" : ""}" data-act="offer-ask-pick" data-key="${esc(m.label)}" data-val="${esc(op)}" ${at}>${esc(op)}</button>`).join("")}</div>` : ""}
        <input class="field" data-missing="${esc(m.label)}" data-edit="missing" data-key="${esc(m.label)}" ${at} value="${esc(ans)}" placeholder="${m.options?.length ? "Or type your own" : esc(m.ask)}"></div>`;
    }).join("")}<span class="small faint">Public — answered once, so others' agents don't ask you.</span></div>`,
    terms: () => `<div class="stack" style="gap:6px"><span class="small muted">Shown on your card and in every receipt. Edit or clear any.</span>
      ${(c.terms ?? []).map((t, j) => `<div class="term-edit"><input class="field term-label" data-term-label data-edit="term-label" data-j="${j}" ${at} value="${esc(t.label)}" aria-label="Term name"><textarea class="field term-text" rows="2" data-term-text data-edit="term-text" data-j="${j}" ${at} aria-label="${esc(t.label)}">${esc(t.text)}</textarea></div>
        ${t.sources?.length ? `<span class="small faint">As others state it: ${t.sources.map(x => `<a href="${esc(x.url)}" target="_blank" rel="noopener noreferrer">${esc(x.title || "source")}</a>`).join(" · ")}</span>` : ""}`).join("")}
      <div class="row"><button class="btn secondary compact" data-act="offer-suggest-terms" ${at}>${c.terms?.length ? "Suggest again" : "Suggest terms for this offering"}</button></div></div>`,
    agent: () => `<div class="stack" style="gap:6px">${autonomyPick(c)}
      <div class="row"><input class="field" style="flex:1;min-width:220px" data-edit="rulesText" ${at} value="${esc(c.rulesText ?? "")}" placeholder="Or in your words: never below ₹400, max 10 per person, close yourself above ₹420">
        <button class="btn secondary compact" data-act="offer-rules-read" ${at}>Read my rules</button></div>
      ${c.rules ? `${rulesList(c.rules.lines)}<div class="row">${c.rulesOk ? `<span class="small" style="color:var(--fresh)">✓ Applied when you publish</span>` : `<button class="btn accent compact" data-act="offer-rules-ok" ${at}>Looks right</button>`}<button class="btn quiet compact" data-act="offer-rules-clear" ${at}>Clear</button></div>` : ""}</div>`,
    instant: () => `<label class="row small" style="gap:6px"><input type="checkbox" data-instant-new data-edit="instant" ${at} ${c.instant ? "checked" : ""}> ${kind === "booking" ? "Accept bookings at my listed price automatically" : "Accept orders at my listed price automatically — no need to confirm each one"}</label>`,
    prices: () => `<div class="stack" style="gap:4px">${(c.insights ?? []).map(l => `<div class="small">${esc(l)}</div>`).join("")}</div>`,
    privacy: () => `<div class="privacy-split">
        <div>${label("Public — others' agents see", "fresh")}<span class="small">The text above, your price (${money(o.price.amount, o.price.period)}), ${esc(o.place.name)}${c.missing?.length ? ", the details you answer" : ""}${c.hoursOn ? ", your free times" : ""} and your terms</span></div>
        <div>${label("Private — never shared", "peri")}<span class="small">The lowest you'll accept, and your private notes</span></div></div>`,
  };
  return `<div class="stack" style="gap:6px">${label("Improve your listing · optional", "sq")}
    <div class="improve-list">${parts.map(([k, t, done, , status]) => `<details class="improve ${done ? "done" : ""}" ${open[k] ? "open" : ""}>
      <summary data-act="offer-improve" data-k="${k}" ${at}><span class="improve-title">${done ? "✓ " : ""}${esc(t)}</span><span class="improve-status">${esc(status)}</span></summary>
      <div class="improve-body">${body[k]()}</div></details>`).join("")}</div></div>`;
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
  if (e.phase === "agreed" && ["paid", "outside"].includes(e.payment?.status)) return 4;
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
/** How many units the agreed deal is for (line items summed, else the agreed quantity). */
const unitsOf = e => { const d = e.negotiation?.deal; return d?.items?.length ? d.items.reduce((n, l) => n + l.quantity, 0) : d?.terms?.quantity > 1 ? d.terms.quantity : 1; };

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
  const b = e.brief ?? {}, id = esc(e.id);
  return `<div class="card slim seller-req">
    <div class="row">${label("Their request", "sq accent")}</div>
    <b class="small">${esc(b.title ?? e.title)}</b>
    ${(b.requirements ?? []).length ? `<div class="row">${b.requirements.map(r => `<span class="chip">${esc(r.label)}: ${esc(r.value)}${r.strength === "required" ? " · must" : ""}</span>`).join("")}</div>` : ""}
    <span class="small faint">${[b.area, b.mode === "online" ? "online" : b.mode === "in_person" ? "in person" : null, b.budget ? `budget ${b.budget}` : "no budget given"].filter(Boolean).map(esc).join(" · ")}</span>
    <div class="row">
      ${e.offer.price != null ? `<button class="btn accent compact" data-act="seller-quote" data-id="${id}" data-price="${e.offer.price}">Offer it at ${money(e.offer.price, e.offer.unit, e.offer.currency)}</button>` : ""}
      <button class="btn secondary compact" data-act="seller-counter" data-id="${id}">Offer a ${e.offer.price != null ? "different " : ""}price</button>
      <button class="btn quiet compact" data-act="seller-ask" data-id="${id}">Ask them something</button>
      <button class="btn quiet compact" data-act="eng-close" data-id="${id}">Decline politely</button>
    </div>
    <div class="row" data-counter="${id}" hidden><input class="field compact" type="number" min="1" data-counter-price="${id}" placeholder="Your price"><button class="btn accent compact" data-act="seller-counter-send" data-id="${id}">Send offer</button></div>
    <span class="small faint">An offer goes to them to confirm; nothing is final until both of you do. Your lowest price is never shown.</span>
  </div>`;
}

// MARK: - The receipt

// Tips by kind of deal — guidance for the buyer, never terms (the seller's own terms come from their offering).
const TIPS = {
  booking: ["Arrive a few minutes early; tell them if you're running late.", "Share any reference (a photo, a style, notes) when you arrive."],
  pickup: ["Check the item before you leave with it.", "Keep your pass private until the handover."],
  handover: ["See it in person and check the papers before the handover.", "Keep a copy of anything you sign."],
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
  const sellerSide = e?.seller === "requester" ? "requester" : "provider";
  const firstQuote = e?.negotiation?.[sellerSide]?.[0]?.price ?? null;
  const listed = e?.offer?.price ?? firstQuote, listedLabel = e?.offer?.price != null ? "Listed price" : "Their first price";
  const discount = listed != null && listed > each ? (listed - each) * qty : 0;
  const pay = r.payment, method = pay?.status === "paid" ? (pay.ap2?.instrument?.type === "google_pay" ? "Google Pay" : "In the app")
    : pay?.status === "outside" ? "Outside the app (cash or UPI)" : "Not paid yet";
  const kind = e ? passKind(e) : "pickup", slot = e?.reservation?.slot;
  const when = s => new Date(s * 1000).toLocaleString([], { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  const line = (k, v) => `<dt>${k}</dt><dd>${v}</dd>`;
  return `<div class="card receipt-card">
    <div class="row">${label("Receipt", "sq ink")}<span class="small faint">#${esc(String(r.engagementId ?? e?.id ?? "").slice(-8))}</span><span class="end">${r.matches ? tag("✓ Signed record", "fresh") : tag("Changed since agreed", "danger")}</span></div>
    <dl class="kv">
      ${line("For", `${esc(r.parties[e?.seller === "requester" ? "provider" : "requester"].name)} <span class="faint">@${esc(r.parties[e?.seller === "requester" ? "provider" : "requester"].handle)}</span>`)}
      ${line("From", `${esc(r.parties[e?.seller === "requester" ? "requester" : "provider"].name)} <span class="faint">@${esc(r.parties[e?.seller === "requester" ? "requester" : "provider"].handle)}</span> · <span class="small muted">message them through Collab</span>`)}
      ${line(kind === "booking" ? "Service" : "Item", `${esc(t.title.split(" · ")[0])}${qty > 1 ? ` × ${qty}` : ""}`)}
      ${slot ? line("When", esc(when(slot.start))) : ""}
      ${line("Where", `${esc(e?.offer?.title?.split(" · ").at(-1) ?? e?.brief?.area ?? "As arranged")} · ${PASS[kind].name}`)}
    </dl>
    <div class="breakdown">
      ${listed != null ? `<div class="row small"><span>${listedLabel}</span><span class="end">${money(listed, null, cur)}${qty > 1 ? ` × ${qty}` : ""}</span></div>` : ""}
      ${discount > 0 ? `<div class="row small" style="color:var(--fresh)"><span>Discount (negotiated)</span><span class="end">− ${money(discount, null, cur)} · ${Math.round((discount / (listed * qty)) * 100)}%</span></div>` : ""}
      <div class="row small"><span>Agreed price</span><span class="end">${money(each, null, cur)}${qty > 1 ? ` × ${qty}` : ""}</span></div>
      <div class="row small"><span>Platform fee</span><span class="end">${money(0, null, cur)}</span></div>
      <div class="row small"><span>Taxes</span><span class="end faint">as included in the price</span></div>
      <div class="row"><b>Total</b><b class="end">${money(total, null, cur)}</b></div>
      <div class="row small faint"><span>Paid</span><span class="end">${esc(method)}</span></div>
    </div>
    ${t.policies?.length ? `<div class="stack" style="gap:4px">${label("Their terms — as stated", "sq")}${t.policies.map(p => `<div class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</div>`).join("")}</div>`
      : `<span class="small muted">No cancellation, return or warranty terms were stated for this. Ask them before you pay if it matters.</span>`}
    <div class="stack" style="gap:4px">${label("After you buy", "sq")}
      ${(() => { const after = (t.policies ?? []).filter(p => /warrant|return|refund|re-?service|re-?trim|touch|exchange|guarantee|support|repair/i.test(`${p.label} ${p.text}`));
        return after.length ? after.map(p => `<div class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</div>`).join("")
          : `<div class="small muted">No warranty, return or re-service terms were stated for this — ask them in this chat if you need them.</div>`; })()}
      <div class="small">Questions or follow-ups: message ${esc(r.parties[e?.seller === "requester" ? "requester" : "provider"].name)} in this conversation.</div></div>
    <div class="stack" style="gap:4px">${label("Collab's terms", "sq")}
      <div class="small">Nothing was final until both of you confirmed; this record is signed and anyone can verify it.</div>
      <div class="small">${esc(PASS[kind].name)}: shown once at the ${kind === "booking" ? "appointment" : "handover"}; they mark it ${PASS[kind].done.toLowerCase()}.</div>
      <div class="small">If something isn't as agreed, use “Report a problem” here — they see it and it's part of the record.</div></div>
    <details class="more"><summary>Tips before you go (not terms)</summary>${(TIPS[kind] ?? []).map(x => `<div class="small muted">• ${esc(x)}</div>`).join("")}</details>
  </div>`;
}

/** The pass a paid deal gets, by what changes hands (the server decides the same way: core/pickup.ts passKind). */
const BOOKING = new Set(["lessons", "services", "tasks", "pets", "stays", "rides", "events", "freight", "equipment-rental", "beauty"]);
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

/**
 * Where a deal stands, as one tag — the same words on its card, in Your deals and anywhere else it's listed: what's
 * happening, or what's next and for whom (the seller hands over, the buyer collects or confirms).
 */
export function dealStage(e, mine = e.requester.uid === session.uid ? "requester" : "provider", needsYou = false) {
  if (needsYou && !["declined", "closed"].includes(e.phase)) return ["Needs you", "wait"];
  if (e.phase === "declined") return ["Declined", "danger"];
  if (e.phase === "closed") return ["Closed", ""];
  if (e.phase === "asking") return ["Agents talking", "talk"];
  if (e.phase === "negotiating") return ["Negotiating", "talk"];
  if (e.phase === "deal") return ["To confirm", "wait"];
  const seller = e.seller ?? "provider", f = e.fulfilment?.state, p = e.payment?.status, paid = p === "paid" || p === "outside";
  if (f === "accepted") return ["Completed", "fresh"];
  if (f === "disputed") return ["Problem", "danger"];
  if (f === "cancelled") return ["Cancelled", ""];
  if (!paid && Object.values(e.outcome ?? {}).includes("fell_through")) return ["Fell through", ""];
  if (f === "delivered") return mine === seller ? ["Handed over", "peri"] : ["Confirm receipt", "wait"];
  if (paid) return mine === seller ? ["Paid · hand over", "accent"] : ["Paid · collect", "accent"];
  return mine === seller ? ["Awaiting payment", "stale"] : ["To pay", "stale"];
}

export function engagementCard(e, id) {
  if (!e) return `<div class="card slim"><span class="thinking"><span class="spinner"></span><span class="small faint">Connecting to their agent…</span></span></div>`;
  const mine = e.requester.uid === session.uid ? "requester" : "provider";
  const them = mine === "requester" ? e.provider : e.requester;
  const items = live.inbox.filter(i => i.engagementId === e.id && !(i.kind === "move" && !i.question && i.owner === session.uid && !needsLimit.has(i.id)));
  const [ph, tone] = dealStage(e, mine, items.length > 0);
  const autoMove = live.inbox.some(i => i.engagementId === e.id && i.kind === "move" && !i.question && i.owner === session.uid && !needsLimit.has(i.id));
  // A conversation with nothing to negotiate (no price) rests once every question is answered: it's open for a
  // follow-up from either person, not "still talking".
  const unanswered = e.qa.some(q => q.status === "open" || q.status === "pending");
  const open = ["asking", "negotiating"].includes(e.phase) && e.offer.price == null && !e.outbox && !e.waiting?.requester && !e.waiting?.provider && !items.length && !autoMove && !unanswered;
  const talking = !open && (autoMove || !!e.outbox || (["asking", "negotiating"].includes(e.phase) && !e.waiting?.requester && !e.waiting?.provider && !items.length));
  const live_ = ["asking", "negotiating", "deal"].includes(e.phase);
  return `<div class="card eng ${items.length ? "needs-card" : ""}" data-engagement="${esc(e.id)}" data-anim="e-${esc(e.id)}" data-anim-sig="${esc(`${e.phase}:${e.negotiation.deal?.id ?? ""}:${e.payment?.status ?? ""}:${items.length}`)}">
    <div class="row eng-head"><span class="avatar" aria-hidden="true">${esc(them.name.slice(0, 1).toUpperCase())}</span>
      <div class="eng-who"><b>${esc(them.name)}</b><span class="small faint">${mine === "requester" ? "You asked" : "Asked you"} · ${esc(e.title)}</span></div>
      <span class="end">${tag(ph, tone)}</span></div>
    ${stepper(e)}
    ${e.phase === "agreed" ? "" : `<p class="status ${talking ? "busy" : ""}">${talking ? `<span class="spinner"></span>` : ""}<span>${open ? openLine(e, mine, them) : statusLine(e, mine, them, items, talking)}</span>${e.offer.price ? `<span class="end faint small">listed ${money(e.offer.price, e.offer.unit)}</span>` : ""}</p>`}
    ${items.length || e.phase === "agreed" ? "" : keyAnswer(e, mine)}
    ${items.map(inboxBlock).join("")}
    ${sellerRequest(e, mine)}
    ${open ? `<div class="row reply"><input class="field" data-followup="${esc(e.id)}" maxlength="300" placeholder="${mine === "requester" ? "Ask" : "Message"} ${esc(shortName(them.name))}'s agent…" aria-label="Follow-up">
      <button class="btn accent compact" data-act="eng-ask" data-id="${esc(e.id)}">Send</button><button class="btn quiet compact" data-act="eng-close" data-id="${esc(e.id)}">Done</button></div>
      <span class="small faint">To make an offer, name a price — “${mine === "requester" ? "I'll buy it for ₹350" : "I'll sell it for ₹400"}”. Their agent answers within their limits, or they do; nothing is final until both of you confirm.</span>` : ""}
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
  if (r.state === "unavailable") return `<span class="small" style="color:var(--danger)">Out of stock — ${mine === buyer ? "you can't pay until they restock; nothing was charged" : "restock to let them pay"}.</span>`;
  if (r.state === "held") return `<span class="small muted">${r.slot ? `Slot ${when(r.slot.start)} held` : `${r.qty} reserved`} until ${when(r.expiresAt)}${mine === buyer ? " — pay before then to keep it" : ""}.</span>`;
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
  // A payment settles whether it went ahead — nobody is asked separately.
  let pay;
  if (e.reservation?.state === "unavailable" && !["paid", "outside"].includes(p?.status)) pay = `<span class="small" style="color:var(--danger)">${esc(e.reservation.reason ?? "Not enough in stock.")} Nothing to pay until ${mine === seller ? "you restock" : `${them} restocks`}.</span>`;
  else if (!p) pay = `<span class="small faint"><span class="spinner"></span> ${mine === seller ? "Your" : `${them}'s`} agent is preparing the cart…</span>`;
  else if (p.status === "paid") pay = `<span class="small" style="color:var(--fresh)">✓ ${p.by === mine ? "You paid" : `${them} paid`} ${amount}</span>${p.mode === "test" ? tag("Demo payment", "stale") : ""}`;
  else if (p.status === "outside") pay = `<span class="small" style="color:var(--fresh)">✓ ${p.by === mine ? "You" : them} marked it paid outside the app</span>`;
  else if (mine === buyer) pay = `<div class="row">${gpayOk() === false ? "" : `<button class="btn gpay compact" data-act="eng-pay" data-gpay="1" data-id="${id}" data-amount="${e.payment?.cart?.total?.value ?? e.negotiation.deal.price}" data-currency="${esc(e.offer.currency ?? "INR")}" data-item="${esc(e.offer.title || e.title)}"><b>G</b> Pay ${total} with Google Pay</button>`}<button class="btn accent compact" data-act="eng-pay" data-id="${id}">Pay ${total}</button><button class="btn quiet compact" data-act="eng-paid-outside" data-id="${id}">Paid another way</button>${p.mode === "test" ? tag("Demo payment", "stale") : ""}</div>
      `;
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
    <div class="row"><span class="deal-price">${amount}</span><span class="small muted">confirmed by both of you · ${mine === seller ? "you're offering it" : "you're getting it"}</span></div>
    ${reservationLine(e, mine, buyer)}
    ${pay}
    ${fulfil}
    ${(p?.status === "paid" || p?.status === "outside") && !["accepted", "disputed", "cancelled"].includes(f) ? `<div data-pickup="${id}"><button class="btn secondary compact" data-act="eng-pickup" data-id="${id}">${PASS[passKind(e)].name}</button></div>` : ""}
    ${dealTalk(e, mine, buyer, them, id)}
    ${mine === buyer && e.offer?.factId && (p?.status === "paid" || p?.status === "outside") ? `<div class="row"><button class="btn secondary compact" data-act="buy-again" data-id="${id}">↻ Buy again</button><span class="small faint">Same item${unitsOf(e) > 1 ? ` · ${unitsOf(e)}` : ""} from ${esc(them)}, at today's price</span></div>` : ""}
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
  const by = i.deadline ? new Date(i.deadline * 1000).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }) : "";
  const due = i.deadline ? `<span class="small faint">${i.onTimeout === "lapse" ? `Confirm by ${by} or it lapses` : `Reply by ${by}`}</span>` : "";
  const box = (title, body) => `<div class="card slim accent" data-item="${esc(i.id)}">${label(title, "accent")}${as}${body}${due}</div>`;
  if (i.kind === "answer") {
    const d = drafts.get(i.id);
    return box(demo ? "Their agent needs them" : "Your agent needs you", `<span class="small">${i.side === "provider" ? "The requester's agent asks" : "Their agent asks"}: <b>${esc(i.question)}</b></span>
      ${d ? `<div class="card peri slim">${label(`Found in your private notes · ${d.on === "device" ? "on this device" : "Gemini"}`, "peri")}<span class="small">“${esc(d.text)}”</span>
        <div class="row"><button class="btn accent compact" data-act="inbox-share" data-id="${esc(i.id)}">Share this</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div></div>` : ""}
      ${!d && /^(can|could|do|does|did|is|are|will|would|have|has|should)\b/i.test(i.question ?? "") ? `<div class="row"><button class="btn secondary compact" data-act="inbox-quick" data-id="${esc(i.id)}" data-text="Yes">Yes</button><button class="btn secondary compact" data-act="inbox-quick" data-id="${esc(i.id)}" data-text="No">No</button></div>
        <details class="more"><summary>Write my own</summary><textarea class="field" rows="2" data-reply="${esc(i.id)}" placeholder="Your answer"></textarea></details>`
        : `<textarea class="field" rows="2" data-reply="${esc(i.id)}" placeholder="${d ? "Or write your own answer" : "Your answer"}"></textarea>`}
      <div class="row"><button class="btn compact" data-act="inbox-answer" data-id="${esc(i.id)}">Send</button><button class="btn quiet compact" data-act="inbox-decline" data-id="${esc(i.id)}">I'd rather not say</button></div>`);
  }
  if (i.kind === "approve") return box("Check before sharing", `<span class="small">Asked: <b>${esc(i.question)}</b></span>
    <div class="card slim">${label("Drafted from a Protected fact your rule covers")}<span class="small">“${esc(i.draft)}”</span></div>
    <div class="row"><button class="btn accent compact" data-act="inbox-approve" data-id="${esc(i.id)}">Share</button><button class="btn secondary compact" data-act="inbox-decline" data-id="${esc(i.id)}">Don't share</button></div>`);
  if (i.kind === "move" && !i.question && !demo && !needsLimit.has(i.id)) return `<span class="thinking small"><span class="spinner"></span><span class="faint">Your agent is making a move with your private limit…</span></span>`;
  if (i.kind === "move" && i.counter) {
    const e = live.engagements.get(i.engagementId), c = i.counter, cur = e?.offer?.currency;
    return box(`${esc(shortName(c.by))} countered`, `<span class="small"><b>${c.quantity > 1 ? `${c.quantity} × ${money(c.price, null, cur)} = ${money(c.total, null, cur)}` : money(c.price, e?.offer?.unit, cur)}</b> — take it, offer another price, or walk away.</span>
      <div class="row"><button class="btn accent compact" data-act="take-price" data-eng="${esc(i.engagementId)}" data-price="${c.price}">Accept ${c.quantity > 1 ? money(c.total, null, cur) : money(c.price, null, cur)}</button></div>
      <div class="row small"><input class="field" style="min-width:200px;flex:1" data-delegate-limit="${esc(i.engagementId)}" placeholder="${c.quantity > 1 ? "Let my agent handle it — e.g. up to ₹430 each" : "Let my agent handle it — e.g. up to ₹3,200"}">
        <button class="btn secondary compact" data-act="delegate" data-id="${esc(i.engagementId)}" data-autonomy="close">Hand it over</button></div>
      <details class="more"><summary>More</summary><div class="row"><input class="field compact" type="number" min="1" style="max-width:140px" data-counter-price="${esc(i.engagementId)}" placeholder="${c.quantity > 1 ? "Your price each" : "Your price"}">
        <button class="btn secondary compact" data-act="seller-counter-send" data-id="${esc(i.engagementId)}">Counter</button>
        <button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div></details>
      <span class="small faint">Private. Your agent agrees within this, or asks you.</span><div data-rules-preview="${esc(i.engagementId)}"></div>`);
  }
  if (i.kind === "move") return box(i.question ? "No deal inside your limit yet" : "Your agent needs your limit", `${i.question ? `<span class="small">${esc(i.question)}</span>` : `<span class="small">Set the most you'll pay (or least you'll take). It's never shared; your agent uses it for each move.</span>`}
    ${i.hint ? `<span class="small faint">${esc(i.hint)}</span>` : ""}
    <div class="row"><input class="field" style="max-width:200px" type="number" min="1" data-limit="${esc(i.id)}" placeholder="${i.listPrice ? money(i.listPrice) : "amount"}">
    <button class="btn accent compact" data-act="inbox-move" data-id="${esc(i.id)}">Keep negotiating</button>${i.side === "requester" && i.listPrice ? `<button class="btn secondary compact" data-act="take-price" data-eng="${esc(i.engagementId)}" data-price="${i.listPrice}">Take their price (${money(i.listPrice)})</button>` : ""}<button class="btn quiet compact" data-act="inbox-walk" data-id="${esc(i.id)}">Walk away</button></div>`);
  if (i.kind === "confirm") {
    const e = live.engagements.get(i.engagementId);
    const deal = e?.negotiation.deal;
    return box("Confirm the deal?", `<span class="small">${deal ? `<b>${dealAmount(e)}</b> for “${esc(e.offer?.title?.split(" · ")[0] || e.title)}”.` : ""} Nothing is final until both of you confirm.</span>
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
  return `<div class="msg-agent" data-anim="m-${esc(m.id)}" data-anim-sig="${m.pending ? "p" : "d"}"><div class="row">${label("Collab", "sq ink")}${label("· " + (m.engine ?? "Gemini"))}${label("· " + time(m.at))}</div>
    ${m.pending ? `<span class="thinking"><span class="spinner"></span>${label(m.pending)}</span>` : m.text ? `<div class="text">${esc(m.text)}</div>` : ""}
    ${(m.cards ?? []).map((c, i) => renderCard(c, m, i)).join("")}</div>`;
}
