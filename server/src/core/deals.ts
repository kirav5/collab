// What the market learns from agreed deals. A Deal is anonymised — no uid, name, or private limit ever enters it —
// so the medians can be shown to anyone asking for the same category and area. Receipts give both sides a signed
// record of what their agents agreed; the hash covers the engagement, the terms and the parties' handles, nothing else.
import { createHash } from "node:crypto";
import type { Docs } from "../docs.ts";
import { moneyText } from "../market/types.ts";
import type { Engagement, Side } from "./model.ts";
import { ENGAGEMENTS } from "./engage.ts";

export const DEALS = "deals";

/** Anonymised record of one agreed deal: what the market can learn from it. No people, no limits. */
export interface Deal {
  id: string; engagementId: string; category: string; area: string | null; unit: string | null;
  listPrice: number; dealPrice: number; discountPct: number; rounds: number; hours: number; questions: number; at: number; demo?: boolean;
  /** What changed hands (the offering's title), so broad categories compare like with like. */
  item?: string;
}

/** Categories too broad to compare by category alone ("goods" holds both phones and water bottles). */
export const BROAD = new Set(["goods", "other", "tasks", "events", "vehicles"]);
const STOP = new Set(["for", "sale", "the", "and", "with", "new", "used", "items", "item", "near", "online", "home", "your", "from"]);
const words = (s: string) => new Set((s.toLowerCase().match(/\p{L}{3,}/gu) ?? []).filter(w => !STOP.has(w)).map(w => w.replace(/(es|s)$/, "")));
/** Two item descriptions name the same kind of thing (a word in common, ignoring filler). */
export function sameItem(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  return [...x].some(w => y.has(w));
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function dealOf(e: Engagement, now: number): Deal | null {
  if (e.phase !== "agreed" || !e.negotiation.deal || !e.offer.price || !e.offer.category) return null;
  const list = e.offer.price, deal = e.negotiation.deal.price;
  return { id: `deal-${e.id}`, engagementId: e.id, category: e.offer.category, area: e.brief.area ?? null, unit: e.offer.unit,
    listPrice: list, dealPrice: deal, discountPct: round1(((list - deal) / list) * 100),
    rounds: e.negotiation.requester.length + e.negotiation.provider.length, hours: round1((now - e.createdAt) / 3600),
    questions: e.qa.length, at: e.agreedAt ?? now, item: e.offer.title.slice(0, 120),
    ...(e.requester.uid?.startsWith("demo-") || e.provider.uid.startsWith("demo-") ? { demo: true } : {}) };
}

/** Writes the deal record once an engagement is agreed (called from save, guarded by dealRecorded). */
export async function recordDeal(db: Docs, e: Engagement, now: number) {
  const d = dealOf(e, now);
  if (d) await db.set(DEALS, d.id, d);
}

export interface Insights {
  n: number; scope: "area" | "category"; category: string; area: string | null; unit: string | null;
  median: number; p25: number; p75: number; discountPct: number; rounds: number; demo: boolean;
}

/** Linear-interpolation percentile over a sorted list. */
const pct = (s: number[], q: number) => { const p = (s.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p); return s[lo] + (s[hi] - s[lo]) * (p - lo); };

/** Closing-price stats for a category (or the area inside it), once at least 3 deals exist. Prices only compare
 *  within one unit: a per-visit median with per-day outliers is noise, so deals pool by `unit` (given or majority). */
export async function insights(db: Docs, q: { category: string; area?: string | null; unit?: string | null; item?: string | null }): Promise<Insights | null> {
  let all = (await db.find(DEALS, [["category", "==", q.category]], 500)) as Deal[];
  // In a broad category only deals for the same kind of item count; without an item, nothing comparable is known.
  if (BROAD.has(q.category)) all = q.item ? all.filter(d => d.item && sameItem(d.item, q.item!)) : [];
  if (q.unit !== undefined) all = all.filter(d => d.unit === q.unit);
  else {
    const byUnit = new Map<string | null, number>();
    for (const d of all) byUnit.set(d.unit, (byUnit.get(d.unit) ?? 0) + 1);
    const top = [...byUnit.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
    if (top !== undefined) all = all.filter(d => d.unit === top);
  }
  const inArea = q.area ? all.filter(d => d.area === q.area) : [];
  const scope = inArea.length >= 3 ? "area" : all.length >= 3 ? "category" : null;
  if (!scope) return null;
  const ds = scope === "area" ? inArea : all;
  const prices = ds.map(d => d.dealPrice).sort((a, b) => a - b);
  const discounts = ds.map(d => d.discountPct).sort((a, b) => a - b);
  const rounds = ds.map(d => d.rounds).sort((a, b) => a - b);
  return { n: ds.length, scope, category: q.category, area: scope === "area" ? q.area! : null,
    unit: ds[0]?.unit ?? null,
    median: Math.round(pct(prices, 0.5)), p25: Math.round(pct(prices, 0.25)), p75: Math.round(pct(prices, 0.75)),
    discountPct: round1(pct(discounts, 0.5)), rounds: Math.round(pct(rounds, 0.5)), demo: ds.every(d => d.demo) };
}

const inr = (n: number, unit: string | null) => moneyText({ amount: n, currency: "INR", period: unit });
const where = (i: Insights) => `${i.n} deal${i.n === 1 ? "" : "s"}${i.scope === "area" ? ` in ${i.area}` : ""}`;
/** People quote ₹37,600, not ₹37,619: three significant figures. */
const round3 = (p: number) => { const step = 10 ** Math.max(0, Math.floor(Math.log10(Math.max(p, 1))) - 2); return Math.round(p / step) * step; };
const expect = (i: Insights, asking: number) => `At ${inr(asking, i.unit)} asking, expect around ${inr(round3(asking * (1 - i.discountPct / 100)), i.unit)}.`;

export function forRequester(i: Insights, limit?: number | null, listPrice?: number | null): string[] {
  const lines = [`Similar deals closed at ${inr(i.p25, i.unit)}–${inr(i.p75, i.unit)} (median ${inr(i.median, i.unit)}, ${where(i)}).`,
    `Typically ~${i.discountPct}% under asking, in about ${i.rounds} rounds.`];
  if (listPrice) lines.push(expect(i, listPrice));
  if (limit) {
    if (limit < i.p25) lines.push("Your limit is below where most similar deals closed — expect a longer negotiation.");
    else if (limit > i.p75) lines.push("Your limit is above where most similar deals closed — you can likely close under it.");
  }
  if (i.demo) lines.push("(from demo deals)");
  return lines;
}

export function forProvider(i: Insights, asking?: number | null): string[] {
  const lines = [`Similar listings agreed at median ${inr(i.median, i.unit)} (${where(i)}), ~${i.discountPct}% under asking.`,
    `Deals usually close in about ${i.rounds} rounds.`];
  if (asking) {
    lines.push(expect(i, asking));
    if (asking > i.p75 * 1.15) lines.push("Your asking price is above the range similar deals closed in.");
    else if (asking < i.p25) lines.push("Your asking price is already below where similar deals closed — little room needed.");
  }
  if (i.demo) lines.push("(from demo deals)");
  return lines;
}

export interface Receipt {
  engagementId: string; taskId: string | null;
  terms: { title: string; price: number; unit: string | null; category: string | null; terms: Record<string, number> };
  parties: { requester: { handle: string; name: string }; provider: { handle: string; name: string } };
  confirmedBy: { requester: "owner" | "mandate"; provider: "owner" | "mandate" };
  at: number; hash: string; signatures: { requester: string | null; provider: string | null };
}

/** The deal both sides confirmed, hashed and signed per owner — a receipt either can keep or show. */
export const RECEIPTS = "receipts";

/** The agreed terms, both parties and the time, hashed (SHA-256): any later change to them changes the hash. */
/**
 * The task id the agreement was sealed with. A conversation started from someone's card can be agreed before any A2A
 * task exists; paying in the app later creates one — that must not change what was agreed.
 */
const sealedTask = (e: Engagement) => (e.sealedTaskId !== undefined ? e.sealedTaskId : e.taskId);

export function sealed(e: Engagement) {
  // `currency` joins the sealed terms only for deals that have one, so receipts registered before it still verify.
  const terms = { title: e.offer.title, price: e.negotiation.deal!.price, unit: e.offer.unit, category: e.offer.category, terms: e.negotiation.deal!.terms,
    ...(e.offer.currency ? { currency: e.offer.currency } : {}), ...(e.offer.policies?.length ? { policies: e.offer.policies } : {}) };
  const parties = { requester: { handle: e.requester.handle, name: e.requester.name }, provider: { handle: e.provider.handle, name: e.provider.name } };
  const at = e.agreedAt ?? e.events.find(ev => ev.who === "system" && ev.text.startsWith("Deal agreed"))?.at ?? e.createdAt;
  const hash = createHash("sha256").update(JSON.stringify({ engagementId: e.id, taskId: sealedTask(e), terms, parties, at })).digest("hex");
  return { terms, parties, at, hash };
}

/** Registers the deal's hash once, at agreement (append-only: a registered receipt is never rewritten). */
export async function registerReceipt(db: Docs, e: Engagement, now: number, sign?: (uid: string, hash: string) => string) {
  if (e.phase !== "agreed" || !e.negotiation.deal) return;
  const { hash, at } = sealed(e);
  await db.update(RECEIPTS, e.id, (cur: unknown) => (cur ? null : { engagementId: e.id, hash, agreedAt: at, registeredAt: now, ...(sign ? { receipt: receipt(e, sign) } : {}) }));
}

/** Does the conversation still say what was registered when the deal was agreed? */
export async function verifyReceipt(db: Docs, e: Engagement): Promise<{ registered: boolean; matches: boolean; registeredAt: number | null }> {
  const r = (await db.get(RECEIPTS, e.id)) as { hash: string; registeredAt: number } | null;
  if (!r || !e.negotiation.deal) return { registered: !!r, matches: false, registeredAt: r?.registeredAt ?? null };
  // A deal sealed before any A2A task existed, from before the task id was pinned: if the record matches with no task,
  // that is what was agreed — pin it (the terms, parties and time must still match exactly).
  if (sealed(e).hash !== r.hash && e.sealedTaskId === undefined && e.taskId && sealed({ ...e, sealedTaskId: null }).hash === r.hash) {
    e.sealedTaskId = null;
    await db.update("engagements", e.id, (cur: Engagement | null) => (cur ? { ...cur, sealedTaskId: null } : null));
  }
  return { registered: true, matches: sealed(e).hash === r.hash, registeredAt: r.registeredAt };
}

export function receipt(e: Engagement, sign: (uid: string, hash: string) => string): Receipt | null {
  if (e.phase !== "agreed" || !e.negotiation.deal) return null;
  const { terms, parties, at, hash } = sealed(e);
  return { engagementId: e.id, taskId: sealedTask(e), terms, parties,
    confirmedBy: { requester: e.negotiation.confirmedBy?.requester ?? "owner", provider: e.negotiation.confirmedBy?.provider ?? "owner" },
    at, hash, signatures: { requester: e.requester.uid ? sign(e.requester.uid, hash) : null, provider: e.provider.uid ? sign(e.provider.uid, hash) : null } };
}

/** A person's track record: deals agreed, and what the other side said afterwards. */
const STATS = "stats", STATS_TTL = 600;
/** Forgets both parties' cached records (a deal was agreed, or what became of it changed). */
export async function clearStats(db: Docs, e: Engagement) { for (const uid of [e.requester.uid, e.provider.uid]) if (uid) { await db.delete(STATS, uid).catch(() => {}); await db.delete(RECORDS, uid).catch(() => {}); } }

/**
 * A seller's record, from the receipts registered at each agreement: sales, how many were handed over, any problems,
 * and for each recent sale what it was, how many, the month, and its receipt's fingerprint with the seller-side
 * signature over it — anyone can check that against Collab's public keys (/public/keys), while the receipt itself
 * (who bought, the price) stays with the two people. Public: what the next buyer, or their agent, weighs before trusting
 * a seller; it grows with every sale.
 */
const RECORDS = "records";
export interface SaleRecord { item: string; quantity: number; month: string; handedOver: boolean; problem: boolean; receipt: { hash: string; signature: string | null } | null }
export interface TrackRecord { sales: number; verified: number; handedOver: number; problems: number; since: number | null; recent: SaleRecord[] }
export async function trackRecord(db: Docs, uid: string, now = Math.floor(Date.now() / 1000)): Promise<TrackRecord> {
  const cached = (await db.get(RECORDS, uid)) as (TrackRecord & { at: number }) | null;
  if (cached && now - cached.at < STATS_TTL) { const { at: _a, ...rest } = cached; return rest; }
  const es = (await db.find(ENGAGEMENTS, [["participants", "array-contains", uid]], 300)) as Engagement[];
  const sold = es.filter(e => e.phase === "agreed" && e.negotiation.deal && e[e.seller ?? "provider"].uid === uid);
  const rows = await Promise.all(sold.map(async e => {
    const seller = e.seller ?? "provider", buyer = seller === "provider" ? "requester" : "provider", d = e.negotiation.deal!;
    const r = (await db.get(RECEIPTS, e.id)) as { hash: string; receipt?: Receipt } | null;
    const at = e.agreedAt ?? e.updatedAt;
    return { at, item: e.offer.title.split(" · ")[0].slice(0, 80), quantity: d.items?.length ? d.items.reduce((n, l) => n + l.quantity, 0) : d.terms?.quantity > 1 ? d.terms.quantity : 1,
      month: new Date(at * 1000).toISOString().slice(0, 7), handedOver: ["delivered", "accepted"].includes(e.fulfilment?.state ?? ""),
      problem: e.fulfilment?.state === "disputed" || e.outcome?.[buyer] === "fell_through", receipt: r ? { hash: r.hash, signature: r.receipt?.signatures?.[seller] ?? null } : null };
  }));
  rows.sort((a, b) => b.at - a.at);
  const out: TrackRecord = { sales: rows.length, verified: rows.filter(x => x.receipt).length, handedOver: rows.filter(x => x.handedOver).length,
    problems: rows.filter(x => x.problem).length, since: rows.length ? rows.at(-1)!.at : null, recent: rows.slice(0, 8).map(({ at: _a, ...x }) => x) };
  await db.set(RECORDS, uid, { ...out, at: now });
  return out;
}
export async function stats(db: Docs, uid: string, now = Math.floor(Date.now() / 1000)) {
  // Cached for ten minutes: search asks for every candidate's record, and each one is a scan of their conversations.
  const cached = (await db.get(STATS, uid)) as { deals: number; kept: number; fellThrough: number; at: number } | null;
  if (cached && now - cached.at < STATS_TTL) { const { at: _a, ...rest } = cached; return rest; }
  const es = (await db.find(ENGAGEMENTS, [["participants", "array-contains", uid]], 300)) as Engagement[];
  const agreed = es.filter(e => e.phase === "agreed");
  const said = (e: Engagement) => (e.requester.uid === uid ? e.outcome?.provider : e.outcome?.requester);
  const out = { deals: agreed.length, kept: agreed.filter(e => said(e) === "happened").length, fellThrough: agreed.filter(e => said(e) === "fell_through").length };
  await db.set(STATS, uid, { ...out, at: now });
  return out;
}
