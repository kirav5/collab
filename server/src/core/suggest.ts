// What to ask someone's agent, for a person who just opened it (from a QR code, a link or their People list). Built
// from what that person shares publicly: each offering's category, whether its stock or time slots are tracked, and
// whether it has a price. The same suggestions are published as the A2A agent card's skill examples, so an outside
// agent sees what this one is good for. Nothing private goes in: only Public offerings are read.
import { domain } from "../market/domains.ts";
import type { Fact } from "./model.ts";

export interface Suggestion { label: string; text: string; offerId: string | null }
export type Tracked = "quantity" | "slots" | null;

/** "Water Bottles · items for sale (new or used) · Indiranagar" → "water bottles"; brands and models keep their case. */
export function itemName(title: string): string {
  const t = title.split(" · ")[0].trim().replace(/[.!?]+$/, "") || "it";
  const words = t.split(/\s+/);
  const plain = words.length <= 4 && !/\d/.test(t) && !words.some(w => w.length > 1 && w === w.toUpperCase());
  return plain ? t.toLowerCase() : t;
}

type Kind = "goods" | "vehicle" | "food" | "lesson" | "service" | "salon" | "rent" | "sale" | "stay" | "ride" | "job" | "supply" | "freight" | "equipment" | "event" | "pet" | "other";
const KIND: Record<string, Kind> = {
  goods: "goods", vehicles: "vehicle", food: "food", lessons: "lesson", services: "service", tasks: "service",
  "property-rent": "rent", "commercial-lease": "rent", "property-sale": "sale", stays: "stay", rides: "ride", jobs: "job",
  wholesale: "supply", manufacturing: "supply", freight: "freight", "equipment-rental": "equipment", events: "event", pets: "pet", beauty: "salon",
};
export const kindOf = (category: string | null | undefined): Kind => KIND[category ?? ""] ?? (domain(category ?? "")?.family === "goods" ? "goods" : "other");

/** What a buyer does with it on the card: buy a number, book a time, ask to see it first. (By what changes hands.) */
export type ShopAction = "buy" | "book" | "visit" | "ask";
const ACTION: Record<Kind, ShopAction> = {
  goods: "buy", food: "buy", supply: "buy", other: "buy",
  lesson: "book", service: "book", salon: "book", pet: "book", event: "book", stay: "book", equipment: "book", ride: "book", freight: "book",
  rent: "visit", sale: "visit", vehicle: "visit", job: "visit",
};
export const actionOf = (category: string | null | undefined): ShopAction => ACTION[kindOf(category)];

/**
 * The questions for one offering. Gemini writes them for each listing when it's published, from what that listing
 * says (offer.questions). Until then, or without the model, they're built from the listing's own data only — whether
 * its stock or times are tracked, how it's bought, whether it has a price — never canned wording by category.
 */
export function forOffer(f: Fact, tracked: Tracked = null): Suggestion[] {
  if (!f.offer) return [];
  const id = f.id, s = (label: string, text: string): Suggestion => ({ label, text, offerId: id });
  if (f.offer.questions?.length) return f.offer.questions.slice(0, 3).map(q => s(q.label, q.text));
  const it = itemName(f.offer.title), priced = f.offer.price?.amount != null, action = actionOf(f.offer.category);
  const when = tracked === "slots" ? s("Next free", `What's your next free time for ${it}?`)
    : tracked === "quantity" ? s("In stock?", `Do you have ${it} in stock?`)
    : action === "book" ? s("When free?", `When are you free for ${it}?`)
    : action === "visit" ? s("Available?", `Is ${it} still available?`)
    : s("Available?", `Can I get ${it} now?`);
  return [when, s("Price", priced ? `What's your best price for ${it}?` : `How much is ${it}?`)];
}

/**
 * What a visitor might ask: one offering → its three questions; several → whether the first two are there, the first
 * one's price, and what else they have; nothing offered (a person, not a shop) → questions about them, which their
 * agent answers from what they share or takes to them.
 */
export function suggestionsFor(name: string, facts: Fact[], tracked: Record<string, Tracked> = {}): Suggestion[] {
  const offers = facts.filter(f => f.tier === "public" && f.offer && f.offer.status !== "sold").sort((a, b) => b.updatedAt - a.updatedAt);
  if (!offers.length) {
    const first = name.split(" ")[0] || "them";
    return [{ label: "Looking for", text: "What are you looking for right now?", offerId: null },
      { label: "Free?", text: "Are you free this weekend?", offerId: null },
      { label: "About", text: `What do you do, ${first}?`, offerId: null }];
  }
  if (offers.length === 1) return forOffer(offers[0], tracked[offers[0].id] ?? null);
  const [a, b] = offers.map(f => forOffer(f, tracked[f.id] ?? null));
  return [a[0], b[0], a[1], { label: "More", text: "What else do you have?", offerId: null }];
}
