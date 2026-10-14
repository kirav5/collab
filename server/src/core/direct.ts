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

/** What a chat deal is for, from the message that offered it: "I'll sell you the 200 ml bottle for ₹100" → "200 ml bottle". */
export function dealItem(text: string): string | null {
  const t = text
    .replace(/(?:₹|\brs\.?\s*|\binr\s*)\s*[\d,]+(?:\.\d+)?\s*(?:k|thousand|lakhs?|cr|crore)?\b/gi, " ")
    .replace(/\b[\d,]+(?:\.\d+)?\s*(?:k|thousand|lakhs?|cr|crore)?\s*(?:rs\b\.?|rupees?\b|\/-|inr\b)/gi, " ")
    .replace(/^\s*(?:ok(?:ay)?|yes|sure|fine|great)?[,!.]?\s*/i, "")
    .replace(/^(?:i'?ll|i will|i can|we can|we'?ll|can)\s+(?:sell|give|do|pay|offer|let you have|buy|take)\s*(?:you\s+)?(?:it\s+)?/i, "")
    .replace(/\b(?:for|at|in)\s*(?:just|only)?\s*[.?!]*\s*$/i, "")
    .replace(/\b(?:deal\s+)?(?:at|for)\s+[\d,]+(?:\.\d+)?\s*(?:k|thousand|lakhs?|cr|crore)\b/gi, " ")
    .replace(/^\s*(?:deal|offer)\b\s*/i, "")
    .replace(/^\s*for\s+/i, "")
    .replace(/^(?:the|a|an|my|this|that|these|those)\s+/i, "")
    .replace(/\s+/g, " ").replace(/[\s,.?!-]+$/, "").trim();
  return t.length >= 3 ? t.slice(0, 80) : null;
}

const CURRENCY: [RegExp, string][] = [[/₹|\brs\.?(?=\s*\d)|\b(inr|rupees?)\b|\d\s*rs\b|\/-/i, "INR"], [/\$|\b(usd|dollars?)\b/i, "USD"],
  [/€|\b(eur|euros?)\b/i, "EUR"], [/£|\b(gbp|pounds?)\b/i, "GBP"], [/¥|\b(jpy|yen)\b/i, "JPY"], [/\b(aed|dirhams?)\b/i, "AED"]];

/** The amount and currency a chat message offers. `fallback` applies when no currency is written (e.g. "for 400"). */
/**
 * On a listing that already has a price, a named price is an offer only when the words make one ("I'll buy it for
 * ₹350", "can you do ₹350?", "final ₹380, deal?") — "Is it ₹400?" or "Why ₹400?" stay questions.
 */
export function explicitOffer(text: string): boolean {
  const t = text.trim();
  if (/^(why|is|are|was|does|did|when|where|which|who)\b/i.test(t) || /^(what|how)\b(?!\s+about\b)/i.test(t)) return false;
  return /\b(i'?ll|i will|i can|i'?d|we'?ll|we can|let'?s|ok(ay)?|final|deal|offer|take it|sell|buy|pay|give|can you do|could you do|would you do|how about|what about)\b/i.test(t);
}

export function offeredMoney(text: string, fallback: string): { amount: number; currency: string } | null {
  const named = CURRENCY.find(([re]) => re.test(text))?.[1];
  const t = named && named !== "INR" ? text.replace(/[$€£¥]\s*/g, "₹").replace(/\b(usd|dollars?|eur|euros?|gbp|pounds?|jpy|yen|aed|dirhams?)\b/gi, "rupees") : text;
  const amount = offeredPrice(t);
  return amount === null ? null : { amount, currency: named ?? fallback };
}
