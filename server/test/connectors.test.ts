// Connectors (T3): scoped, revocable grants; signed, de-duplicated, ordered stock events; calendar busy times; and
// outages that make availability unknown instead of guessing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { RESOURCES, availabilityText, createResource, hold } from "../src/core/resources.ts";
import { ConnectorError, createGrant, grantKey, ingestInventory, parseIcal, revokeGrant, signBody, syncIcal } from "../src/core/connectors.ts";

const SECRET = "server-secret", T = 1_800_000_000;
const post = (db: any, grantId: string, ev: object, key = grantKey(SECRET, grantId), at = T) => {
  const body = JSON.stringify(ev);
  return ingestInventory(db, SECRET, grantId, body, signBody(key, body), at);
};

test("signed stock events apply once, in order; bad signatures, other owners and revoked grants change nothing", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "shop", { factId: "f", type: "quantity", title: "Bottle", onHand: 3 }, T);
  await assert.rejects(createGrant(db, "intruder", "inventory-webhook", r.id, null, T), (e: any) => e.status === 404);
  await assert.rejects(createGrant(db, "shop", "teleporter", r.id, null, T), (e: any) => e.code === "UNSUPPORTED_CAPABILITY");
  const g = await createGrant(db, "shop", "inventory-webhook", r.id, null, T);
  assert.deepEqual(g.scopes, ["inventory.write"]);
  assert.deepEqual(await post(db, g.id, { id: "e1", type: "stock.set", onHand: 10, observedAt: T + 10 }, undefined, T + 10), { applied: true, duplicate: false });
  assert.deepEqual(await post(db, g.id, { id: "e1", type: "stock.set", onHand: 10, observedAt: T + 10 }, undefined, T + 11), { applied: false, duplicate: true }, "a retried delivery");
  await post(db, g.id, { id: "e2", type: "stock.adjust", delta: -2, observedAt: T + 20 }, undefined, T + 20);
  assert.equal((await db.get(RESOURCES, r.id)).onHand, 8);
  assert.equal((await post(db, g.id, { id: "e0", type: "stock.set", onHand: 50, observedAt: T + 5 }, undefined, T + 21)).applied, false, "an older event can't roll stock back");
  assert.equal((await db.get(RESOURCES, r.id)).onHand, 8);
  await assert.rejects(post(db, g.id, { id: "e3", type: "stock.set", onHand: 1 }, "wrong-key"), (e: any) => e instanceof ConnectorError && e.status === 401);
  await revokeGrant(db, "shop", g.id, T + 30);
  await assert.rejects(post(db, g.id, { id: "e4", type: "stock.set", onHand: 99, observedAt: T + 40 }, undefined, T + 40), (e: any) => e.status === 403);
  assert.equal((await db.get(RESOURCES, r.id)).onHand, 8);
});

test("a POS that stops reporting (or is revoked) leaves availability unknown, not a stale number", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "shop", { factId: "f", type: "quantity", title: "Bottle", onHand: 0 }, T);
  const g = await createGrant(db, "shop", "inventory-webhook", r.id, null, T);
  await post(db, g.id, { id: "a", type: "stock.set", onHand: 5, observedAt: T }, undefined, T);
  const day = T + 2 * 86_400;
  await assert.rejects(hold(db, r.id, { holder: "b", ttlSec: 900 }, day), (e: any) => e.code === "AVAILABILITY_UNKNOWN");
  assert.match(availabilityText(await db.get(RESOURCES, r.id), day), /needs to be confirmed/);
  await post(db, g.id, { id: "b", type: "stock.set", onHand: 5, observedAt: day }, undefined, day);
  assert.equal((await hold(db, r.id, { holder: "b", ttlSec: 900 }, day)).qty, 1, "reporting again restores it");
});

test("calendar busy times block overlapping slots; a feed outage degrades the grant and goes stale", async () => {
  const db = memoryDocs();
  const r = await createResource(db, "tutor", { factId: "f", type: "slots", title: "Lesson", timezone: "Asia/Kolkata", slots: [
    { start: T + 3600, end: T + 7200, capacity: 1 }, { start: T + 10800, end: T + 14400, capacity: 1 }] }, T);
  await assert.rejects(createGrant(db, "tutor", "ical", r.id, "http://cal.example.com/feed.ics", T), /public https/);
  const g = await createGrant(db, "tutor", "ical", r.id, "https://cal.example.com/feed.ics", T);
  const z = (t: number) => new Date(t * 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
  const feed = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:${z(T + 3000)}\r\nDTEND:${z(T + 4000)}\r\nSUMMARY:Private dentist\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART:${z(T + 20000)}\r\nDTEND:${z(T + 21000)}\r\nTRANSP:TRANSPARENT\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
  assert.deepEqual(await syncIcal(db, g, async () => feed, T), { synced: true, busy: 1 }, "a free (transparent) event doesn't block");
  const cur = await db.get(RESOURCES, r.id);
  assert.equal(cur.busy[0].start, T + 3000);
  assert.ok(!JSON.stringify(cur).includes("dentist"), "event titles aren't stored — only busy times");
  await assert.rejects(hold(db, r.id, { holder: "a", slotId: cur.slots[0].id, ttlSec: 900 }, T), (e: any) => e.code === "CAPACITY_UNAVAILABLE");
  assert.equal((await hold(db, r.id, { holder: "a", slotId: cur.slots[1].id, ttlSec: 900 }, T)).qty, 1);
  const out = await syncIcal(db, g, async () => { throw new Error("HTTP 503"); }, T + 60);
  assert.equal(out.synced, false);
  assert.equal((await db.get("connector_grants", g.id)).status, "degraded");
  await assert.rejects(hold(db, r.id, { holder: "c", slotId: cur.slots[1].id, ttlSec: 900 }, T + 4 * 3600), (e: any) => e.code === "AVAILABILITY_UNKNOWN");
});

test("iCal local times use the event's zone; all-day events block the day", () => {
  const busy = parseIcal("BEGIN:VEVENT\r\nDTSTART;TZID=Asia/Kolkata:20270115T100000\r\nDTEND;TZID=Asia/Kolkata:20270115T110000\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nDTSTART;VALUE=DATE:20270116\r\nEND:VEVENT", "UTC", Date.UTC(2027, 0, 1) / 1000);
  assert.equal(new Date(busy[0].start * 1000).toISOString(), "2027-01-15T04:30:00.000Z");
  assert.equal(busy[1].end - busy[1].start, 86_400);
});
