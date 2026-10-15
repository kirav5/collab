// What someone sees when they open a person's or shop's agent: each thing on offer with what can be done with it right
// there — buy a number of items (stock shown), book a free time slot, ask to visit a flat — plus questions to ask.
// Built only from Public offerings and their ledgers; a paused owner shows their offerings but takes no requests.
import type { Fact } from "./model.ts";
import { type Resource, available, certainty } from "./resources.ts";
import { type Suggestion, type Tracked, forOffer, itemName, kindOf } from "./suggest.ts";

export type ShopAction = "buy" | "book" | "visit" | "ask";
export interface ShopItem {
  factId: string; title: string; name: string; details: string; category: string;
  price: number | null; currency: string; unit: string | null;
  /** buy: pick how many; book: pick a time (or request one); visit: ask to see it first; ask: no price yet. */
  action: ShopAction;
  stock: { state: "in" | "low" | "out" | "unknown"; available: number | null } | null;
  /** The most anyone can order in one go (what's in stock, or 20 when stock isn't tracked). */
  maxQuantity: number;
  slots: { id: string; start: number; end: number }[] | null;
  /** The seller's own stated terms, and whether an order at the listed price is confirmed at once. */
  policies: { label: string; text: string }[]; instant: boolean;
  timezone: string | null;
  questions: Suggestion[];
}

const ACTION: Record<string, ShopAction> = {
  goods: "buy", food: "buy", supply: "buy", other: "buy",
  lesson: "book", service: "book", salon: "book", pet: "book", event: "book", stay: "book", equipment: "book", ride: "book", freight: "book",
  rent: "visit", sale: "visit", vehicle: "visit", job: "visit",
};

export function storefront(facts: Fact[], resources: Resource[], now: number, paused = false): ShopItem[] {
  const ledger = new Map(resources.filter(r => r.factId).map(r => [r.factId!, r]));
  return facts.filter(f => f.tier === "public" && f.offer && f.offer.status !== "sold")
    .sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 8)
    .map(f => {
      const o = f.offer!, r = ledger.get(f.id) ?? null, price = o.price?.amount ?? null;
      let action = ACTION[kindOf(o.category)] ?? "buy";
      if (price == null && action === "buy") action = "ask";
      let stock: ShopItem["stock"] = null, slots: ShopItem["slots"] = null, max = 20;
      if (!paused && r?.type === "quantity") {
        if (certainty(r, now) === "stale") stock = { state: "unknown", available: null };
        else { const n = available(r, now); stock = { state: n === 0 ? "out" : n <= 3 ? "low" : "in", available: n }; max = Math.min(20, n); }
      }
      if (!paused && r?.type === "slots") {
        slots = r.slots.filter(s => s.start > now && s.start < now + 14 * 86_400 && available(r, now, s.id) > 0)
          .sort((a, b) => a.start - b.start).slice(0, 6).map(s => ({ id: s.id, start: s.start, end: s.end }));
        max = 1;
      }
      // One-off things (a used cycle, a booking, a flat) come one at a time.
      const oneOff = /\b(used|second[- ]hand|pre-?owned|refurbished)\b/i.test(`${o.title} ${Object.values(o.attributes ?? {}).join(" ")} ${f.text}`.replace(/new or used/gi, ""));
      if (action === "book" || action === "visit" || (oneOff && !stock)) max = 1;
      return { factId: f.id, title: o.title, name: itemName(o.title), details: clip(o.details || f.text, 160), category: o.category,
        price, currency: o.price?.currency ?? "INR", unit: o.price?.period ?? null, action, stock, maxQuantity: max, slots,
        timezone: r?.type === "slots" ? r.timezone : null, policies: o.policies ?? [], instant: !!o.instant && price != null, questions: forOffer(f, (r?.type ?? null) as Tracked) };
    });
}

/** Cut at a word, with "…", so a description never ends mid-word. */
const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, "")}…`);

/** The words an order says, so the conversation and the seller's confirmation read naturally. */
export function orderText(item: Pick<ShopItem, "name" | "currency"> & Partial<Pick<ShopItem, "action" | "unit">>, quantity: number, priceEach: number, listed: number | null, slotLabel: string | null): string {
  const money = (n: number) => `${item.currency === "INR" ? "₹" : `${item.currency} `}${n.toLocaleString("en-IN")}`;
  const book = item.action === "book", per = item.unit && item.unit !== "each" ? `/${item.unit}` : quantity > 1 ? " each" : "";
  const what = book ? `to book ${item.name}` : quantity > 1 ? `${quantity} × ${item.name}` : item.name;
  const when = slotLabel ? ` on ${slotLabel}` : "";
  const total = quantity > 1 ? ` (${money(priceEach * quantity)} in all)` : "";
  return listed != null && priceEach !== listed
    ? `I'd like ${what}${when} — would you take ${money(priceEach)}${per}?${total}`
    : `I'd like ${what}${when} at ${money(priceEach)}${per}.${total}`;
}
