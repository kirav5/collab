// Pricing from the web, by the owner's own rules: "price is what Croma lists it at; I go 25% cheaper while it's under
// the manufacturer's guarantee; repairs are the cost online plus 25%; insurance is 12.5% of the price". The bases are
// looked up with the same Google-grounded price check as "Is this fair?" (every price with its source, at least two
// comparable ones); the percentages are only ever the owner's. Nothing here is a limit the agent invents: a quote is
// shown to the owner, or opens a conversation that the owner still confirms.
import type { Docs } from "../docs.ts";
import type { Model } from "../ai/gemini.ts";
import { checkPrice } from "./price-check.ts";
import { type Lookup, type PriceRule, pricingLine } from "./rules.ts";
import { moneyText } from "../market/types.ts";

export interface Found { what: Lookup; query: string; typical: number | null; low: number | null; high: number | null; sources: { title: string; url: string }[]; error?: string }
export interface QuoteLine { label: string; text: string; amount: number | null }
export interface Quote { item: string; found: Found[]; lines: QuoteLine[]; price: number | null; rule: PriceRule | null }

const QUERY: Record<Lookup, (item: string) => string> = {
  "new price": item => `${item} new`,
  "part cost": item => `${item} replacement parts`,
  "repair cost": item => `${item} repair service`,
};
const rupees = (n: number) => moneyText({ amount: n, currency: "INR", period: null });
/** A price people say: ₹8,320 not ₹8,321.25; ₹1,04,000 not ₹1,03,962. */
export const nice = (n: number) => { const step = n >= 1e5 ? 1000 : n >= 1e4 ? 100 : n >= 1000 ? 10 : 1; return Math.round(n / step) * step; };
const sites = (f: Found) => [...new Set(f.sources.map(s => s.title || new URL(s.url).hostname))].slice(0, 3).join(", ");

export function apply(p: PriceRule, base: number): number {
  return p.how === "off" ? base * (1 - p.percent / 100) : p.how === "over" ? base * (1 + p.percent / 100) : base * (p.percent / 100);
}

/** Looks up what the rules need for this item (cached half a day per item and area) and works the owner's rules out. */
export async function quote(db: Docs, model: Model | null, uid: string, item: string, area: string, rules: { lookups: Lookup[]; pricing: PriceRule[] }, listPrice: number | null, now: number): Promise<Quote> {
  const wanted = [...new Set<Lookup>([...rules.lookups, ...rules.pricing.flatMap(p => (p.basis === "price" ? [] : [p.basis]))])];
  const found: Found[] = await Promise.all(wanted.map(async what => {
    const query = QUERY[what](item);
    try {
      const r: any = await checkPrice(db, model, uid, query, area, now);
      return { what, query, typical: r.typical ?? null, low: r.low ?? null, high: r.high ?? null, sources: (r.items ?? []).flatMap((i: any) => i.sources ?? []) };
    } catch (err) { return { what, query, typical: null, low: null, high: null, sources: [], error: String((err as Error).message ?? err).slice(0, 120) }; }
  }));
  const lines: QuoteLine[] = [];
  for (const f of found) lines.push({ label: f.what === "new price" ? "New price" : f.what === "part cost" ? "Replaceable parts" : "Repair service cost",
    text: f.typical != null ? `usually ${rupees(f.typical)}${f.low != null && f.high != null && f.low !== f.high ? ` (${rupees(f.low)}–${rupees(f.high)})` : ""} · ${sites(f)}` : f.error ?? "not enough comparable prices on the web", amount: f.typical });
  // The sale price: the first rule priced from a looked-up basis ("25% under the new price"); then the rules on the
  // price itself ("insurance: 12.5% of the price") use it, or the listed price.
  const base = (b: Lookup) => found.find(f => f.what === b)?.typical ?? null;
  const rule = rules.pricing.find(p => p.basis !== "price" && p.how === "off" && base(p.basis as Lookup) != null) ?? null;
  const price = rule ? nice(apply(rule, base(rule.basis as Lookup)!)) : null;
  for (const p of rules.pricing) {
    const b = p.basis === "price" ? price ?? listPrice : base(p.basis);
    lines.push({ label: p.label, text: b != null ? `${pricingLine(p).replace(/^[^:]+:\s*/, "")} → ${rupees(nice(apply(p, b)))}` : `${pricingLine(p).replace(/^[^:]+:\s*/, "")} → needs the ${p.basis} first`, amount: b != null ? nice(apply(p, b)) : null });
  }
  return { item, found, lines, price, rule };
}

/** What the seller's agent tells a buyer about how the price was set: the new price and where, and the owner's rule. */
export function quoteMessage(q: Quote, insurance: PriceRule | null): string | null {
  const f = q.found.find(x => x.what === q.rule?.basis);
  if (!q.rule || q.price == null || !f?.typical) return null;
  const cover = insurance ? ` Optional cover: ${insurance.percent}% of the price (${rupees(nice(apply(insurance, q.price)))}).` : "";
  return `New, it's usually ${rupees(f.typical)} (${sites(f)}). ${q.rule.when ? `${q.rule.when[0].toUpperCase()}${q.rule.when.slice(1)}, we` : "We"} sell at ${q.rule.percent}% under that: ${rupees(q.price)}.${cover}`;
}
