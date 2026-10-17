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
const COUNT_WORDS: Record<string, number> = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, dozen: 12, "a dozen": 12 };
// Sizes and spans that describe the thing rather than how many: "500 ml bottle", "2 BHK", "in 3 days".
const MEASURE = /^(ml|l|ltr|litres?|liters?|kg|kgs|g|gm|gms|grams?|cm|mm|m|inch(es)?|ft|feet|gb|tb|mah|w|watts?|v|bhk|years?|yrs?|months?|weeks?|days?|nights?|hours?|hrs?|minutes?|mins?|%|percent|am|pm|rs|rupees?|inr|k|lakhs?|cr)$/i;

/**
 * How many a typed offer is for: "2 bottles for ₹800" → 2, "a dozen for ₹500" → 12, "3 hours for ₹2,000" → 3 when the
 * listing is priced per hour. Sizes ("500 ml"), spans ("in 2 days") and prices ("for 500", "$20") aren't counts.
 * 1 only when said with what it is ("1 lamp"); null when no count is said.
 */
export function offeredQuantity(text: string, unit: string | null = null): number | null {
  const t = text.toLowerCase().replace(/(\d),(?=\d)/g, "$1")
    .replace(/(?:₹|\brs\.?\s*|\binr\s*)\s*\d+(?:\.\d+)?\s*(?:k|thousand|lakhs?|cr|crore)?\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:k|thousand|lakhs?|cr|crore)?\s*(?:rs\b\.?|rupees?\b|\/-|inr\b)/g, " ")
    // other currencies too: "$20", "€30", "20 dollars"
    .replace(/[$€£¥]\s*\d+(?:\.\d+)?\s*(?:k|thousand)?\b/g, " ")
    .replace(/\b\d+(?:\.\d+)?\s*(?:usd|dollars?|eur|euros?|gbp|pounds?|jpy|yen|aed|dirhams?)\b/g, " ");
  const own = unit ? new RegExp(`^${unit.replace(/s$/, "")}s?$`, "i") : null;
  for (const m of t.matchAll(/\b(\d{1,3}|two|three|four|five|six|seven|eight|nine|ten|a dozen|dozen)\s*(?:x\s*)?([a-z%]+)?/g)) {
    const n = /\d/.test(m[1]) ? Number(m[1]) : COUNT_WORDS[m[1]];
    const next = m[2] ?? "";
    if (!(n >= 1 && n <= 999)) continue;
    // "1 lamp" says one; "the 1 I saw", "1 more", "1 left" don't.
    if (n === 1 && (!/^\d/.test(m[1]) || /^(i|a|an|the|is|it|or|and|to|in|on|at|of|for|more|left|thing|time|day|question|sec|second)$/.test(next))) continue;
    if (!next) continue; // a bare number ("for 500") is a price, not a count
    if (MEASURE.test(next) && !(own && own.test(next))) continue;
    return n;
  }
  return null;
}

/**
 * Is an amount typed for `n` units their total, or the price of one? Words decide when they say ("each", "in all");
 * otherwise the reading closer to the price on the table (`ref`: the pending offer's, else the listed one) wins — "I
 * can do ₹420" in a deal for 5 lamps at ₹450 is ₹420 each, "2 for ₹800" for ₹450 bottles is ₹800 for both. With
 * nothing to compare, an amount for several is their total.
 */
export function amountIsTotal(text: string, unit: string | null, amount: number, n: number, ref: number | null): boolean {
  if (n <= 1) return true;
  if (perUnit(text, unit)) return false;
  if (/\b(in all|in total|total|altogether|all together|for (?:all|the lot|everything|all of them|both))\b/i.test(text)) return true;
  if (ref && ref > 0) return Math.abs(amount / n - ref) <= Math.abs(amount - ref);
  return true;
}

/** The typed price is per unit ("₹400 each", "₹400 per bottle", "400 ka ek"), not a total. */
export const perUnit = (text: string, unit: string | null = null) =>
  /\b(each|apiece|a piece|per (piece|pc|item|unit|bottle|one|plate|box|pack)|ek ka|har ek)\b|\/(each|pc|piece|unit)\b/i.test(text)
  || (!!unit && new RegExp(`\\b(per|a|an|\\/)\\s*${unit.replace(/s$/, "")}\\b`, "i").test(text));

/**
 * On a listing that already has a price, a named price is an offer only when the words make one ("I'll buy it for
 * ₹350", "can you do ₹350?", "final ₹380, deal?") — "Is it ₹400?" or "Why ₹400?" stay questions.
 */
export function explicitOffer(text: string): boolean {
  const t = text.trim();
  // An amount on its own with its currency ("200rs", "₹200", "Rs 200/-") or a stated budget ("my budget is ₹200",
  // "I can pay up to 200") is an offer, not a question for the seller to answer.
  if (/^(?:(?:my\s+)?(?:budget|max(?:imum)?|best|final|last offer)\s*(?:is|:)?\s*)?(?:₹|rs\.?|inr)\s*\d[\d,]*(?:\.\d+)?\s*(?:k|only|max|each|\/-)?\s*[.!?]?$/i.test(t)
    || /^(?:(?:my\s+)?(?:budget|max(?:imum)?|best|final|last offer)\s*(?:is|:)?\s*)?\d[\d,]*(?:\.\d+)?\s*(?:k\s*)?(?:rs\.?|rupees?|\/-|inr)\s*(?:only|max|each)?\s*[.!?]?$/i.test(t)
    || /\b(?:my budget|budget is|budget of|i can (?:only )?(?:pay|spend|afford)|up ?to)\s*(?:is\s*)?(?:₹|rs\.?|inr)?\s*\d/i.test(t)
    // "40 for ₹7,200", "2 bottles @ ₹400", "₹800 for 2"
    || /^\d{1,3}\s*(?:x\s*)?(?:[a-z]+\s+){0,2}(?:for|at|@)\s*(?:₹|rs\.?\s*|inr\s*)\d/i.test(t)
    || /^(?:₹|rs\.?\s*|inr\s*)\d[\d,]*(?:\.\d+)?\s*(?:for|each|per)\b/i.test(t)) return true;
  if (/^(why|is|are|was|does|did|when|where|which|who)\b/i.test(t) || /^(what|how)\b(?!\s+about\b)/i.test(t)) return false;
  return /\b(i'?ll|i will|i can|i'?d|we'?ll|we can|let'?s|ok(ay)?|final|deal|offer|take it|sell|buy|pay|give|can you do|could you do|would you do|how about|what about)\b/i.test(t);
}

export function offeredMoney(text: string, fallback: string): { amount: number; currency: string } | null {
  const named = CURRENCY.find(([re]) => re.test(text))?.[1];
  const t = named && named !== "INR" ? text.replace(/[$€£¥]\s*/g, "₹").replace(/\b(usd|dollars?|eur|euros?|gbp|pounds?|jpy|yen|aed|dirhams?)\b/gi, "rupees") : text;
  const amount = offeredPrice(t);
  return amount === null ? null : { amount, currency: named ?? fallback };
}
