// Direct conversations (a QR code or a link, no listing with a price): two people chat through their agents, and a
// message that names a price — "I'll sell for 100rs", "₹450 for both?", "can do 2.5 lakh" — is an offer of a deal.
// The other person gets Accept / Decline; both confirming makes it a deal with a receipt, like any negotiated one.

const SCALE: Record<string, number> = { k: 1_000, thousand: 1_000, lakh: 100_000, lakhs: 100_000, cr: 10_000_000, crore: 10_000_000 };
// Numbers that count things, not rupees.
const UNIT = /^\s*(?:x\b|×|bottles?|items?|pcs|pieces?|units?|litres?|liters?|ltr|l\b|ml|kg|g\b|grams?|days?|hours?|hrs?|months?|weeks?|years?|people|persons?|km|m\b|bhk|sq\.?\s*ft|ft|inch(?:es)?|cm|%|am\b|pm\b)/i;

/** The rupee amount a chat message offers, or null when it doesn't name one. */
export function offeredPrice(text: string): number | null {
  const t = text.replace(/(\d),(?=\d)/g, "$1");
  const pick = (n: string, scale?: string) => {
    const v = Math.round(Number(n) * (scale ? SCALE[scale.toLowerCase()] ?? 1 : 1));
    return Number.isFinite(v) && v >= 1 && v <= 1e9 ? v : null;
  };
  // ₹100, rs 100, inr 100, Rs.2.5 lakh
  let m = t.match(/(?:₹|\brs\.?\s*|\binr\s*)(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|cr|crore)?\b/i);
  if (m) return pick(m[1], m[2]);
  // 100rs, 100 rupees, 100/-, 2 lakh rupees
  m = t.match(/\b(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|cr|crore)?\s*(?:rs\b\.?|rupees?\b|₹|\/-|inr\b)/i);
  if (m) return pick(m[1], m[2]);
  // "sell for 400", "deal at 2.5 lakh", "can you do 350" — a selling word, then a number that isn't a count.
  if (!/\b(sell|buy|offer|deal|price|pay|cost|rate|quote|give)\b/i.test(t)) return null;
  for (const x of t.matchAll(/\b(?:for|at|pay|do|offer|price(?: is)?|is|of)\s+(\d+(?:\.\d+)?)\s*(k|thousand|lakhs?|cr|crore)?\b/gi)) {
    const after = t.slice((x.index ?? 0) + x[0].length);
    if (!x[2] && UNIT.test(after)) continue;
    const v = pick(x[1], x[2]);
    if (v !== null && v >= 10) return v;
  }
  return null;
}
