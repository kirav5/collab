// “Did you get it?”, after a deal is paid. A buyer who paid and didn't get it says so; the seller is told at once and
// has a few days to reply or put it right. Nothing is public in that time, or ever if it's sorted. A report still
// standing after it shows on the seller's record as what the buyer said, next to the seller's answer — Collab never
// decides who is right, and the public line never carries notes, names or prices.
//
// Reports live in `reports`, one per deal, written once (like receipts and pickups), so no later save of the
// engagement can erase one; the engagement carries a copy for the deal card. Only a buyer who paid can report, only
// once the seller had their chance to hand it over, and guests, new accounts and demo sellers don't count publicly.
import type { Docs } from "../docs.ts";
import type { Engagement, Event, ReportView } from "./model.ts";
import { buyerOf, outsideConfirmed, paidFor, sellerOf } from "./pay.ts";
import { joinsOnLetter } from "./hiring.ts";
import { ENGAGEMENTS } from "./engage.ts";
import { type Policy, policy } from "../config/policy.ts";

export const REPORTS = "reports";

/** The record of one report (doc id = the engagement's). Seller and buyer are uids, never handles (handles are reused). */
export interface Report extends ReportView {
  schemaVersion: 1; id: string; engagementId: string;
  seller: string; buyer: string;
  /** For the public row: what it was (≤80) and the month, no price. */
  item: string; month: string;
}
type Reason = ReportView["reason"];
type Says = NonNullable<ReportView["reply"]>["says"];
type Rules = Policy["reports"];

export class ReportError extends Error { status: number; code?: string; extra?: Record<string, unknown>;
  constructor(status: number, message: string, code?: string, extra?: Record<string, unknown>) { super(message); this.status = status; this.code = code; this.extra = extra; } }

const quoted = (note?: string) => (note ? `: “${note}”` : ".");
/** What each side's step says in the deal's history (only the two of them see it). */
export const REPORT_LINE: Record<Reason, (note?: string) => string> = {
  not_received: note => `Says they paid and didn't get it${quoted(note)}`,
  not_as_agreed: note => `Reported a problem${quoted(note)}`,
};
export const REPLY_LINE: Record<Says, (note?: string) => string> = {
  handed_over: note => `Says they handed it over${quoted(note)}`,
  refunded: note => `Says they refunded it${quoted(note)}`,
  never_paid: note => `Says they were never paid${quoted(note)}`,
};

/** When a report can be made: from the time the seller had to hand it over (a day after paying, or the end of the
 *  booked time; at once if they say they did) until some weeks after. Null: nothing was paid. */
export function reportWindow(e: Engagement, p: Rules = policy().reports): { from: number; until: number } | null {
  const pay = e.payment, f = e.fulfilment;
  const base = pay?.status === "paid" || pay?.status === "outside" ? pay.paidAt ?? null : pay?.outsideClaim?.deniedAt ? pay.outsideClaim.at : null;
  if (base === null) return null;
  const from = f?.state === "delivered" ? f.deliveredAt ?? base : Math.max(base + p.waitHours * 3600, e.reservation?.slot?.end ?? 0);
  // Closes some weeks after it was due: handed over, else paid (or the booked time's end, if later).
  return { from, until: (f?.deliveredAt ?? Math.max(base, e.reservation?.slot?.end ?? 0)) + p.maxDays * 86_400 };
}

/** May this person report this deal now, for this reason? */
export function canReport(e: Engagement, uid: string, reason: Reason, now: number, p: Rules = policy().reports):
  { ok: true } | { ok: false; status: number; code: string; message: string; extra?: Record<string, unknown> } {
  const no = (status: number, code: string, message: string, extra?: Record<string, unknown>) => ({ ok: false as const, status, code, message, ...(extra ? { extra } : {}) });
  if (e[buyerOf(e)].uid !== uid) return no(403, "AUTHORITY_REQUIRED", "Only the person who paid can report this.");
  if (e.phase !== "agreed") return no(409, "VERSION_CONFLICT", "There's no agreed deal.");
  if (joinsOnLetter(e)) return no(409, "VERSION_CONFLICT", "This closes on joining — use the offer card.");
  if (e.noPayment) return no(409, "VERSION_CONFLICT", "Nothing is paid through Collab for this — sort it out in the chat.");
  const f = e.fulfilment?.state;
  if (f === "accepted") return no(409, "VERSION_CONFLICT", "You already said you got it.");
  if (f === "disputed") return no(409, "VERSION_CONFLICT", e.fulfilment?.report ? "You've already reported this deal." : "A problem was already reported on this deal.");
  if (f === "cancelled") return no(409, "VERSION_CONFLICT", "This deal was cancelled.");
  if (reason === "not_as_agreed" && f !== "delivered") return no(409, "VERSION_CONFLICT", "Nothing was handed over yet — if you didn't get it, say so instead.");
  const w = reportWindow(e, p);
  if (!w) return no(409, "NOT_PAID", "Nothing's been paid yet. If it fell through, tap “It fell through”.");
  if (now < w.from) return no(409, "TOO_EARLY", "It's early — they still have time to hand it over. Message them in the chat; if it still hasn't happened, you can report it here.", { reportFrom: w.from });
  if (now > w.until) return no(409, "TOO_LATE", `Reports close ${p.maxDays} days after paying (or after the booked time).`);
  return { ok: true };
}

/** Whether a report can count on the seller's public record (decided once, when it's filed). A report that doesn't
 *  still reaches the seller and runs the whole reply flow. */
export function countsFor(e: Engagement, who: { signIn: string; createdAt: number }, now: number, p: Rules = policy().reports): { counts: boolean; notCounted?: ReportView["notCounted"] } {
  const seller = e[sellerOf(e)].uid, buyer = e[buyerOf(e)].uid;
  if (seller?.startsWith("demo-") || buyer?.startsWith("demo-")) return { counts: false, notCounted: "demo" };
  if (!seller || seller === buyer) return { counts: false, notCounted: "self" };
  if (who.signIn === "anonymous") return { counts: false, notCounted: "guest" };
  if (now - who.createdAt < p.minAccountDays * 86_400) return { counts: false, notCounted: "new_account" };
  return { counts: true };
}

/** open: the seller still has time (not public). unanswered: no reply in time. disputed: the seller answered in time
 *  (both accounts stand). closed: withdrawn, refunded or voided (not public). */
export function reportStatus(r: Pick<ReportView, "replyBy" | "reply" | "end">, now: number): "open" | "unanswered" | "disputed" | "closed" {
  if (r.end) return "closed";
  if (now < r.replyBy) return "open";
  return r.reply && r.reply.at <= r.replyBy ? "disputed" : "unanswered";
}

/** What the engagement carries: the report without who, what or when it was for. */
export const viewOf = ({ schemaVersion: _v, id: _i, engagementId: _e, seller: _s, buyer: _b, item: _t, month: _m, ...view }: Report): ReportView => view;

/** The deal's state that goes with a report: open or standing is "disputed"; withdrawn is received; refunded is off. */
const stateOf = (r: Report, cur: NonNullable<Engagement["fulfilment"]>["state"]) =>
  r.end?.how === "withdrawn" ? "accepted" as const : r.end?.how === "refunded" ? "cancelled" as const : r.end ? cur : "disputed" as const;

/** Copies the report onto the engagement (and adds the step that changed it). */
async function mirror(db: Docs, r: Report, ev?: Event): Promise<Engagement | null> {
  return db.update(ENGAGEMENTS, r.engagementId, (cur: Engagement | null) => {
    if (!cur) return null;
    const f = cur.fulfilment ?? { state: "not_started" as const };
    return { ...cur, fulfilment: { ...f, state: stateOf(r, f.state), report: viewOf(r) }, ...(ev ? { events: [...cur.events, ev], updatedAt: ev.at } : {}) };
  });
}

/** Files the buyer's report: the deal turns "disputed" (the pass pauses, nothing more is handed over or marked) and
 *  the report is written once. A second report on the same deal is refused. */
export async function fileReport(db: Docs, e: Engagement, reason: Reason, note: string, standing: { counts: boolean; notCounted?: ReportView["notCounted"] }, now: number, p: Rules = policy().reports): Promise<Engagement> {
  const existing = (await db.get(REPORTS, e.id)) as Report | null;
  // Already there: put its copy back on the engagement in case a save raced it away.
  if (existing) { await mirror(db, existing); throw new ReportError(409, "You've already reported this deal.", "VERSION_CONFLICT"); }
  const pay = e.payment, buyer = buyerOf(e), seller = sellerOf(e);
  const payment: ReportView["payment"] = pay?.status === "paid" ? "in_app" : pay?.status === "outside" ? (outsideConfirmed(e) ? "outside_confirmed" : "outside_unconfirmed") : "outside_denied";
  const r: Report = { schemaVersion: 1, id: e.id, engagementId: e.id, seller: e[seller].uid ?? "", buyer: e[buyer].uid ?? "", reason, ...(note ? { note } : {}),
    at: now, replyBy: now + p.replyHours * 3600, payment, counts: standing.counts, ...(standing.notCounted ? { notCounted: standing.notCounted } : {}),
    // The seller already said the money never came: that is their answer.
    ...(payment === "outside_denied" && pay?.outsideClaim?.deniedAt ? { reply: { says: "never_paid" as const, at: pay.outsideClaim.deniedAt } } : {}),
    item: e.offer.title.split(" · ")[0].slice(0, 80), month: new Date(now * 1000).toISOString().slice(0, 7) };
  let refused: ReportError | null = null;
  const next = (await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => {
    if (!cur) return null;
    const ok = canReport(cur, r.buyer, reason, now, p);
    if (!ok.ok) { refused = new ReportError(ok.status, ok.message, ok.code, ok.extra); return null; }
    return { ...cur, fulfilment: { ...(cur.fulfilment ?? { state: "not_started" }), state: "disputed", report: viewOf(r) },
      events: [...cur.events, { at: now, who: buyer, text: REPORT_LINE[reason](note), by: "owner" }], updatedAt: now };
  })) as Engagement | null;
  if (!next) throw refused ?? new ReportError(409, "This deal changed — try again.", "VERSION_CONFLICT");
  await db.update(REPORTS, r.id, (cur: Report | null) => (cur ? null : r));
  return next;
}

/** The seller's one answer: they handed it over, refunded it, or (paid outside the app) were never paid. */
export async function replyReport(db: Docs, e: Engagement, uid: string, says: Says, note: string, now: number): Promise<Engagement> {
  const seller = sellerOf(e);
  if (e[seller].uid !== uid) throw new ReportError(403, "Only the seller can reply to this.", "AUTHORITY_REQUIRED");
  let why = "Nothing to reply to.";
  const r = (await db.update(REPORTS, e.id, (cur: Report | null) => {
    if (!cur || cur.end) return null;
    if (cur.reply) { why = "You've already replied."; return null; }
    if (says === "never_paid" && cur.payment === "in_app") { why = "It was paid in the app — reply that you handed it over or refunded."; return null; }
    return { ...cur, reply: { says, ...(note ? { note } : {}), at: now } };
  })) as Report | null;
  if (!r) throw new ReportError(409, why, "VERSION_CONFLICT");
  return (await mirror(db, r, { at: now, who: seller, text: REPLY_LINE[says](note), by: "owner" }))!;
}

/** The buyer closes their report: they got it after all (the deal is received), or confirm the refund the seller said
 *  they made (the sale is off, and neutral). */
export async function settleReport(db: Docs, e: Engagement, uid: string, how: "got_it" | "refunded", now: number): Promise<Engagement> {
  const buyer = buyerOf(e);
  if (e[buyer].uid !== uid) throw new ReportError(403, "Only the person who reported it can close it.", "AUTHORITY_REQUIRED");
  let why = "There's no open report on this deal.";
  const r = (await db.update(REPORTS, e.id, (cur: Report | null) => {
    if (!cur || cur.end) return null;
    if (how === "refunded" && cur.reply?.says !== "refunded") { why = "They haven't said they refunded you."; return null; }
    return { ...cur, end: { how: how === "got_it" ? "withdrawn" : "refunded", at: now } };
  })) as Report | null;
  if (!r) throw new ReportError(409, why, "VERSION_CONFLICT");
  return (await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => {
    if (!cur) return null;
    const f = cur.fulfilment ?? { state: "not_started" as const };
    return how === "got_it"
      ? { ...cur, fulfilment: { ...f, state: "accepted", acceptedAt: now, report: viewOf(r) }, outcome: { ...(cur.outcome ?? {}), [buyer]: "happened" }, inboxClosed: true,
          events: [...cur.events, { at: now, who: buyer, text: "Got it after all — report withdrawn.", by: "owner" }], updatedAt: now }
      : { ...cur, fulfilment: { ...f, state: "cancelled", note: "Refunded", report: viewOf(r) },
          events: [...cur.events, { at: now, who: buyer, text: "Confirmed the refund — report closed.", by: "owner" }], updatedAt: now };
  })) as Engagement;
}

/** What buyers said about a seller, for their public record: distinct buyers whose counted reports from the last
 *  `showDays` stand unanswered (by reason) or disputed. Read from `reports`, so no scan limit on deals can hide one.
 *  `byEngagement` has every report against them, counted or not (a deal with one is judged by it, not by the old rule). */
export async function reportsAgainst(db: Docs, uid: string, now: number, p: Rules = policy().reports) {
  const all = (await db.find(REPORTS, [["seller", "==", uid]], 500)) as Report[];
  const live = all.filter(r => r.counts && now - r.at <= p.showDays * 86_400);
  const buyers = (keep: (r: Report, status: string) => boolean) => new Set(live.filter(r => keep(r, reportStatus(r, now))).map(r => r.buyer)).size;
  return { notReceived: buyers((r, s) => s === "unanswered" && r.reason === "not_received"), notAsAgreed: buyers((r, s) => s === "unanswered" && r.reason === "not_as_agreed"),
    disputed: buyers((_, s) => s === "disputed"), days: p.showDays, byEngagement: new Map(all.map(r => [r.engagementId, r])) };
}

/** The cron's “Did you get it?”: once a paid deal's report window opens and nothing has been handed over, the buyer is
 *  asked once. Every due deal's `askAt` is removed (the key, so the range query skips it). Returns how many were asked. */
export async function askDidYouGetIt(db: Docs, now: number, push: (uid: string, title: string, body: string, link: string) => unknown): Promise<number> {
  const due = (await db.find(ENGAGEMENTS, [["askAt", "<=", now]], 100)) as Engagement[];
  let asked = 0;
  for (const e of due) {
    let ask = false;
    await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => {
      if (!cur || cur.askAt === undefined) return null;
      const { askAt: _a, ...rest } = cur;
      ask = cur.phase === "agreed" && (cur.fulfilment?.state ?? "not_started") === "not_started" && !cur.fulfilment?.askedAt && paidFor(cur);
      return ask ? { ...rest, fulfilment: { ...(cur.fulfilment ?? { state: "not_started" }), askedAt: now } } : rest;
    });
    const buyer = e[buyerOf(e)].uid;
    if (!ask || !buyer) continue;
    asked++;
    await Promise.resolve(push(buyer, `Did you get it? · ${e.offer.title.split(" · ")[0]}`, "Tap to confirm — or report it if you didn't.", `/?engagement=${e.id}`)).catch(() => {});
  }
  return asked;
}
