import type { Docs } from "../docs.ts";
import type { GroundedResult, Model } from "../ai/gemini.ts";
import { policy } from "../config/policy.ts";

export const PRICE_CHECKS = "price_checks";
export class PriceCheckError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export async function reserveCheck(db: Docs, uid: string, now: number) {
  const limit = policy().quotas.priceChecksPerDay;
  if (!limit) return null; // no cap
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const row = await db.update("rate", `price-check:${uid}:${day}`, cur => {
    if ((cur?.used ?? 0) >= limit) return null;
    return { used: (cur?.used ?? 0) + 1, expireAt: new Date((now + 172800) * 1000) };
  });
  if (!row) throw new PriceCheckError(429, `All ${limit} price checks used today. Resets at 00:00 UTC.`);
  return limit - row.used;
}

/** Today's use of a per-day quota, for the app to show (the server enforces the same numbers). */
export async function quotaStatus(db: Docs, key: string, uid: string, limit: number, now: number) {
  if (!limit) return { limit: null, remaining: null, resetsAt: null };
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const used = ((await db.get("rate", `${key}:${uid}:${day}`)) as { used?: number } | null)?.used ?? 0;
  return { limit, remaining: Math.max(0, limit - used), resetsAt: Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000) + 86_400 };
}

/** "Thanish steel bottle 500 ml new costs INR 499 per item" → "Thanish steel bottle 500 ml new" (the price is shown beside it). */
export function cleanLabel(label: string): string {
  const verb = "(?:costs?|is priced at|priced at|sells? for|at|for)\\s*";
  const tail = new RegExp(`\\s*(?:[,–—-]\\s*(?:${verb})?|${verb})(?:INR|₹|Rs\\.?)\\s*[\\d,]+(?:\\.\\d+)?(?:\\s*(?:per|\\/)\\s*\\w+)?\\s*[.!]?\\s*$`, "i");
  const t = label.replace(tail, "").trim();
  return (t || label).replace(/^./, c => c.toUpperCase());
}

export function priceEvidence(g: GroundedResult, per = "item") {
  let parsed: any;
  try { parsed = JSON.parse(g.text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")); } catch {
    // Natural-language grounded answers carry citation segments; JSON-only answers often do not.
    parsed = { items: g.supports.flatMap(s => {
      const prices = [...s.text.matchAll(/(?:INR|₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/gi)];
      if (prices.length !== 1 || !new RegExp(`per (item|${per})`, "i").test(s.text)) return [];
      return [{ label: s.text, price: Number(prices[0][1].replaceAll(",", "")), unit: per === "item" ? "each" : per }];
    }) };
  }
  const items: { label: string; price: number; unit: string; sources: { title: string; url: string }[] }[] = [];
  for (const i of (Array.isArray(parsed.items) ? parsed.items : []).slice(0, 6)) {
    if (typeof i.label !== "string" || typeof i.unit !== "string" || !Number.isFinite(i.price) || i.price <= 0 || i.price > 1e9) continue;
    // Each price needs a supported segment AND an actual grounding chunk. Model-written URLs aren't accepted.
    const indices = new Set<number>();
    for (const s of g.supports) {
      const numbers = (s.text.match(/\d[\d,]*(?:\.\d+)?/g) ?? []).map(n => Number(n.replaceAll(",", "")));
      if (numbers.includes(i.price) && s.text.toLowerCase().includes(i.label.toLowerCase())) s.indices.forEach(n => indices.add(n));
    }
    const sources = [...indices].map(n => g.sources[n]).filter(s => s && /^https:\/\//.test(s.url));
    if (!sources.length || items.some(x => x.label === i.label && x.price === i.price)) continue;
    items.push({ label: cleanLabel(i.label).slice(0, 240), price: i.price, unit: i.unit.slice(0, 60), sources });
  }
  const comparable = items.length >= 2 && items.every(i => i.unit === items[0].unit);
  const prices = items.map(i => i.price).sort((a, b) => a - b);
  return { status: comparable ? "evidence" : "insufficient_evidence", currency: "INR", items,
    low: comparable ? prices[0] : null, high: comparable ? prices.at(-1) : null,
    typical: comparable ? Math.round((prices[Math.floor((prices.length - 1) / 2)] + prices[Math.ceil((prices.length - 1) / 2)]) / 2) : null,
    unit: comparable ? items[0].unit : null, searchEntryPoint: g.searchEntryPoint,
    sources: g.sources.filter(s => /^https:\/\//.test(s.url)),
    note: "Asking prices found on the web — not a guaranteed fair price or a completed sale. Compare like with like (size, condition, hours, quantity)." };
}

/** "hour", "night", "order"… — what one price is for; anything else is per item. */
export const priceUnit = (u: unknown) => (typeof u === "string" && /^[a-z]{2,12}$/i.test(u) && !/^(each|item|piece|unit)$/i.test(u) ? u.toLowerCase() : "item");

export async function checkPrice(db: Docs, model: Model | null, uid: string, item: string, area: string, now: number, unit: unknown = "item") {
  const per = priceUnit(unit);
  if (!policy().features.priceCheck) throw new PriceCheckError(503, "Price checks are turned off.");
  if (!item.trim()) throw new PriceCheckError(400, "Describe the item first.");
  if (!model?.grounded) throw new PriceCheckError(503, "Grounded search is not available in this environment.");
  const remaining = await reserveCheck(db, uid, now);
  const g = await model.grounded(item, area, per);
  if (!g) throw new PriceCheckError(503, "Google Search didn't answer in time. Try again in a minute.");
  const result = { ...priceEvidence(g, per), owner: uid, item, area, checkedAt: now, remaining };
  // Separate owner-only collection: never written to shared briefs, engagements, or A2A turns.
  await db.set(PRICE_CHECKS, uid, result);
  return result;
}
