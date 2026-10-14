// Plans (T4): Gemini proposes steps; code accepts only bounded, money-free, acyclic plans; a step waits for its
// dependency, and a ready step searches (nothing is committed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { fakeModel } from "../src/ai/fake.ts";
import { PlanTask, advancePlan, type PlanStep } from "../src/core/plans.ts";
import { GOALS, type Goal, goalState } from "../src/core/goals.ts";
import { ENGAGEMENTS } from "../src/core/engage.ts";

test("plans are bounded, earlier-only dependencies, no money or contact details", () => {
  const ok = { steps: [{ title: "Cake", request: "Need a birthday cake in Indiranagar", after: null }, { title: "Decorator", request: "Need a balloon decorator in Indiranagar", after: 0 }] };
  assert.deepEqual(PlanTask.validate(ok, { outcome: "x" })?.steps.map(s => s.after), [null, 0]);
  assert.equal(PlanTask.validate({ steps: [{ title: "A", request: "Need a cake for Saturday", after: 1 }, { title: "B", request: "Need a cake topper", after: 0 }] }, { outcome: "x" }), null, "no forward or circular dependencies");
  assert.equal(PlanTask.validate({ steps: [{ title: "Cake", request: "Need a cake under ₹800", after: null }] }, { outcome: "x" }), null, "no money in a plan");
  assert.equal(PlanTask.validate({ steps: [{ title: "Cake", request: "Call 98450 12345 for a cake", after: null }] }, { outcome: "x" }), null);
  assert.equal(PlanTask.validate({ steps: Array.from({ length: 9 }, (_, i) => ({ title: `S${i}`, request: "Need a thing nearby", after: null })) }, { outcome: "x" })?.steps.length, 5);
  assert.deepEqual(PlanTask.fallback({ outcome: "Buy a steel bottle" }).steps, [{ title: "Buy a steel bottle", request: "Buy a steel bottle", after: null }]);
});

test("a step waits for its dependency; ready steps search; the goal completes when every step is done", async () => {
  const db = memoryDocs(), T = 1_800_000_000;
  const steps: PlanStep[] = [
    { id: "a", title: "Cycle", request: "I want to buy a used bicycle in Koramangala", after: null, state: "waiting", briefId: null, found: 0, note: null },
    { id: "b", title: "Helmet", request: "I want to buy a used helmet for sale in Koramangala", after: "a", state: "waiting", briefId: null, found: 0, note: null }];
  const g: Goal = { id: "g", schemaVersion: 1, revision: 1, owner: "me", outcome: "Start cycling", kind: "purchase", budget: null, taskIds: [], closed: null, createdAt: T, updatedAt: T, plan: steps };
  await db.set(GOALS, g.id, g);
  const here = { name: "Koramangala", lat: 12.93, lon: 77.62, isCity: false };
  let out = await advancePlan(db, fakeModel(), g, here, T);
  assert.equal(out[0].state, "searched"); assert.ok(out[0].briefId);
  assert.equal(out[1].state, "waiting", "the helmet waits for the cycle");
  assert.equal(goalState({ ...g, plan: out }, []), "waiting", "matches are waiting for the owner to choose");
  // The cycle deal completes: its step is done, and the helmet step becomes ready and searches.
  await db.set(ENGAGEMENTS, "e1", { id: "e1", briefId: out[0].briefId, goalId: "g", requester: { uid: "me", handle: "me", name: "Me" }, provider: { uid: "p", handle: "p", name: "P" },
    phase: "agreed", offer: { factId: "f", title: "Cycle", price: 4000, unit: null, category: "goods" }, qa: [], waiting: { requester: null, provider: null },
    negotiation: { requester: [], provider: [], deal: { id: "d", price: 3800, terms: {}, round: 1 }, dealBy: "provider", confirmed: { requester: true, provider: true } },
    payment: { status: "paid" }, fulfilment: { state: "accepted" }, events: [], createdAt: T, updatedAt: T, title: "Cycle", brief: {} });
  const g2 = { ...(await db.get(GOALS, "g")), taskIds: ["e1"] };
  await db.set(GOALS, "g", g2);
  out = await advancePlan(db, fakeModel(), g2, here, T + 10);
  assert.deepEqual(out.map(s => s.state), ["done", "searched"]);
  assert.equal(goalState({ ...g2, plan: out.map(s => ({ ...s, state: "done" as const })) }, []), "completed");
  assert.equal(goalState({ ...g2, plan: [{ ...out[0], state: "done" }, { ...out[1], state: "failed" }] }, []), "partially_completed");
});
