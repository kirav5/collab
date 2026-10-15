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

type Kind = "goods" | "vehicle" | "food" | "lesson" | "service" | "rent" | "sale" | "stay" | "ride" | "job" | "supply" | "freight" | "equipment" | "event" | "pet" | "other";
const KIND: Record<string, Kind> = {
  goods: "goods", vehicles: "vehicle", food: "food", lessons: "lesson", services: "service", tasks: "service",
  "property-rent": "rent", "commercial-lease": "rent", "property-sale": "sale", stays: "stay", rides: "ride", jobs: "job",
  wholesale: "supply", manufacturing: "supply", freight: "freight", "equipment-rental": "equipment", events: "event", pets: "pet",
};
export const kindOf = (category: string | null | undefined): Kind => KIND[category ?? ""] ?? (domain(category ?? "")?.family === "goods" ? "goods" : "other");

/** Three questions about one offering: is it there, what does it cost, and the next step. */
export function forOffer(f: Fact, tracked: Tracked = null): Suggestion[] {
  if (!f.offer) return [];
  const it = itemName(f.offer.title), priced = f.offer.price?.amount != null, k = kindOf(f.offer.category), id = f.id;
  const s = (label: string, text: string): Suggestion => ({ label, text, offerId: id });
  const price = (best: string, ask: string) => s("Price", priced ? best : ask);
  switch (k) {
    case "goods": case "food": case "supply": return [
      s("In stock?", k === "food" ? `Can you make ${it} for tomorrow?` : `Do you have ${it} in stock?`),
      price(`What's your best price for ${it}?`, `How much is ${it}?`),
      k === "supply" ? s("Lead time", `What's your lead time for ${it}, and do you give a GST invoice?`) : s("Collect", `Can I order now and collect today?`)];
    case "vehicle": return [s("Available?", `Is the ${it} still available?`), price(`What's your best price for the ${it}?`, `How much is the ${it}?`),
      s("See it", "Can I see it this weekend? Are the RC and insurance in order?")];
    case "lesson": case "service": case "pet": return [
      s("When free?", tracked === "slots" ? `What times are free this week for ${it}?` : `Are you free this week for ${it}?`),
      price(`What's your best rate for ${it}?`, `What do you charge for ${it}?`),
      k === "lesson" ? s("Trial", "Can I book a trial session?") : s("Start", "Can you start this week?")];
    case "rent": case "sale": case "stay": return [
      s("Available?", k === "stay" ? `Is ${it} free this weekend?` : `Is ${it} still available?`),
      price(k === "rent" ? "Is the rent negotiable?" : `What's your best price for ${it}?`, `What's the price for ${it}?`),
      s("Visit", "Can I visit this weekend?")];
    case "ride": return [s("Pick up?", "Can you pick me up this evening?"), price("Is the fare negotiable?", "What's the fare?"), s("Book", "Can I book a ride for tomorrow morning?")];
    case "job": return [s("Open?", `Is the ${it} position still open?`), price("What's the salary range?", "What's the salary range?"), s("Process", "What's the interview process?")];
    case "freight": return [s("Vehicle?", "Is a vehicle free this week?"), price("Is the rate per trip negotiable?", "What's the rate per trip?"), s("Insurance", "Is transit insurance included?")];
    case "equipment": return [s("Free?", `Is the ${it} free this week?`), price("What's your best daily rate?", "What's the daily rate?"), s("Operator", "Is an operator included?")];
    case "event": return [s("Date free?", `Is ${it} available this Saturday?`), price(`What's your best price for ${it}?`, `What's the price for ${it}?`), s("Cancel", "What's the cancellation policy?")];
    default: return [s("Available?", `Is ${it} available?`), price(`What's your best price for ${it}?`, `How much is ${it}?`), s("When", "Can you do it this week?")];
  }
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
