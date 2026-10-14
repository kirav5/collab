// Recurring goals and compensation for composed goals.
//   • Recurring: each period the agent searches again for the goal (never buys on its own) and tells the owner how
//     many fit. It stops itself when the goal's budget is used up or its end date passes.
//   • Compensation (all-or-nothing goals): if any part fails, the other parts' stock holds are released and their
//     unpaid deals cancelled (their budget returned); paid parts are listed for the owner to decide (a refund
//     request), never silently undone. Runs once per goal.
import type { Model } from "../ai/gemini.ts";
import type { Docs } from "../docs.ts";
import type { Place } from "../market/types.ts";
import { draft, saveBrief } from "./briefs.ts";
import { search } from "./directory.ts";
import { ENGAGEMENTS } from "./engage.ts";
import { GOALS, type Goal, budgetUse, deallocate, taskOf } from "./goals.ts";
import type { Engagement } from "./model.ts";
import { release } from "./resources.ts";

export async function runRecurrence(db: Docs, model: Model | null, g: Goal, here: Place | null, now: number, notify: (g: Goal, text: string) => Promise<void>): Promise<{ ran: boolean; found?: number; stopped?: string }> {
  const r = g.recurrence;
  if (!r || r.stopped || g.closed || r.nextAt > now) return { ran: false };
  const stop = async (why: string) => { await db.update(GOALS, g.id, (cur: Goal | null) => (cur?.recurrence ? { ...cur, recurrence: { ...cur.recurrence, stopped: why }, updatedAt: now } : null)); return { ran: false, stopped: why }; };
  if (now > r.until) return stop("ended");
  const b = budgetUse(g);
  if (b && b.used >= b.amount) return stop("budget used up");
  const d = await draft(model, g.outcome, here, now).catch(() => null);
  let found = 0;
  if (d?.draft) {
    const brief = await saveBrief(db, g.owner, d.draft.need, d.draft.shared, now);
    await db.merge("briefs", brief.id, { goalId: g.id });
    found = (await search(db, model, { ...brief, goalId: g.id }, g.owner).catch(() => null))?.found.length ?? 0;
  }
  await db.update(GOALS, g.id, (cur: Goal | null) => (cur?.recurrence ? { ...cur, recurrence: { ...cur.recurrence, rounds: cur.recurrence.rounds + 1, nextAt: now + cur.recurrence.everyDays * 86_400 }, updatedAt: now } : null));
  await notify(g, found ? `${found} match${found === 1 ? "" : "es"} for this round — choose whom to ask.` : "No one fits this round yet.").catch(() => {});
  return { ran: true, found };
}

export async function compensate(db: Docs, g: Goal, now: number) {
  if (!g.allOrNothing || g.compensation || g.closed) return null;
  const es = (await Promise.all(g.taskIds.map(id => db.get(ENGAGEMENTS, id)))).filter(Boolean) as Engagement[];
  const tasks = es.map(e => taskOf(e, g.owner));
  const failedPlan = g.plan?.some(s => s.state === "failed");
  const failedTask = !g.plan?.length && tasks.some(t => t.state === "failed");
  if (!failedPlan && !failedTask) return null;
  const released: string[] = [], cancelled: string[] = [], paidNeedsOwner: string[] = [];
  for (const e of es) {
    const t = tasks.find(x => x.id === e.id)!;
    if (t.state === "failed" || t.state === "cancelled") continue;
    if (e.reservation?.state === "held" && e.reservation.holdId) { await release(db, e.reservation.resourceId, e.reservation.holdId, now).catch(() => {}); released.push(e.id); }
    if (e.payment?.status === "paid" || e.payment?.status === "outside") { paidNeedsOwner.push(e.id); continue; }
    if (["asking", "negotiating", "deal", "agreed"].includes(e.phase)) {
      await db.update(ENGAGEMENTS, e.id, (cur: Engagement | null) => (cur ? { ...cur, phase: cur.phase === "agreed" ? "agreed" : "closed",
        ...(cur.phase === "agreed" ? { fulfilment: { state: "cancelled" as const, note: "Cancelled: another part of this goal failed." } } : {}),
        ...(cur.reservation ? { reservation: { ...cur.reservation, state: cur.reservation.state === "held" ? "released" as const : cur.reservation.state } } : {}),
        waiting: { requester: null, provider: null }, outbox: null, outboxPending: false,
        events: [...cur.events, { at: now, who: "system" as const, text: "Cancelled because another part of this all-or-nothing goal failed. Nothing was paid here." }], updatedAt: now } : null));
      await deallocate(db, g.id, e.id, now);
      cancelled.push(e.id);
    }
  }
  const comp = { at: now, released, cancelled, paidNeedsOwner };
  await db.update(GOALS, g.id, (cur: Goal | null) => (cur ? { ...cur, compensation: comp, updatedAt: now } : null));
  return comp;
}

