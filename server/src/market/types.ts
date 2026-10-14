// The market's shapes, as in Collab's Market module (Offer, Need, DemandFilter, Mandate, Proposal).

export interface Money { amount: number; currency: string; period?: string | null }

/** A public area, never a home: the centre of a named neighbourhood or city. */
export interface Place { name: string; lat: number; lon: number; isCity: boolean }
export const ONLINE: Place = { name: "Online", lat: 0, lon: 0, isCity: true };
export const isOnline = (p: Place) => p.name === "Online" && p.lat === 0 && p.lon === 0;

export type ServiceMode = "online" | "in_person" | "either";

export interface Offer {
  id: string;
  category: string;
  title: string;
  details: string;
  price: Money;
  place: Place;
  /** Listing facts by the category's term keys ("bedrooms": "2"). */
  attributes: Record<string, string>;
  /** Questions the seller wants answered by interested buyers. */
  askBuyer: string[];
  minBudget?: number | null;
  publishedAt: number;
  expiresAt: number;
  status: "active" | "sold";
  /** The seller's Nostr key (hex), set on listings read from the index. */
  seller?: string;
  /** A Collab account binding is present (listings published by the Collab app). */
  collabBound?: boolean;
  atprotoHandle?: string | null;
}

export interface DemandFilter {
  id: string;
  label: string;
  kind: "place" | "price" | "number" | "choice" | "text";
  comparison: "equals" | "atMost" | "atLeast" | "oneOf" | "mentions";
  value: string;
  unit?: string | null;
  strength: "required" | "preferred";
  source: "stated" | "implied";
  evidence: string;
  question?: string | null;
}

export interface Bounds { opening: number; limit: number }

/** An owner's private negotiating limits. Never published, never sent, never shown to the other side's model. */
export interface Mandate { price: Bounds; terms: Record<string, Bounds>; maxRounds: number }

export interface Need {
  id: string;
  category: string;
  text: string;
  place: Place;
  radiusKm: number;
  maxPrice?: number | null;
  attributes: Record<string, string>;
  mustAsk: string[];
  unit?: string | null;
  mode?: ServiceMode | null;
  filters: DemandFilter[];
  mandate?: Mandate | null;
}

/** `items`: several lines or quantities agreed together; then `price` is their total. Without it, `price` is per the
 *  offer's unit, and `terms.quantity` (when above 1) multiplies it. */
export interface Proposal { id: string; price: number; terms: Record<string, number>; round: number; items?: LineItem[] }
export interface LineItem { id: string; title: string; quantity: number; unitPrice: number }

export type Side = "seller" | "buyer";

export const newId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

/** "₹80 L", "₹1.2 Cr", "₹35,000/month". */
const SYMBOLS: Record<string, string> = { INR: "₹", USD: "$" };
/** The currency a conversation's amounts are in (absent: INR, the original single currency). */
export const currencyOf = (e: { offer: { currency?: string } }) => e.offer.currency ?? "INR";

export function moneyText(m: Money): string {
  const symbol = SYMBOLS[m.currency] ?? m.currency + " ";
  const suffix = m.period ? `/${m.period}` : "";
  const trim = (v: number) => v.toFixed(2).replace(/\.?0+$/, "");
  if (m.currency === "INR") {
    if (m.amount >= 10_000_000) return `${symbol}${trim(m.amount / 10_000_000)} Cr${suffix}`;
    if (m.amount >= 100_000) return `${symbol}${trim(m.amount / 100_000)} L${suffix}`;
  }
  return symbol + Math.round(m.amount).toLocaleString(m.currency === "INR" ? "en-IN" : "en-US") + suffix;
}
