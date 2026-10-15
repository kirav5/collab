// Goals and tasks. A goal is what the owner wants done ("a 500 ml steel bottle", "find out if the shop ships"); each
// conversation between agents is one task under it. Goals are stored; a task is a view of its conversation, so every
// existing conversation keeps working and gains a task state without migration. A goal's state follows from its
// tasks — it can complete with no price, cart or seller (an information goal), or partly when only some tasks did.
import type { Docs } from "../docs.ts";
import type { Engagement, Side } from "./model.ts";
import { ENGAGEMENTS } from "./engage.ts";
import { newId } from "../market/types.ts";
import { buyerOf } from "./pay.ts";

export const GOALS = "goals";

export type GoalState = "draft" | "active" | "waiting" | "completed" | "partially_completed" | "cancelled" | "failed";
export type TaskState = "pending" | "running" | "waiting_for_input" | "waiting_for_external" | "succeeded" | "failed" | "cancelled";
export type GoalKind = "purchase" | "service" | "information" | "other";

export interface Goal {
  id: string; schemaVersion: 1; revision: number; owner: string;
  outcome: string; kind: GoalKind;
  /** Optional ceiling across all the goal's tasks (checked when a deal is confirmed). */
  budget: { amount: number; currency: string } | null;
  taskIds: string[];
  /** Money committed against the budget, one entry per confirmed deal (released if the deal lapses or ends). */
  allocations?: { engagementId: string; amount: number; currency: string; at: number }[];
  /** Repeat the search each period (never buying on its own), within the goal's budget, until `until`. */
  recurrence?: { everyDays: number; nextAt: number; until: number; rounds: number; stopped: string | null } | null;
  /** All-or-nothing: if any part fails, the others' holds and unpaid deals are released (see compensate). */
  allOrNothing?: boolean;
  /** What compensation did, once. */
  compensation?: { at: number; released: string[]; cancelled: string[]; paidNeedsOwner: string[] } | null;
  /** Several providers in order (see core/plans.ts). */
  plan?: import("./plans.ts").PlanStep[];
  /** Set by the owner; a goal they closed stays closed. */
  closed: "cancelled" | null;
  createdAt: number; updatedAt: number;
}

export interface TaskView {
  id: string; goalId: string | null; state: TaskState; counterparty: string; title: string;
  capability: string; waitingOn: "you" | "them" | null; next: string;
}

const other = (s: Side): Side => (s === "requester" ? "provider" : "requester");

/** One conversation seen as a task, from its owner's side. */
export function taskOf(e: Engagement, ownerUid: string): TaskView {
  const mine: Side = e.requester.uid === ownerUid ? "requester" : "provider";
  const them = other(mine);
  const counterparty = (mine === "requester" ? e.provider : e.requester).name;
  const base = { id: e.id, goalId: e.goalId ?? null, counterparty, title: e.title, capability: `collab.${e.offer.category || (e.offer.price == null ? "information" : "other")}.v1` };
  const myQuestions = e.qa.filter(q => q.from === mine);
  const answered = myQuestions.length > 0 && myQuestions.every(q => q.status === "answered" || q.status === "declined");
  if (e.phase === "declined") return { ...base, state: "failed", waitingOn: null, next: "They declined." };
  if (e.phase === "closed") {
    // A conversation with nothing to buy succeeds when its questions were answered and the owner was done.
    return e.offer.price == null && !e.negotiation.deal && answered
      ? { ...base, state: "succeeded", waitingOn: null, next: "Answered." }
      : { ...base, state: "cancelled", waitingOn: null, next: "Ended." };
  }
  if (e.phase === "agreed") {
    const f = e.fulfilment?.state, paid = e.payment?.status === "paid" || e.payment?.status === "outside";
    if (f === "accepted") return { ...base, state: "succeeded", waitingOn: null, next: "Done — received as agreed." };
    if (f === "disputed") return { ...base, state: "failed", waitingOn: null, next: "A problem was reported." };
    if (f === "cancelled") return { ...base, state: "cancelled", waitingOn: null, next: "Cancelled." };
    const buyer = buyerOf(e);
    if (!paid) return { ...base, state: mine === buyer ? "waiting_for_input" : "waiting_for_external", waitingOn: mine === buyer ? "you" : "them", next: mine === buyer ? "Pay to complete the deal." : "Waiting for payment." };
    if (f === "delivered") return { ...base, state: mine === buyer ? "waiting_for_input" : "waiting_for_external", waitingOn: mine === buyer ? "you" : "them", next: mine === buyer ? "Confirm you received it." : "Waiting for them to confirm." };
    return { ...base, state: mine === buyer ? "waiting_for_external" : "waiting_for_input", waitingOn: mine === buyer ? "them" : "you", next: mine === buyer ? "Waiting for the handover." : "Hand it over." };
  }
  if (e.waiting[mine]) return { ...base, state: "waiting_for_input", waitingOn: "you", next: e.waiting[mine]!.kind === "confirm" ? "Confirm the deal." : "Your agent needs you." };
  if (e.waiting[them] || e.outbox) return { ...base, state: "waiting_for_external", waitingOn: "them", next: `Waiting for ${counterparty}.` };
  return { ...base, state: "running", waitingOn: null, next: e.offer.price == null && answered ? "Answered — ask more or tap Done." : "Agents are talking." };
}

/** A goal's state from its tasks (and the owner's own decision to close it). */
export function goalState(g: Goal, tasks: TaskView[]): GoalState {
  if (g.closed) return g.closed;
  // A planned goal is done when every step is; some done and the rest failed is partial.
  if (g.plan?.length) {
    const st = g.plan.map(s => s.state);
    if (st.every(x => x === "done")) return "completed";
    if (st.every(x => x === "done" || x === "failed")) return st.some(x => x === "done") ? "partially_completed" : "failed";
    if (st.includes("searched") || tasks.some(t => t.waitingOn === "you")) return "waiting";
    return "active";
  }
  if (!tasks.length) return "draft";
  const done = (t: TaskView) => ["succeeded", "failed", "cancelled"].includes(t.state);
  if (tasks.every(done)) {
    const ok = tasks.filter(t => t.state === "succeeded").length;
    if (ok === tasks.length) return "completed";
    if (ok > 0) return g.kind === "purchase" || g.kind === "service" ? "completed" : "partially_completed";
    return tasks.every(t => t.state === "cancelled") ? "cancelled" : "failed";
  }
  if (tasks.some(t => t.waitingOn === "you")) return "waiting";
  return "active";
}

export async function createGoal(db: Docs, owner: string, outcome: string, kind: GoalKind, budget: Goal["budget"], now: number): Promise<Goal> {
  const g: Goal = { id: newId(), schemaVersion: 1, revision: 1, owner, outcome: outcome.slice(0, 200), kind, budget, taskIds: [], closed: null, createdAt: now, updatedAt: now };
  await db.set(GOALS, g.id, g);
  return g;
}

/** Links a conversation to a goal (both must be the owner's); idempotent. */
export async function linkTask(db: Docs, goalId: string, owner: string, engagementId: string, now: number) {
  await db.update(GOALS, goalId, (g: Goal | null) => (!g || g.owner !== owner || g.taskIds.includes(engagementId) ? null
    : { ...g, taskIds: [...g.taskIds, engagementId].slice(-50), revision: g.revision + 1, updatedAt: now }));
}

/** A goal with its tasks and derived state, from its owner's side. */
export async function goalView(db: Docs, g: Goal) {
  const es = (await Promise.all(g.taskIds.map(id => db.get(ENGAGEMENTS, id)))).filter(Boolean) as Engagement[];
  const tasks = es.map(e => taskOf(e, g.owner));
  const state = goalState(g, tasks);
  const next = tasks.find(t => t.waitingOn === "you")?.next ?? tasks.find(t => t.state === "waiting_for_external" || t.state === "running")?.next ?? null;
  return { ...g, state, tasks, next, budgetUse: budgetUse(g) };
}

/**
 * Migration goals-v1 (additive, once per owner): conversations started before goals existed become tasks of goals —
 * one goal per request (by brief), one per direct question — keeping their ids. Recorded in `migrations`.
 */
export async function backfillGoals(db: Docs, owner: string, now: number): Promise<number> {
  const marker = `goals-v1:${owner}`;
  if (await db.get("migrations", marker)) return 0;
  const mine = ((await db.find(ENGAGEMENTS, [["participants", "array-contains", owner]], 300)) as Engagement[])
    .filter(e => e.requester.uid === owner && !e.goalId);
  const groups = new Map<string, Engagement[]>();
  for (const e of mine) { const k = e.briefId && !e.briefId.startsWith("direct-") ? e.briefId : e.id; groups.set(k, [...(groups.get(k) ?? []), e]); }
  for (const es of groups.values()) {
    const first = es[0];
    const kind: GoalKind = first.offer.price == null && !first.negotiation.deal ? "information" : /service|lesson|task/i.test(first.offer.category ?? "") ? "service" : "purchase";
    const g = await createGoal(db, owner, first.brief?.title ?? first.title, kind, null, Math.min(...es.map(e => e.createdAt)));
    for (const e of es) { await db.merge(ENGAGEMENTS, e.id, { goalId: g.id }); await linkTask(db, g.id, owner, e.id, now); }
  }
  await db.set("migrations", marker, { id: marker, owner, goals: groups.size, conversations: mine.length, at: now });
  return groups.size;
}

// MARK: - Budget across a goal's deals

export class BudgetError extends Error {}

/** Reserves `amount` of the goal's budget for one deal, in a transaction on the goal — two deals confirmed at once
 *  can't both fit under the same remaining budget. No budget: nothing to do. Idempotent per deal. */
export async function allocate(db: Docs, goalId: string, engagementId: string, amount: number, currency: string, now: number) {
  let refusal: Error | null = null;
  await db.update(GOALS, goalId, (g: Goal | null) => {
    if (!g?.budget) return null;
    const allocs = g.allocations ?? [];
    if (allocs.some(a => a.engagementId === engagementId)) return null;
    if (g.budget.currency !== currency) { refusal = new BudgetError(`This goal's budget is in ${g.budget.currency}; this deal is in ${currency}.`); return null; }
    const used = allocs.reduce((n, a) => n + a.amount, 0);
    if (used + amount > g.budget.amount) { refusal = new BudgetError(`That would take “${g.outcome}” over its budget: ${g.budget.amount - used} ${currency} left of ${g.budget.amount}.`); return null; }
    return { ...g, allocations: [...allocs, { engagementId, amount, currency, at: now }], revision: g.revision + 1, updatedAt: now };
  });
  if (refusal) throw refusal;
}

export async function deallocate(db: Docs, goalId: string, engagementId: string, now: number) {
  await db.update(GOALS, goalId, (g: Goal | null) => (g?.allocations?.some(a => a.engagementId === engagementId)
    ? { ...g, allocations: g.allocations.filter(a => a.engagementId !== engagementId), revision: g.revision + 1, updatedAt: now } : null));
}

export const budgetUse = (g: Goal) => g.budget ? { ...g.budget, used: (g.allocations ?? []).reduce((n, a) => n + a.amount, 0) } : null;

/** Cancels a goal: conversations without a deal end, held stock or slots are released, budget comes back. */
export async function cancelGoal(db: Docs, owner: string, goalId: string, now: number): Promise<Goal | null> {
  const { release } = await import("./resources.ts");
  const g = await db.update(GOALS, goalId, (cur: Goal | null) => (cur && cur.owner === owner ? { ...cur, closed: "cancelled", revision: cur.revision + 1, updatedAt: now } : null)) as Goal | null;
  if (!g) return null;
  for (const id of g.taskIds) {
    const e = (await db.get(ENGAGEMENTS, id)) as Engagement | null;
    if (!e || !["asking", "negotiating", "deal", "agreed"].includes(e.phase)) continue;
    if (e.phase === "agreed" && (e.payment?.status === "paid" || e.payment?.status === "outside")) continue; // a paid deal keeps its obligations
    if (e.reservation?.state === "held" && e.reservation.holdId) await release(db, e.reservation.resourceId, e.reservation.holdId, now).catch(() => {});
    await db.update(ENGAGEMENTS, id, (cur: Engagement | null) => (cur ? { ...cur, phase: cur.requester.uid === owner ? "closed" : "declined",
      ...(cur.reservation?.state === "held" ? { reservation: { ...cur.reservation, state: "released" } } : {}),
      waiting: { requester: null, provider: null }, outbox: null, outboxPending: false,
      events: [...cur.events, { at: now, who: cur.requester.uid === owner ? "requester" : "provider", text: "Goal cancelled — conversation ended.", by: "owner" }], updatedAt: now } : null));
    await deallocate(db, goalId, id, now);
    const { closeInbox } = await import("./engage.ts");
    await closeInbox(db, id);
  }
  return (await db.get(GOALS, goalId)) as Goal;
}
