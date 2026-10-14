// Operational policy: the values that are product decisions rather than code invariants — quotas, time windows,
// negotiation bounds, supported currencies, model routes and optional features. One validated object, loaded at
// start: defaults here, overridden by POLICY_JSON (a JSON object) and then POLICY_FILE (a path). Unknown keys and
// out-of-range values stop the server from starting, so a typo can't silently change behaviour. Its hash is on
// /health and stamped on new conversations, so what a task ran under can be reconstructed.
//
// Not here, on purpose: authorisation, signature checks, atomic reservations and other security invariants. Those
// stay in code; configuration can't weaken them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface Policy {
  quotas: { priceChecksPerDay: number; nearbyPerDay: number };
  negotiation: { maxRounds: number };
  timing: { checkoutValiditySec: number; cartValidityDays: number; paymentClaimStaleSec: number; a2aTurnBudgetMs: number;
    holdTtlSec: number; decisionTtlSec: number; anonymousTokenDays: number };
  money: { currencies: string[]; defaultCurrency: string };
  models: { grounding: string };
  features: { priceCheck: boolean; mapsNearby: boolean; googlePayTest: boolean };
}

export const DEFAULT_POLICY: Policy = {
  // 0 = no daily cap (the owner's decision for now; set a number to cap search/Maps spend per account).
  quotas: { priceChecksPerDay: 0, nearbyPerDay: 0 },
  negotiation: { maxRounds: 5 },
  timing: { checkoutValiditySec: 600, cartValidityDays: 7, paymentClaimStaleSec: 120, a2aTurnBudgetMs: 35_000,
    holdTtlSec: 900, decisionTtlSec: 86_400, anonymousTokenDays: 7 },
  money: { currencies: ["INR", "USD"], defaultCurrency: "INR" },
  models: { grounding: "gemini-3.8-flash" },
  features: { priceCheck: true, mapsNearby: true, googlePayTest: true },
};

// [min, max] for every number; currencies are ISO 4217 codes the money code can format and parse.
const RANGES: Record<string, [number, number]> = {
  "quotas.priceChecksPerDay": [0, 10_000], "quotas.nearbyPerDay": [0, 10_000], "negotiation.maxRounds": [1, 20],
  "timing.checkoutValiditySec": [60, 3600], "timing.cartValidityDays": [1, 60], "timing.paymentClaimStaleSec": [30, 900],
  "timing.a2aTurnBudgetMs": [5_000, 50_000], "timing.holdTtlSec": [60, 7 * 86_400], "timing.decisionTtlSec": [300, 30 * 86_400],
  "timing.anonymousTokenDays": [1, 30],
};
export const KNOWN_CURRENCIES = ["INR", "USD"];

export class PolicyError extends Error {}

/** Merges `over` into `base`, rejecting keys `base` doesn't have and values of the wrong type or out of range. */
function merge(base: any, over: any, path: string): any {
  if (over === undefined) return base;
  if (Array.isArray(base)) {
    if (!Array.isArray(over) || over.some(x => typeof x !== "string")) throw new PolicyError(`${path} must be a list of strings`);
    return [...over];
  }
  if (base !== null && typeof base === "object") {
    if (over === null || typeof over !== "object" || Array.isArray(over)) throw new PolicyError(`${path || "policy"} must be an object`);
    for (const k of Object.keys(over)) if (!(k in base)) throw new PolicyError(`unknown policy key: ${path ? path + "." : ""}${k}`);
    return Object.fromEntries(Object.keys(base).map(k => [k, merge(base[k], over[k], path ? `${path}.${k}` : k)]));
  }
  if (typeof over !== typeof base) throw new PolicyError(`${path} must be a ${typeof base}`);
  if (typeof over === "number") {
    const r = RANGES[path];
    if (!Number.isFinite(over) || (r && (over < r[0] || over > r[1]))) throw new PolicyError(`${path} must be between ${r?.[0]} and ${r?.[1]}`);
  }
  return over;
}

export function validatePolicy(p: Policy): Policy {
  const bad = p.money.currencies.filter(c => !KNOWN_CURRENCIES.includes(c));
  if (bad.length) throw new PolicyError(`unsupported currencies: ${bad.join(", ")} (known: ${KNOWN_CURRENCIES.join(", ")})`);
  if (!p.money.currencies.length) throw new PolicyError("money.currencies can't be empty");
  if (!p.money.currencies.includes(p.money.defaultCurrency)) throw new PolicyError("money.defaultCurrency must be one of money.currencies");
  if (!/^[a-z0-9.-]{3,60}$/i.test(p.models.grounding)) throw new PolicyError("models.grounding must be a model id");
  return p;
}

export function loadPolicy(env: Record<string, string | undefined> = process.env): Policy {
  let p = DEFAULT_POLICY as Policy;
  try {
    if (env.POLICY_JSON) p = merge(p, JSON.parse(env.POLICY_JSON), "");
    if (env.POLICY_FILE) p = merge(p, JSON.parse(readFileSync(env.POLICY_FILE, "utf8")), "");
  } catch (e) { throw e instanceof PolicyError ? e : new PolicyError(`policy isn't valid JSON: ${(e as Error).message}`); }
  // Model routes may also come from their established env variable.
  if (env.GEMINI_GROUNDING_MODEL) p = merge(p, { models: { grounding: env.GEMINI_GROUNDING_MODEL } }, "");
  return Object.freeze(validatePolicy(p)) as Policy;
}

const canonical = (x: unknown): string => x === null || typeof x !== "object" ? JSON.stringify(x)
  : Array.isArray(x) ? `[${x.map(canonical).join(",")}]` : `{${Object.keys(x as object).sort().map(k => `${JSON.stringify(k)}:${canonical((x as any)[k])}`).join(",")}}`;
export const policyHash = (p: Policy) => createHash("sha256").update(canonical(p)).digest("hex").slice(0, 16);

/** The process-wide policy (loaded once at start; tests may replace it). */
let current: Policy = DEFAULT_POLICY;
export const policy = () => current;
export const setPolicy = (p: Policy) => { current = p; };
