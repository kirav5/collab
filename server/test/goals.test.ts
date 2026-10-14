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
