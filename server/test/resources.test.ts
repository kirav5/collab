// Resources (TP-08, TP-09): concurrent holds on the last unit or the same slot give at most one; expired holds free
// capacity; commits leave stock; releases return it; stale counts are unknown, not available.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { CapacityError, RESOURCES, availabilityText, available, commit, createResource, hold, lowStock, release, setStock } from "../src/core/resources.ts";

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
  assert.equal(availabilityText(null, T), "Availability isn't tracked — they'll confirm.");
});

test("asked about free times, the agent names the next ones, not a count", async () => {
  const { availabilityText, createResource } = await import("../src/core/resources.ts");
  const { memoryDocs } = await import("../src/docs.ts");
  const db = memoryDocs(), T = 1_800_000_000;
  const r = await createResource(db, "o", { factId: "f", type: "slots", title: "Haircut", slots: [0, 1, 2, 3].map(i => ({ start: T + 3600 + i * 2400, end: T + 3600 + i * 2400 + 2400, capacity: 1 })), timezone: "Asia/Kolkata" }, T);
  const text = availabilityText(r, T);
  assert.match(text, /^Next free: .+; .+; .+ \(4 open in all\)\. Each takes about 40 minutes\.$/);
  assert.doesNotMatch(text, /open slots$/);
});

test("weekly hours: the seller states them once; bookable times are made two weeks ahead in their time zone and topped up", async () => {
  const { setHours, slotsFromHours, topUpHours, needsTopUp, validHours, hoursText, tzOffset } = await import("../src/core/resources.ts");
  assert.equal(validHours({ days: [1, 2, 3, 4, 5, 6], from: "10:00", to: "20:00", minutes: 40 })?.minutes, 40);
  assert.equal(validHours({ days: [], from: "10:00", to: "20:00", minutes: 40 }), null, "at least one day");
  assert.equal(validHours({ days: [1], from: "10:00", to: "10:30", minutes: 40 }), null, "a booking has to fit");
  assert.equal(validHours({ days: [1], from: "25:00", to: "26:00", minutes: 40 }), null);
  assert.equal(hoursText({ days: [1, 2, 3, 4, 5, 6], from: "10:00", to: "20:00", minutes: 40 }), "Open Mon–Sat, 10:00–20:00");
  assert.equal(hoursText({ days: [0, 3, 4], from: "09:00", to: "13:00", minutes: 60 }), "Open Sun, Wed, Thu, 09:00–13:00");
  assert.equal(hoursText({ days: [0, 1, 2, 3, 4, 5, 6], from: "10:00", to: "19:00", minutes: 45 }), "Open every day, 10:00–19:00");
  assert.equal(tzOffset("Asia/Kolkata", 1_760_000_000), 19_800);
  // Fri 16 Oct 2026, 06:00 IST.
  const T = Date.UTC(2026, 9, 16, 0, 30) / 1000;
  const h = { days: [1, 2, 3, 4, 5, 6], from: "10:00", to: "20:00", minutes: 40 };
  const slots = slotsFromHours(h, "Asia/Kolkata", T);
  const ist = (t: number) => new Date((t + 19_800) * 1000);
  assert.equal(ist(slots[0].start).getUTCHours(), 10, "opens at 10:00 IST");
  assert.ok(slots.every(s => ist(s.start).getUTCDay() !== 0), "never on Sunday");
  assert.ok(slots.every(s => ist(s.end).getUTCHours() * 60 + ist(s.end).getUTCMinutes() <= 20 * 60), "the last booking ends by 20:00");
  assert.equal(slots.length, 12 * 15, "12 open days in two weeks × 15 bookings a day");
  // Created with hours → slots made; a booked time survives a change of hours, free ones are remade.
  const db = memoryDocs();
  const r = await createResource(db, "barber", { factId: "f1", type: "slots", title: "Haircut", hours: h, timezone: "Asia/Kolkata" }, T);
  assert.equal(r.slots.length, 180);
  assert.ok(!needsTopUp(r, T));
  const held = await hold(db, r.id, { holder: "buyer", slotId: r.slots[0].id, ttlSec: 3600 }, T);
  const r2 = await setHours(db, r.id, "barber", { days: [6], from: "09:00", to: "12:00", minutes: 60 }, null, T);
  assert.ok(r2.slots.some(s => s.id === held.slotId), "the held time stays");
  assert.equal(r2.slots.filter(s => s.id !== held.slotId).length, 2 * 3, "two Saturdays × 3 hour-long bookings");
  await assert.rejects(setHours(db, r.id, "someone-else", h, null, T), "only the owner");
  // A week on, the cron tops it up to two weeks ahead again.
  const later = T + 7 * 86_400;
  assert.ok(!needsTopUp(r2, T + 3600), "nothing to add an hour later: no rewrite every run");
  assert.ok(needsTopUp(r2, later));
  const r3 = await topUpHours(db, r.id, later);
  assert.equal(r3.slots.filter(s => s.auto && s.start > later).length, 2 * 3, "Sat 24 and Sat 31 Oct: two weeks ahead again");
  assert.ok(!r3.slots.some(s => s.id !== held.slotId && s.end < later - 86_400), "free times long past are dropped");
  assert.ok(!needsTopUp(r3, later));
  assert.match(availabilityText(r3, later), /^Open Sat, 09:00–12:00\. Next free: /);
});

test("a seller hears once when a sale leaves stock low, and again only after they restock", async () => {
  const db = memoryDocs(), t = 1_800_000_000;
  const r = await createResource(db, "shop", { factId: "f1", type: "quantity", title: "Brass lamp · ₹450", onHand: 6 }, t);
  const sell = async (qty: number) => { const h = await hold(db, r.id, { holder: "b", qty, ttlSec: 600 }, t); await commit(db, r.id, h.id, t); };
  await sell(2);
  assert.equal(await lowStock(db, r.id, 3, t), null, "4 left: not low");
  await sell(2);
  assert.deepEqual(await lowStock(db, r.id, 3, t), { left: 2, title: "Brass lamp · ₹450", owner: "shop", factId: "f1" });
  await sell(1);
  assert.equal(await lowStock(db, r.id, 3, t), null, "told once per dip");
  await setStock(db, r.id, "shop", 10, t);
  await sell(8);
  assert.equal((await lowStock(db, r.id, 3, t))?.left, 2, "after a restock, told again");
});
