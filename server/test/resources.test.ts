// Resources (TP-08, TP-09): concurrent holds on the last unit or the same slot give at most one; expired holds free
// capacity; commits leave stock; releases return it; stale counts are unknown, not available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { CapacityError, RESOURCES, availabilityText, available, commit, createResource, hold, release, setStock } from "../src/core/resources.ts";

const T = 1_800_000_000;

test("two buyers for the last unit: one hold, one CAPACITY_UNAVAILABLE; stock never goes negative", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "shop", { factId: "f1", type: "quantity", title: "Steel bottle", onHand: 1 }, T);
  const results = await Promise.allSettled([hold(db, r.id, { holder: "a", ttlSec: 900 }, T), hold(db, r.id, { holder: "b", ttlSec: 900 }, T)]);
  assert.deepEqual(results.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  const err = (results.find(x => x.status === "rejected") as PromiseRejectedResult).reason;
  assert.ok(err instanceof CapacityError && err.code === "CAPACITY_UNAVAILABLE");
  const cur = await db.get(RESOURCES, r.id);
  assert.equal(available(cur, T), 0); assert.equal(cur.onHand, 1);
});

test("a hold expires and frees the unit; a commit takes it out of stock; a release returns it", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "shop", { factId: "f2", type: "quantity", title: "Mug", onHand: 2 }, T);
  const h1 = await hold(db, r.id, { holder: "a", ttlSec: 60 }, T);
  const h2 = await hold(db, r.id, { holder: "b", ttlSec: 900 }, T);
  await assert.rejects(hold(db, r.id, { holder: "c", ttlSec: 900 }, T), /Not enough/);
  const h3 = await hold(db, r.id, { holder: "c", ttlSec: 900 }, T + 61);          // h1 expired
  await assert.rejects(commit(db, r.id, h1.id, T + 61), /expired/);
  const after = await commit(db, r.id, h2.id, T + 62);
  assert.equal(after.onHand, 1); assert.equal(available(after, T + 62), 0, "h3 still holds the other unit");
  await commit(db, r.id, h2.id, T + 63);                                            // idempotent
  assert.equal((await db.get(RESOURCES, r.id)).onHand, 1);
  const freed = await release(db, r.id, h3.id, T + 64);
  assert.equal(available(freed, T + 64), 1);
});

test("time slots: overlapping requests for a one-place slot give one booking; other slots are independent", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "tutor", { factId: "f3", type: "slots", title: "Guitar lesson", slots: [{ start: T + 3600, end: T + 7200, capacity: 1 }, { start: T + 7200, end: T + 10800, capacity: 1 }] }, T);
  const [s1, s2] = r.slots;
  const both = await Promise.allSettled([hold(db, r.id, { holder: "a", slotId: s1.id, ttlSec: 900 }, T), hold(db, r.id, { holder: "b", slotId: s1.id, ttlSec: 900 }, T)]);
  assert.deepEqual(both.map(x => x.status).sort(), ["fulfilled", "rejected"]);
  await hold(db, r.id, { holder: "b", slotId: s2.id, ttlSec: 900 }, T);
  assert.equal(availabilityText(await db.get(RESOURCES, r.id), T), "No open slots right now.");
});

test("a manual count goes stale: availability becomes unknown, not a number, until the owner recounts", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "shop", { factId: "f4", type: "quantity", title: "Rice 5 kg", onHand: 10, source: "manual", staleAfterSec: 3600 }, T);
  assert.equal(availabilityText(r, T), "10 available");
  const later = T + 7200;
  await assert.rejects(hold(db, r.id, { holder: "a", ttlSec: 900 }, later), (e: any) => e.code === "AVAILABILITY_UNKNOWN");
  assert.match(availabilityText(await db.get(RESOURCES, r.id), later), /needs to be confirmed/);
  await setStock(db, r.id, "shop", 8, later);
  assert.equal((await hold(db, r.id, { holder: "a", ttlSec: 900 }, later)).qty, 1);
  await assert.rejects(setStock(db, r.id, "intruder", 99, later), /No such resource/);
  await assert.rejects(setStock(db, r.id, "shop", -1, later), /zero or more/);
  assert.equal(availabilityText(null, T), "Availability isn't tracked — the seller will confirm.");
});
