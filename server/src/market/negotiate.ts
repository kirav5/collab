// Two-party negotiation (Collab's Negotiation module). Deterministic rules decide by default; Gemini may choose moves
// through NegotiateTask, whose checks it can't get past: inside the mandate, no going backwards, no conceding past the
// other side's offer, paced concessions, and the message must not reveal the limit. The prompt holds only numbers —
// nothing the other side *wrote* ever reaches the model choosing a move.
import type { Task } from "../ai/decide.ts";
import type { Catalog } from "./domains.ts";
import { type Voice, fill } from "./roles.ts";
import { grounded } from "./text.ts";
import { type Mandate, type Proposal, type Side, moneyText, newId } from "./types.ts";

export interface Context {
  /** Price: the seller is the one paid. */
  side: Side;
  /** The other terms, in the category's own sense ("buyer" = the requester); absent: same as `side`. */
  termsSide?: Side;
  /** How this side talks (its role, the other side's, its lines); absent: plain "We can offer / We can do / Agreed". */
  voice?: Voice;
  catalog: Catalog;
  mandate: Mandate;
  unit: string | null;
  mine: Proposal[];
  theirs: Proposal[];
}

export type Move =
  | { action: "propose"; proposal: Proposal; message: string }
  | { action: "accept"; acceptId: string; message: string }
  /** Stop and ask the owner (no deal possible inside the mandate, or rounds used up). */
  | { action: "escalate"; message: string };

/** +1 if a higher value of `term` is better for us, -1 if lower is; price: sellers want higher. */
export function direction(ctx: Context, term?: string): number {
  if (!term) return ctx.side === "seller" ? 1 : -1;
  const forBuyer = ctx.catalog.buyerPrefersLower(term) === true ? -1 : 1;
  return (ctx.termsSide ?? ctx.side) === "buyer" ? forBuyer : -forBuyer;
}

/** 0 at the first offer, 1 (the limit) by the fourth at the latest (before the other side runs out of its five); gently convex, so early offers concede less. Extra
 *  rounds (an owner who raised their limit gets more) hold at the limit instead of stretching the curve — spread over
 *  12 rounds the first moves were ₹2 and ₹5, and the other side ran out of rounds first. */
export const HORIZON = 4;
export const concession = (r: number, rounds: number) => { const h = Math.min(rounds, HORIZON); return h <= 1 ? 1 : Math.min(1, r / (h - 1)) ** 1.3; };

export const isSane = (p: Proposal) =>
  p.price > 0 && p.price < 1e12 && Object.keys(p.terms).length <= 12 && p.round >= 0 && p.round < 100
  && Object.entries(p.terms).every(([k, v]) => k.length <= 32 && Number.isFinite(v) && Math.abs(v) < 1e9);

export function planned(ctx: Context, r: number): Proposal {
  const f = concession(r, ctx.mandate.maxRounds);
  const m = ctx.mandate;
  let price = m.price.opening + (m.price.limit - m.price.opening) * f;
  const terms: Record<string, number> = {};
  for (const [k, b] of Object.entries(m.terms)) terms[k] = Math.round(b.opening + (b.limit - b.opening) * f);
  const dir = direction(ctx);
  // Never offer worse for us than our own last proposal (no going backwards) — and never the same offer twice while
  // there's room: a repeat moves at least a quarter of what's left toward the limit.
  const last = ctx.mine.at(-1);
  if (last) {
    price = dir > 0 ? Math.min(price, last.price) : Math.max(price, last.price);
    const room = m.price.limit - last.price;
    if (Math.abs(price - last.price) < 0.5 && Math.abs(room) >= 1) price = last.price + room / 4;
  }
  // Never concede past what they already offered.
  const t = ctx.theirs.at(-1);
  if (t) {
    price = dir > 0 ? Math.max(price, t.price) : Math.min(price, t.price);
    for (const k of Object.keys(terms)) if (t.terms[k] !== undefined) terms[k] = direction(ctx, k) > 0 ? Math.max(terms[k], t.terms[k]) : Math.min(terms[k], t.terms[k]);
  }
  return { id: newId(), price: roundPrice(price, ctx), terms, round: r };
}

/** People quote ₹37,600, not ₹37,619: three significant figures, rounded in our favour but never past our opening. */
function roundPrice(price: number, ctx: Context): number {
  const step = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(price, 1))) - 2);
  const opening = ctx.mandate.price.opening;
  return direction(ctx) > 0 ? Math.min(Math.ceil(price / step) * step, Math.max(opening, price)) : Math.max(Math.floor(price / step) * step, Math.min(opening, price));
}

/** Inside every limit of our mandate (terms they didn't mention don't count against them). */
export function acceptable(p: Proposal, ctx: Context): boolean {
  if (!isSane(p) || direction(ctx) * (p.price - ctx.mandate.price.limit) < -0.5) return false;
  return Object.entries(ctx.mandate.terms).every(([k, b]) => p.terms[k] === undefined || direction(ctx, k) * (p.terms[k] - b.limit) >= -0.0001);
}

function atLeastAsGood(p: Proposal, q: Proposal, ctx: Context): boolean {
  if (direction(ctx) * (p.price - q.price) < 0) return false;
  return Object.entries(q.terms).every(([k, qv]) => p.terms[k] === undefined || direction(ctx, k) * (p.terms[k] - qv) >= -0.0001);
}

/** "₹2,350/bag · Delivery: 4 days" — only the proposal's own numbers. */
export function describe(p: Proposal, ctx: Pick<Context, "catalog" | "unit">): string {
  // A proposal for several units says how many and what they come to: "5 × ₹420 (₹2,100 in all)".
  const n = Number.isInteger(p.terms.quantity) && p.terms.quantity > 1 ? p.terms.quantity : 1;
  const parts = [n > 1 ? `${n} × ${moneyText({ amount: p.price, currency: "INR" })} (${moneyText({ amount: p.price * n, currency: "INR" })} in all)` : moneyText({ amount: p.price, currency: "INR", period: ctx.unit })];
  for (const [k, v] of Object.entries(p.terms).filter(([k]) => k !== "quantity").sort()) {
    const unit = ctx.catalog.termUnit(k);
    parts.push(`${ctx.catalog.termLabel(k)}: ${Number.isInteger(v) ? v : v.toFixed(1)}${unit ? ` ${unit}` : ""}`);
  }
  return parts.join(" · ");
}

/** What the owner reads when no deal fits: their latest and the owner's own limit, in plain numbers — always these
 *  words, never the model's (it once wrote "I need to check with Atishay… ₹2,000 is our maximum authorized limit"
 *  to Atishay, beside a different price on the same card). */
export function escalation(ctx: Context): string {
  const r = ctx.mine.length, t = ctx.theirs.at(-1), lim = moneyText({ amount: ctx.mandate.price.limit, currency: "INR", period: ctx.unit });
  if (!t) return `No offer from them yet after your ${r}. Your limit is ${lim}.`;
  const terms: string[] = [];
  for (const [k, b] of Object.entries(ctx.mandate.terms).sort()) {
    const v = t.terms[k];
    if (v !== undefined && direction(ctx, k) * (v - b.limit) < -0.0001) terms.push(`${ctx.catalog.termLabel(k)} ${v} (your limit ${b.limit})`);
  }
  const priceOut = direction(ctx) * (t.price - ctx.mandate.price.limit) < -0.5;
  return `Their latest is ${moneyText({ amount: t.price, currency: "INR", period: ctx.unit })}${priceOut ? `; your limit is ${lim}` : ""} — no deal inside your limit after ${r} offers.${terms.length ? ` Also outside it: ${terms.join("; ")}.` : ""}`;
}

/** This side's line for a move, in its role's words ("Thanks — Ravi is looking for ₹38,000/month."). */
export function line(ctx: Pick<Context, "voice">, kind: "open" | "counter" | "accept", amount: string): string {
  if (ctx.voice) return fill(ctx.voice[kind], ctx.voice, amount);
  return kind === "accept" ? `Agreed: ${amount}.` : `${kind === "open" ? "We can offer" : "We can do"} ${amount}.`;
}

/** Which line a new offer gets: the first, or the same price again (a firm price), is the opening line; a real
 *  move is a counter ("We can come down to…" only when it actually comes down). */
export const moveKind = (ctx: Pick<Context, "mine">, price: number): "open" | "counter" =>
  !ctx.mine.length || Math.abs(price - ctx.mine.at(-1)!.price) < 0.5 ? "open" : "counter";

/** Deterministic negotiating: concede from the opening toward the limit over the rounds, accept anything inside the
 *  limits at least as good as what we'd offer next, and hand the decision to the owner when the rounds run out. */
export function next(ctx: Context): Move {
  const r = ctx.mine.length;
  const plan = planned(ctx, r);
  const t = ctx.theirs.at(-1);
  if (t && acceptable(t, ctx)) {
    const close = Math.abs(t.price - plan.price) <= Math.max(1, plan.price * 0.005);
    if (r >= ctx.mandate.maxRounds || atLeastAsGood(t, plan, ctx) || close) return { action: "accept", acceptId: t.id, message: line(ctx, "accept", describe(t, ctx)) };
  }
  if (r >= ctx.mandate.maxRounds) {
    return { action: "escalate", message: escalation(ctx) };
  }
  return { action: "propose", proposal: plan, message: line(ctx, moveKind(ctx, plan.price), describe(plan, ctx)) };
}

/** Does the text state our price limit (in any common form) when that isn't what we're proposing? */
export function leaks(text: string, ctx: Context): boolean {
  const lower = text.toLowerCase();
  const phrases = ["limit", "walk away", "walk-away", "maximum i can", "most i can", "lowest i can", "least i can", "floor", "ceiling",
    "my owner said", "my owner allows", "authorized up to", "authorised up to", "budget is"];
  if (phrases.some(p => lower.includes(p))) return true;
  // Agents now speak about their owner by name ("as high as Brightpath can go", "Ravi's minimum"): the same give-aways
  // in any person.
  if (/\b(minimum|maximum|tops? out|as (?:high|low|far) as|can'?t go (?:any )?(?:below|above|under|over|lower|higher)|won'?t go (?:any )?(?:below|above|under|over|lower|higher)|(?:the )?(?:most|least|lowest|highest) (?:\w+ )?(?:can|could|would|will|is willing))\b/i.test(text)) return true;
  const limit = Math.round(ctx.mandate.price.limit);
  if (limit === Math.round(ctx.mandate.price.opening)) return false; // a firm price is the public listing price
  const flat = text.replace(/,/g, "").toLowerCase();
  const forms = [String(limit), moneyText({ amount: limit, currency: "INR" }).replace("₹", "").replace(/,/g, "").toLowerCase()];
  // …in any written scale too: "36k", "36 thousand", "0.36 L" all say 36,000.
  return forms.some(f => flat.includes(f)) || grounded(limit, text) || scaledAmounts(text).some(a => Math.abs(a.value - limit) <= a.tolerance);
}

/** The ₹ amounts a message names must be this offer's — the price, or what several units come to — and the price
 *  must be among them, so what's said always matches what's offered. */
function saysOffer(message: string, p: Proposal, quantity = p.terms.quantity): boolean {
  const said = scaledAmounts(message, true);
  const n = Number.isInteger(quantity) && quantity! > 1 ? quantity! : 1, ok = [p.price, p.price * n];
  const is = (a: { value: number; tolerance: number }, v: number) => Math.abs(a.value - v) <= a.tolerance;
  return said.some(a => is(a, p.price)) && said.every(a => ok.some(o => is(a, o)));
}

const SCALE: Record<string, number> = { k: 1e3, thousand: 1e3, l: 1e5, lakh: 1e5, lakhs: 1e5, lac: 1e5, lacs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };
/** Amounts written with a scale word ("₹6.4 L", "₹72 lakh", "36k"), each with how precisely it's written ("₹6.4 L" is
 *  to the nearest ₹10,000). `rupeesOnly`: just the ones written with ₹. */
function scaledAmounts(text: string, rupeesOnly = false): { value: number; tolerance: number }[] {
  const re = rupeesOnly ? /₹\s?(\d[\d,]*(?:\.\d+)?)\s?(k|thousand|lakhs?|lacs?|l|crores?|cr)?\b/gi : /(\d[\d,]*(?:\.\d+)?)\s?(k|thousand|lakhs?|lacs?|l|crores?|cr)\b/gi;
  return [...text.matchAll(re)].map(m => {
    const digits = m[1].replace(/,/g, ""), scale = m[2] ? SCALE[m[2].toLowerCase()] ?? 1 : 1, decimals = digits.split(".")[1]?.length ?? 0;
    return { value: Number(digits) * scale, tolerance: Math.max(0.5, (scale * 10 ** -decimals) / 2) };
  });
}

/** One line, and amounts in rupees (models sometimes write "$630" for a ₹ price). */
const clean = (s: string) => { const t = s.replace(/[\r\n]+/g, " ").replace(/(?:US)?\$\s?(?=\d)/g, "₹").replace(/\b(?:Rs\.?|INR)\s?(?=\d)/gi, "₹").trim(); return t ? t.slice(0, 240) : null; };

/** A message that names a side by a role or a guessed gender ("would your client…", "lower her offer") — people here
 *  aren't clients or customers of each other, and the agent doesn't know anyone's pronouns. */
export const misnames = (message: string) => /\b(clients?|customers?|buyers?|sellers?|vendors?|he|she|him|his|her|hers|himself|herself)\b/i.test(message);

/** A message that adds what isn't in the offer — a credit period, a deposit, "30 days", a second price — says something
 *  the deal doesn't: the plain wording is used instead. Only the offer's own numbers may appear. */
export function invents(message: string, p: Proposal): boolean {
  const qty = Number(p.terms?.quantity) || 1;
  const ok = new Set([p.price, p.price * qty, qty, ...Object.values(p.terms ?? {}), ...(p.items ?? []).flatMap(l => [l.unitPrice, l.quantity, l.unitPrice * l.quantity])].map(n => Math.round(Number(n))));
  // Amounts at the scale they're written: "₹72 lakh", "₹0.72 Cr", "₹72 L", "30k".
  const SCALE: Record<string, number> = { lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5, crore: 1e7, crores: 1e7, cr: 1e7, k: 1e3 };
  const nums = [...message.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lac|crores?|cr|l|k)?\b/gi)].map(m => Math.round(Number(m[1].replace(/,/g, "")) * (SCALE[(m[2] ?? "").toLowerCase()] ?? 1)));
  if (nums.some(n => !ok.has(n))) return true;
  return /\b(credit|payment terms?|installments?|emi|advance|deposit|warranty|guarantee|free delivery|delivery charges?|bulk|refund)\b/i.test(message)
    && !Object.keys(p.terms ?? {}).some(k => /credit|deposit|warranty|delivery/i.test(k));
}

export const NegotiateTask: Task<{ ctx: Context; listPrice: number }, Move> = {
  name: "negotiate",
  tier: "cheap",
  maxTokens: 300,
  // Accepting and escalating are pure arithmetic: no model call for those.
  settled: ({ ctx }) => { const m = next(ctx); return m.action === "propose" ? null : m; },
  instructions: `You negotiate on behalf of your owner in a marketplace deal. Return only JSON:
{"action":"propose"|"accept"|"escalate","price":number,"terms":{"term_key":number},"message":"one short, polite sentence to the other side"}
Amounts are Indian rupees: write them with ₹ (e.g. ₹36,000). Rules: never propose a price worse for your owner than their limit; never mention the limit or that one exists; concede gradually;
accept when their latest offer is inside your limits and close to what you'd offer; trade terms (credit days, delivery days, quantity)
for price when it helps; escalate to your owner when no deal fits the limits. In the message, name only the ₹ amount you are offering
(and, for several units, what they come to) — no other amounts, not theirs and not the listed price.`,
  schema: { type: "object", properties: { action: { type: "string", enum: ["propose", "accept", "escalate"] }, price: { type: "number" },
    terms: { type: "object", additionalProperties: { type: "number" } }, message: { type: "string" } }, required: ["action", "message"] },
  prompt({ ctx, listPrice }) {
    const per = ctx.unit ? ` per ${ctx.unit}` : "", v = ctx.voice;
    // Who it speaks for, in the category's words, with an example of how that side talks.
    const who = v ? `You are the ${v.me}'s agent, speaking for ${v.name} to the ${v.them}'s agent about the ${v.price}. Category: ${ctx.catalog.label}.`
      + ` Write the message the way the ${v.me}'s agent would say it, e.g. "${fill(ctx.mine.length ? v.counter : v.open, v, "₹X")}" — say "you" and "we": never call anyone a client, customer, buyer or seller, and never "he" or "she".`
      : `You are the ${ctx.side}'s agent. Category: ${ctx.catalog.label}.`;
    const lines = [who, `Listed ${v?.price ?? "price"}: ${listPrice}${per}.`,
      `Your opening: ${Math.round(ctx.mandate.price.opening)}${per}. Your limit (${ctx.side === "seller" ? "lowest" : "highest"} you may agree): ${Math.round(ctx.mandate.price.limit)}${per}.`,
      `Offers used: ${ctx.mine.length} of ${ctx.mandate.maxRounds}.`];
    for (const [k, b] of Object.entries(ctx.mandate.terms).sort()) {
      lines.push(`Term ${k} (${ctx.catalog.termLabel(k)}, ${direction(ctx, k) > 0 ? "higher" : "lower"} is better for you): opening ${b.opening}, limit ${b.limit}.`);
    }
    const compact = (p: Proposal) => `price ${p.price}` + Object.entries(p.terms).sort().map(([k, v]) => `, ${k} ${v}`).join("");
    // Moves alternate, so whoever has made at least as many offers as the other moved first (a listing's price
    // counts as its owner's first offer). Not "the buyer first": a shop or an employer opens with its listing.
    const mineFirst = ctx.mine.length >= ctx.theirs.length;
    // Placed by position, not p.round (chat offers and listing counters number rounds differently).
    const history = [...ctx.mine.map((p, i) => [i * 2 + (mineFirst ? 0 : 1), `You offered ${compact(p)}`] as const),
      ...ctx.theirs.map((p, i) => [i * 2 + (mineFirst ? 1 : 0), `They offered ${compact(p)}`] as const)].sort((a, b) => a[0] - b[0]);
    lines.push("History:", ...(history.length ? history.map(h => "- " + h[1]) : ["- (none yet)"]), "Your move:");
    return lines.join("\n");
  },
  parse(o, { ctx }) {
    const terms: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.terms ?? {})) if (typeof v === "number") terms[k] = v;
    const message = typeof o.message === "string" ? o.message.slice(0, 300) : "";
    if (o.action === "accept") return { action: "accept", acceptId: ctx.theirs.at(-1)?.id ?? "", message };
    if (o.action === "escalate") return { action: "escalate", message };
    if (o.action === "propose") return { action: "propose", proposal: { id: newId(), price: typeof o.price === "number" ? Math.round(o.price) : -1, terms, round: ctx.mine.length }, message };
    return null;
  },
  validate(move, { ctx }) {
    switch (move.action) {
      case "accept": {
        const t = ctx.theirs.at(-1);
        if (!t || t.id !== move.acceptId || !acceptable(t, ctx)) return null;
        const said = clean(move.message);
        return { ...move, message: (said && !leaks(said, ctx) && !invents(said, t) && !misnames(said) && saysOffer(said, t) && said) || line(ctx, "accept", describe(t, ctx)) };
      }
      case "escalate":
        return { ...move, message: escalation(ctx) };
      case "propose": {
        const p: Proposal = { ...move.proposal, terms: Object.fromEntries(Object.entries(move.proposal.terms).filter(([k]) => ctx.mandate.terms[k])), round: ctx.mine.length };
        // How many it's for (dropped from the terms above when it isn't negotiated): a message may say the total.
        const n = move.proposal.terms.quantity ?? ctx.theirs.at(-1)?.terms.quantity ?? ctx.mine.at(-1)?.terms.quantity;
        if (p.price <= 0 || !acceptable(p, ctx) || ctx.mine.length >= ctx.mandate.maxRounds) return null;
        const dir = direction(ctx), { opening, limit } = ctx.mandate.price;
        if (dir * (p.price - opening) > 0.5) return null;                                   // beyond our opening
        const last = ctx.mine.at(-1), theirs = ctx.theirs.at(-1);
        if (last && dir * (p.price - last.price) > 0) return null;                          // backwards
        if (last && Math.abs(p.price - last.price) < 0.5 && Math.abs(limit - last.price) >= 1) return null; // the same offer again while there's room
        if (theirs && dir * (theirs.price - p.price) > 0) return null;                      // past their offer
        // Pacing: no faster than the schedule allows by the next round, with a little slack.
        if (Math.abs(opening - limit) > 0.5 && (opening - p.price) / (opening - limit) > concession(ctx.mine.length + 1, ctx.mandate.maxRounds) + 0.15) return null;
        // …and no slower than it either (with slack): an agent that crawls (₹1,720, ₹1,650, ₹1,610, ₹1,600 against a
        // ₹1,500 floor) runs out of offers above its limit and misses a deal the owner wanted. The rules' offer, which
        // reaches the limit on schedule, is used instead.
        if (Math.abs(opening - limit) > 0.5 && (opening - p.price) / (opening - limit) < concession(ctx.mine.length, ctx.mandate.maxRounds) - 0.2) return null;
        for (const [k, v] of Object.entries(p.terms)) if (direction(ctx, k) * (v - ctx.mandate.terms[k].opening) > 0.0001) return null;
        const said = clean(move.message);
        const sized = n && n > 1 ? { ...p, terms: { ...p.terms, quantity: n } } : p;
        return { action: "propose", proposal: p, message: (said && !leaks(said, ctx) && !invents(said, sized) && !misnames(said) && saysOffer(said, p, n) && said) || line(ctx, moveKind(ctx, p.price), describe(sized, ctx)) };
      }
    }
  },
  fallback: ({ ctx }) => next(ctx),
};
