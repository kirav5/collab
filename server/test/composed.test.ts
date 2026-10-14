// Composed goals (T4): recurring rounds search and notify (never buy) and stop at the budget or end date;
// all-or-nothing goals release the other parts' holds and unpaid deals when one part fails, and list paid parts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { fakeModel } from "../src/ai/fake.ts";
import { GOALS, type Goal } from "../src/core/goals.ts";
import { ENGAGEMENTS } from "../src/core/engage.ts";
import { compensate, runRecurrence } from "../src/core/composed.ts";
import { RESOURCES, available, createResource, hold } from "../src/core/resources.ts";

const T = 1_800_000_000;
const base = (x: Partial<Goal>): Goal => ({ id: "g", schemaVersion: 1, revision: 1, owner: "me", outcome: "I want to buy a used bicycle for sale in Koramangala", kind: "purchase",
  budget: null, taskIds: [], closed: null, createdAt: T, updatedAt: T, ...x });
const here = { name: "Koramangala", lat: 12.93, lon: 77.62, isCity: false };

test("a recurring goal searches each round and notifies; it stops at its budget or end date", async () => {
  const db = memoryDocs();
  const g = base({ recurrence: { everyDays: 7, nextAt: T, until: T + 30 * 86_400, rounds: 0, stopped: null } });
  await db.set(GOALS, g.id, g);
  const notes: string[] = [];
  const r = await runRecurrence(db, fakeModel(), g, here, T, async (_g, t) => { notes.push(t); });
  assert.equal(r.ran, true); assert.equal(notes.length, 1);
  const after = await db.get(GOALS, "g");
  assert.equal(after.recurrence.rounds, 1); assert.equal(after.recurrence.nextAt, T + 7 * 86_400);
  assert.equal((await runRecurrence(db, fakeModel(), after, here, T + 60, async () => {})).ran, false, "not due yet");
  const spent = base({ budget: { amount: 1000, currency: "INR" }, allocations: [{ engagementId: "x", amount: 1000, currency: "INR", at: T }], recurrence: { everyDays: 7, nextAt: T, until: T + 30 * 86_400, rounds: 3, stopped: null } });
  await db.set(GOALS, "g", spent);
  assert.equal((await runRecurrence(db, fakeModel(), spent, here, T, async () => {})).stopped, "budget used up");
  const ended = base({ recurrence: { everyDays: 7, nextAt: T, until: T - 1, rounds: 3, stopped: null } });
  await db.set(GOALS, "g", ended);
  assert.equal((await runRecurrence(db, fakeModel(), ended, here, T, async () => {})).stopped, "ended");
});

test("all-or-nothing: one part fails, the others' holds and unpaid deals are released; paid parts go to the owner", async () => {
  const db = memoryDocs();
  const stock = await createResource(db, "decor", { factId: "fd", type: "quantity", title: "Balloons", onHand: 1 }, T);
  const h = await hold(db, stock.id, { holder: "me", ttlSec: 3600 }, T);
  const conv = (id: string, x: object) => ({ id, goalId: "g", requester: { uid: "me", handle: "me", name: "Me" }, provider: { uid: "p", handle: "p", name: "P" }, offer: { factId: null, title: id, price: 100, unit: null, category: "goods" },
    qa: [], waiting: { requester: null, provider: null }, negotiation: { requester: [], provider: [], deal: { id: "d", price: 100, terms: {}, round: 1 }, dealBy: "provider", confirmed: { requester: true, provider: true } },
    events: [], createdAt: T, updatedAt: T, title: id, brief: {}, ...x });
  await db.set(ENGAGEMENTS, "cake", conv("cake", { phase: "declined" }));                                                    // failed
  await db.set(ENGAGEMENTS, "decor", conv("decor", { phase: "agreed", payment: { status: "awaiting" }, reservation: { resourceId: stock.id, holdId: h.id, qty: 1, state: "held", expiresAt: T + 3600 } }));
  await db.set(ENGAGEMENTS, "photo", conv("photo", { phase: "agreed", payment: { status: "paid" }, fulfilment: { state: "not_started" } }));
  const g = base({ allOrNothing: true, taskIds: ["cake", "decor", "photo"], budget: { amount: 1000, currency: "INR" }, allocations: [{ engagementId: "decor", amount: 100, currency: "INR", at: T }] });
  await db.set(GOALS, "g", g);
  const c = await compensate(db, g, T + 10);
  assert.deepEqual(c, { at: T + 10, released: ["decor"], cancelled: ["decor"], paidNeedsOwner: ["photo"] });
  assert.equal(available(await db.get(RESOURCES, stock.id), T + 10), 1, "the balloons are back in stock");
  const decor = await db.get(ENGAGEMENTS, "decor");
  assert.equal(decor.fulfilment.state, "cancelled"); assert.equal(decor.reservation.state, "released");
  assert.equal((await db.get(ENGAGEMENTS, "photo")).payment.status, "paid", "a paid part isn't silently undone");
  assert.deepEqual((await db.get(GOALS, "g")).allocations, [], "the cancelled deal's budget is returned");
  assert.equal(await compensate(db, await db.get(GOALS, "g"), T + 20), null, "once");
});
