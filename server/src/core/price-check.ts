import type { Docs } from "../docs.ts";
import type { GroundedResult, Model } from "../ai/gemini.ts";

export const PRICE_CHECKS = "price_checks";
export class PriceCheckError extends Error { status: number; constructor(status: number, message: string) { super(message); this.status = status; } }
export async function reserveCheck(db: Docs, uid: string, now: number) {
  const day = new Date(now * 1000).toISOString().slice(0, 10);
  const row = await db.update("rate", `price-check:${uid}:${day}`, cur => {
    if ((cur?.used ?? 0) >= 5) return null;
    return { used: (cur?.used ?? 0) + 1, expireAt: new Date((now + 172800) * 1000) };
  });
  if (!row) throw new PriceCheckError(429, "Five price checks used today. Resets at 00:00 UTC.");
  return 5 - row.used;
}

export function priceEvidence(g: GroundedResult) {
  let parsed: any;
  try { parsed = JSON.parse(g.text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")); } catch {
    // Natural-language grounded answers carry citation segments; JSON-only answers often do not.
    parsed = { items: g.supports.flatMap(s => {
      const prices = [...s.text.matchAll(/(?:INR|₹|Rs\.?)\s*([\d,]+(?:\.\d+)?)/gi)];
      if (prices.length !== 1 || !/per item/i.test(s.text)) return [];
      return [{ label: s.text, price: Number(prices[0][1].replaceAll(",", "")), unit: "each" }];
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
    items.push({ label: i.label.slice(0, 240), price: i.price, unit: i.unit.slice(0, 60), sources });
  }
  const comparable = items.length >= 2 && items.every(i => i.unit === items[0].unit);
  const prices = items.map(i => i.price).sort((a, b) => a - b);
  return { status: comparable ? "evidence" : "insufficient_evidence", currency: "INR", items,
    low: comparable ? prices[0] : null, high: comparable ? prices.at(-1) : null,
    typical: comparable ? (prices[Math.floor((prices.length - 1) / 2)] + prices[Math.ceil((prices.length - 1) / 2)]) / 2 : null,
    unit: comparable ? items[0].unit : null, searchEntryPoint: g.searchEntryPoint,
    sources: g.sources.filter(s => /^https:\/\//.test(s.url)),
    note: "Search-based asking prices, not a guaranteed fair value or completed sale price. Check condition, size and quantity." };
}

export async function checkPrice(db: Docs, model: Model | null, uid: string, item: string, area: string, now: number) {
  if (!item.trim()) throw new PriceCheckError(400, "Describe the item first.");
  if (!model?.grounded) throw new PriceCheckError(503, "Grounded search is not available in this environment.");
  const remaining = await reserveCheck(db, uid, now);
  const g = await model.grounded(item, area);
  if (!g) throw new PriceCheckError(503, "Search could not finish. This attempt counts toward today's five checks.");
  const result = { ...priceEvidence(g), owner: uid, item, area, checkedAt: now, remaining };
  // Separate owner-only collection: never written to shared briefs, engagements, or A2A turns.
  await db.set(PRICE_CHECKS, uid, result);
  return result;
}
