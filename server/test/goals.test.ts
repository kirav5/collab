// Goals and tasks (TP-02, TP-15): a conversation seen as a task from each side, a goal's state from its tasks, and
// an information goal that completes with no price, cart or seller.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ENGAGEMENTS, fresh, save } from "../src/core/engage.ts";
import { memoryDocs } from "../src/docs.ts";
import { GOALS, type Goal, backfillGoals, goalState, goalView, taskOf } from "../src/core/goals.ts";
import type { SharedBrief } from "../src/core/model.ts";

const brief: SharedBrief = { title: "Do you ship?", summary: "Do you ship?", category: "", mode: null, area: null, requirements: [], budget: null, questions: ["Do you ship?"] };
const conv = (price: number | null) => fresh({ briefId: null, brief, requester: { uid: "me", handle: "me", name: "Me" }, provider: { uid: "shop", handle: "shop", name: "Shop" },
  offer: { factId: null, title: "Mug", price, unit: null, category: price ? "goods" : null } });
const goal = (kind: Goal["kind"]): Goal => ({ id: "g", schemaVersion: 1, revision: 1, owner: "me", outcome: "x", kind, budget: null, taskIds: [], closed: null, createdAt: 0, updatedAt: 0 });

test("an information conversation succeeds when answered and closed; unanswered and closed is cancelled", () => {
  const e = conv(null);
  e.qa[0].status = "answered"; e.qa[0].answer = "Yes";
  assert.equal(taskOf(e, "me").state, "running");
  e.phase = "closed";
  assert.equal(taskOf(e, "me").state, "succeeded");
  assert.equal(goalState(goal("information"), [taskOf(e, "me")]), "completed");
  const u = conv(null); u.phase = "closed";
  assert.equal(taskOf(u, "me").state, "cancelled");
});

test("a deal's task follows payment, handover and acceptance, from each side", () => {
  const e = conv(500); e.phase = "agreed"; e.seller = "provider";
  e.negotiation.deal = { id: "p", price: 450, terms: {}, round: 1 };
  assert.deepEqual([taskOf(e, "me").waitingOn, taskOf(e, "shop").waitingOn], ["you", "them"], "the buyer pays");
  e.payment = { status: "paid" } as any; e.fulfilment = { state: "not_started" };
  assert.deepEqual([taskOf(e, "me").waitingOn, taskOf(e, "shop").waitingOn], ["them", "you"], "the seller hands over");
  e.fulfilment = { state: "delivered" };
  assert.equal(taskOf(e, "me").next, "Confirm you received it.");
  e.fulfilment = { state: "accepted" };
  assert.equal(taskOf(e, "me").state, "succeeded");
  e.fulfilment = { state: "disputed" };
  assert.equal(taskOf(e, "me").state, "failed");
});

test("goal states: waiting on you, completed by one deal among several sellers, partial for information, owner-cancelled", () => {
  const t = (state: any, waitingOn: any = null) => ({ id: "t", goalId: "g", state, waitingOn, counterparty: "x", title: "x", capability: "c", next: "" });
  assert.equal(goalState(goal("purchase"), []), "draft");
  assert.equal(goalState(goal("purchase"), [t("running"), t("waiting_for_input", "you")]), "waiting");
  assert.equal(goalState(goal("purchase"), [t("succeeded"), t("cancelled"), t("cancelled")]), "completed");
  assert.equal(goalState(goal("information"), [t("succeeded"), t("failed")]), "partially_completed");
  assert.equal(goalState(goal("purchase"), [t("cancelled"), t("cancelled")]), "cancelled");
  assert.equal(goalState({ ...goal("purchase"), closed: "cancelled" }, [t("running")]), "cancelled");
});

test("migration goals-v1: older conversations become goals once, ids kept, nothing else touched", async () => {
  const db = memoryDocs();
  const a = conv(500); a.briefId = "b1"; const b = conv(400); b.briefId = "b1"; const c = conv(null); c.briefId = `direct-${c.id}`;
  const theirs = conv(300); theirs.requester = { uid: "other", handle: "o", name: "O" }; theirs.participants = ["other", "shop"];
  for (const e of [a, b, c, theirs]) await save(db, e);
  assert.equal(await backfillGoals(db, "me", 1), 2, "one goal per request, one per direct question");
  assert.equal(await backfillGoals(db, "me", 2), 0, "runs once");
  const goals = (await db.find(GOALS, [["owner", "==", "me"]], 10)) as Goal[];
  const byTasks = goals.map(g => g.taskIds.length).sort();
  assert.deepEqual(byTasks, [1, 2]);
  assert.equal(((await db.get(ENGAGEMENTS, a.id)) as any).goalId, ((await db.get(ENGAGEMENTS, b.id)) as any).goalId);
  assert.equal(((await db.get(ENGAGEMENTS, theirs.id)) as any).goalId, undefined, "another owner's conversation is untouched");
  const info = goals.find(g => g.taskIds.includes(c.id))!;
  assert.equal(info.kind, "information");
  assert.equal((await goalView(db, info)).tasks[0].id, c.id);
});

test("a goal's budget holds across its deals, even confirmed at the same moment; a lapsed deal gives it back", async () => {
  const { offerDeal, resolve, INBOX, load } = await import("../src/core/engage.ts");
  const { expireDecisions } = await import("../src/core/decisions.ts");
  const db = memoryDocs();
  await db.set(GOALS, "g1", { ...goal("purchase"), id: "g1", budget: { amount: 500, currency: "INR" } });
  const deal = async (id: string, price: number) => {
    const e = conv(null); e.id = id; e.goalId = "g1"; await save(db, e);
    await offerDeal(db, e, "provider", price, `I'll sell you a mug for ₹${price}`);
    return ((await db.find(INBOX, [["owner", "==", "me"]], 20)) as any[]).find(i => i.engagementId === id && i.kind === "confirm");
  };
  const [a, b] = [await deal("e-a", 300), await deal("e-b", 300)];
  const both = await Promise.allSettled([resolve(db, null, a, { confirm: true }), resolve(db, null, b, { confirm: true })]);
  assert.deepEqual(both.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  assert.match(String((both.find(x => x.status === "rejected") as PromiseRejectedResult).reason?.message), /over its budget: 200 INR left of 500/);
  const g = await db.get(GOALS, "g1");
  assert.equal(g.allocations.length, 1); assert.equal(g.allocations[0].amount, 300);
  // A deal offered but never confirmed holds no budget, and lapses at its deadline.
  const lapse = await deal("e-c", 150);
  const r = await expireDecisions(db, lapse.deadline + 1, async () => {});
  assert.equal(r.lapsed >= 1, true);
  assert.equal(((await db.get(GOALS, "g1")).allocations ?? []).length, 1, "an unconfirmed deal never held budget");
  const fits = await deal("e-d", 200);
  await resolve(db, null, fits, { confirm: true });
  assert.equal((await load(db, "e-d")).phase, "agreed");
  assert.equal((await db.get(GOALS, "g1")).allocations.reduce((n: number, x: any) => n + x.amount, 0), 500);
});

test("cancelling a goal ends its open conversations, releases held stock and returns budget; a paid deal keeps its obligations", async () => {
  const { cancelGoal } = await import("../src/core/goals.ts");
  const { RESOURCES, available, createResource, hold } = await import("../src/core/resources.ts");
  const db = memoryDocs(), T = 1_800_000_000;
  const stock = await createResource(db, "shop", { factId: "f", type: "quantity", title: "Mug", onHand: 2 }, T);
  const h = await hold(db, stock.id, { holder: "me", ttlSec: 3600 }, T);
  const open = conv(null); open.id = "open"; open.goalId = "g"; open.phase = "agreed"; open.payment = { status: "awaiting" } as any;
  open.reservation = { resourceId: stock.id, holdId: h.id, qty: 1, state: "held", expiresAt: T + 3600 };
  const paid = conv(null); paid.id = "paid"; paid.goalId = "g"; paid.phase = "agreed"; paid.payment = { status: "paid" } as any;
  const theirs = conv(null); theirs.id = "theirs"; theirs.goalId = "g";
  for (const e of [open, paid, theirs]) await save(db, e);
  await db.set(GOALS, "g", { ...goal("purchase"), id: "g", taskIds: ["open", "paid", "theirs"], budget: { amount: 500, currency: "INR" }, allocations: [{ engagementId: "open", amount: 100, currency: "INR", at: T }] });
  await assert.equal(await cancelGoal(db, "someone-else", "g", T + 1), null, "only the owner cancels");
  const g = (await cancelGoal(db, "me", "g", T + 1))!;
  assert.equal(g.closed, "cancelled");
  assert.equal((await db.get(ENGAGEMENTS, "open")).phase, "closed");
  assert.equal((await db.get(ENGAGEMENTS, "open")).reservation.state, "released");
  assert.equal(available(await db.get(RESOURCES, stock.id), T + 1), 2, "the mug is back in stock");
  assert.equal((await db.get(ENGAGEMENTS, "paid")).phase, "agreed", "a paid deal isn't cancelled");
  assert.equal((await db.get(ENGAGEMENTS, "theirs")).phase, "closed");
  assert.deepEqual(g.allocations, []);
});
