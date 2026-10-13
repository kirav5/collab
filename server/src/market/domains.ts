// What each market category means, loaded from data/domains.json (the same file the Collab app ships): its terms,
// units, which way each term is better for a buyer, how people ask about it, and default questions.
import { readFileSync } from "node:fs";
import type { ServiceMode } from "./types.ts";

export interface Term {
  key: string;
  label: string;
  kind: "number" | "text";
  unit?: string;
  buyerPrefers?: "lower" | "higher";
  required?: boolean;
  ask?: string;
}

export interface Domain {
  id: string;
  label: string;
  family: string;
  mode?: ServiceMode | null;
  priceUnit: string | null;
  units: string[];
  terms: Term[];
  sellerAsks: string[];
  buyerAsks: string[];
}

export const DOMAINS: Domain[] = JSON.parse(readFileSync(new URL("../data/domains.json", import.meta.url), "utf8")).domains;

export const domain = (id: string) => DOMAINS.find(d => d.id === id) ?? null;
export const term = (d: Domain | null, key: string) => d?.terms.find(t => t.key === key) ?? null;
export const negotiable = (d: Domain) => d.terms.filter(t => t.kind === "number" && t.buyerPrefers);

/** What the negotiating terms mean (Collab's TermCatalog). */
export interface Catalog {
  label: string;
  termLabel(key: string): string;
  termUnit(key: string): string | null;
  /** true if lower is better for the buyer, false if higher is, null if not negotiated. */
  buyerPrefersLower(key: string): boolean | null;
}

export function catalog(d: Domain | null): Catalog {
  return {
    label: d?.label ?? "general",
    termLabel: k => term(d, k)?.label ?? k.replace(/_/g, " "),
    termUnit: k => term(d, k)?.unit ?? null,
    buyerPrefersLower: k => { const p = term(d, k)?.buyerPrefers; return p ? p === "lower" : null; },
  };
}
