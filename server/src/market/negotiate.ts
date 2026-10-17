// Two-party negotiation (Collab's Negotiation module). Deterministic rules decide by default; Gemini may choose moves
// through NegotiateTask, whose checks it can't get past: inside the mandate, no going backwards, no conceding past the
// other side's offer, paced concessions, and the message must not reveal the limit. The prompt holds only numbers —
// nothing the other side *wrote* ever reaches the model choosing a move.
import type { Task } from "../ai/decide.ts";
import type { Catalog } from "./domains.ts";
import { type Mandate, type Proposal, type Side, moneyText, newId } from "./types.ts";

export interface Context {
  side: Side;
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
  return ctx.side === "buyer" ? forBuyer : -forBuyer;
}

/** 0 at the first round, 1 at the last; convex, so early rounds concede little. */
export const concession = (r: number, rounds: number) => (rounds <= 1 ? 1 : Math.min(1, r / (rounds - 1)) ** 1.6);

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
  // Never offer worse for us than our own last proposal (no going backwards).
  const last = ctx.mine.at(-1);
  if (last) price = dir > 0 ? Math.min(price, last.price) : Math.max(price, last.price);
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

function blockers(p: Proposal, ctx: Context): string {
  const out: string[] = [];
  if (direction(ctx) * (p.price - ctx.mandate.price.limit) < -0.5) {
    out.push(`price ${moneyText({ amount: p.price, currency: "INR", period: ctx.unit })} (your limit ${moneyText({ amount: ctx.mandate.price.limit, currency: "INR", period: ctx.unit })})`);
  }
  for (const [k, b] of Object.entries(ctx.mandate.terms).sort()) {
    const v = p.terms[k];
    if (v !== undefined && direction(ctx, k) * (v - b.limit) < -0.0001) out.push(`${ctx.catalog.termLabel(k)} ${v} (your limit ${b.limit})`);
  }
  return out.length ? ` Blocking: ${out.join("; ")}.` : "";
}

/** Deterministic negotiating: concede from the opening toward the limit over the rounds, accept anything inside the
 *  limits at least as good as what we'd offer next, and hand the decision to the owner when the rounds run out. */
export function next(ctx: Context): Move {
  const r = ctx.mine.length;
  const plan = planned(ctx, r);
  const t = ctx.theirs.at(-1);
  if (t && acceptable(t, ctx)) {
    const close = Math.abs(t.price - plan.price) <= Math.max(1, plan.price * 0.005);
    if (r >= ctx.mandate.maxRounds || atLeastAsGood(t, plan, ctx) || close) return { action: "accept", acceptId: t.id, message: `Agreed: ${describe(t, ctx)}.` };
  }
  if (r >= ctx.mandate.maxRounds) {
    return { action: "escalate", message: `No deal inside your limits after ${r} offers. Their latest: ${t ? describe(t, ctx) : "nothing yet"}.${t ? blockers(t, ctx) : ""}` };
  }
  return { action: "propose", proposal: plan, message: (r === 0 ? "We can offer " : "We can do ") + describe(plan, ctx) + "." };
}

/** Does the text state our price limit (in any common form) when that isn't what we're proposing? */
export function leaks(text: string, ctx: Context): boolean {
  const lower = text.toLowerCase();
  const phrases = ["limit", "walk away", "walk-away", "maximum i can", "most i can", "lowest i can", "least i can", "floor", "ceiling",
    "my owner said", "my owner allows", "authorized up to", "authorised up to", "budget is"];
  if (phrases.some(p => lower.includes(p))) return true;
  const limit = Math.round(ctx.mandate.price.limit);
  if (limit === Math.round(ctx.mandate.price.opening)) return false; // a firm price is the public listing price
  const flat = text.replace(/,/g, "").toLowerCase();
  const forms = [String(limit), moneyText({ amount: limit, currency: "INR" }).replace("₹", "").replace(/,/g, "").toLowerCase()];
  return forms.some(f => flat.includes(f));
}

/** One line, and amounts in rupees (models sometimes write "$630" for a ₹ price). */
const clean = (s: string) => { const t = s.replace(/[\r\n]+/g, " ").replace(/(?:US)?\$\s?(?=\d)/g, "₹").replace(/\bRs\.?\s?(?=\d)/gi, "₹").trim(); return t ? t.slice(0, 240) : null; };

/** A message that adds what isn't in the offer — a credit period, a deposit, "30 days", a second price — says something
 *  the deal doesn't: the plain wording is used instead. Only the offer's own numbers may appear. */
export function invents(message: string, p: Proposal): boolean {
  const qty = Number(p.terms?.quantity) || 1;
  const ok = new Set([p.price, p.price * qty, qty, ...Object.values(p.terms ?? {}), ...(p.items ?? []).flatMap(l => [l.unitPrice, l.quantity, l.unitPrice * l.quantity])].map(n => Math.round(Number(n))));
  const nums = (message.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => Math.round(Number(n.replace(/,/g, ""))));
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
for price when it helps; escalate to your owner when no deal fits the limits.`,
  schema: { type: "object", properties: { action: { type: "string", enum: ["propose", "accept", "escalate"] }, price: { type: "number" },
    terms: { type: "object", additionalProperties: { type: "number" } }, message: { type: "string" } }, required: ["action", "message"] },
  prompt({ ctx, listPrice }) {
    const per = ctx.unit ? ` per ${ctx.unit}` : "";
    const lines = [`You are the ${ctx.side}'s agent. Category: ${ctx.catalog.label}.`, `Listed price: ${listPrice}${per}.`,
      `Your opening: ${Math.round(ctx.mandate.price.opening)}${per}. Your limit (${ctx.side === "seller" ? "lowest" : "highest"} you may agree): ${Math.round(ctx.mandate.price.limit)}${per}.`,
      `Offers used: ${ctx.mine.length} of ${ctx.mandate.maxRounds}.`];
    for (const [k, b] of Object.entries(ctx.mandate.terms).sort()) {
      lines.push(`Term ${k} (${ctx.catalog.termLabel(k)}, ${direction(ctx, k) > 0 ? "higher" : "lower"} is better for you): opening ${b.opening}, limit ${b.limit}.`);
    }
    const compact = (p: Proposal) => `price ${p.price}` + Object.entries(p.terms).sort().map(([k, v]) => `, ${k} ${v}`).join("");
    const history = [...ctx.mine.map(p => [p.round * 2 + (ctx.side === "buyer" ? 0 : 1), `You offered ${compact(p)}`] as const),
      ...ctx.theirs.map(p => [p.round * 2 + (ctx.side === "buyer" ? 1 : 0), `They offered ${compact(p)}`] as const)].sort((a, b) => a[0] - b[0]);
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
        return { ...move, message: (!leaks(move.message, ctx) && !invents(move.message, t) && clean(move.message)) || `Agreed: ${describe(t, ctx)}.` };
      }
      case "escalate":
        return move.message ? { ...move, message: move.message.slice(0, 240) } : null;
      case "propose": {
        const p: Proposal = { ...move.proposal, terms: Object.fromEntries(Object.entries(move.proposal.terms).filter(([k]) => ctx.mandate.terms[k])), round: ctx.mine.length };
        if (p.price <= 0 || !acceptable(p, ctx) || ctx.mine.length >= ctx.mandate.maxRounds) return null;
        const dir = direction(ctx), { opening, limit } = ctx.mandate.price;
        if (dir * (p.price - opening) > 0.5) return null;                                   // beyond our opening
        const last = ctx.mine.at(-1), theirs = ctx.theirs.at(-1);
        if (last && dir * (p.price - last.price) > 0) return null;                          // backwards
        if (theirs && dir * (theirs.price - p.price) > 0) return null;                      // past their offer
        // Pacing: no faster than the schedule allows by the next round, with a little slack.
        if (Math.abs(opening - limit) > 0.5 && (opening - p.price) / (opening - limit) > concession(ctx.mine.length + 1, ctx.mandate.maxRounds) + 0.15) return null;
        for (const [k, v] of Object.entries(p.terms)) if (direction(ctx, k) * (v - ctx.mandate.terms[k].opening) > 0.0001) return null;
        return { action: "propose", proposal: p, message: (!leaks(move.message, ctx) && !invents(move.message, p) && clean(move.message)) || `We can do ${describe(p, ctx)}.` };
      }
    }
  },
  fallback: ({ ctx }) => next(ctx),
};
