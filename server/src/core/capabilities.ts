// What this platform's agents can do, versioned, for discovery (TP-03). Built from the domain definitions in
// data/domains.json — adding a category there adds a capability, without code. Each capability says which actions
// it supports and what its requests look like; "collab.information" covers questions with nothing to buy.
import { DOMAINS } from "../market/domains.ts";
import { policy } from "../config/policy.ts";

export interface Capability {
  id: string; version: string; title: string; family: string;
  actions: string[];
  /** The request terms an agent may state (from the domain), and which are required. */
  terms: { key: string; label: string; kind: "number" | "text"; unit?: string; required?: boolean }[];
  pricing: { units: string[]; currencies: string[] } | null;
  fulfilment: ("in_person" | "online")[];
}

const TRADE = ["ask", "answer", "quote", "negotiate", "agree", "pay.test", "handover", "accept"];

export function capabilities(): Capability[] {
  const currencies = policy().money.currencies;
  const fromDomains = DOMAINS.map(d => ({
    id: `collab.${d.id}`, version: "1", title: d.label, family: d.family, actions: TRADE,
    terms: d.terms.map(t => ({ key: t.key, label: t.label, kind: t.kind, ...(t.unit ? { unit: t.unit } : {}), ...(t.required ? { required: true } : {}) })),
    pricing: { units: d.units, currencies },
    fulfilment: (d.mode === "online" ? ["online"] : d.mode === "in_person" ? ["in_person"] : ["in_person", "online"]) as Capability["fulfilment"],
  }));
  return [
    { id: "collab.information", version: "1", title: "Questions and answers", family: "information", actions: ["ask", "answer"], terms: [], pricing: null, fulfilment: ["online"] },
    ...fromDomains,
  ];
}

/** Checks a requested capability: null when it's supported (or none was named), else the structured refusal. */
export function unsupported(requested: { id?: unknown; version?: unknown } | undefined) {
  if (!requested || requested.id === undefined) return null;
  const all = capabilities();
  const match = all.find(c => c.id === requested.id);
  if (match && (requested.version === undefined || String(requested.version) === match.version)) return null;
  return { code: "UNSUPPORTED_CAPABILITY", requested, supported: match ? [{ id: match.id, versions: [match.version] }] : all.map(c => ({ id: c.id, versions: [c.version] })) };
}
