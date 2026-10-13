// Scheduled agents: a watch alerts its owner once per new person who fits, never twice, and stops when it expires.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { fakeModel } from "../src/ai/fake.ts";
import { ALERTS, WATCHES, runDue, startWatch } from "../src/core/watch.ts";
import { BRIEFS } from "../src/core/briefs.ts";
import { FACTS, PROFILES } from "../src/core/policy.ts";
import { resolve } from "../src/market/places.ts";

const now = Math.floor(Date.now() / 1000);

test("a watch alerts once for someone new, then stays quiet; an expired watch stops", async () => {
  const db = memoryDocs(), model = fakeModel();
  const place = resolve("Indiranagar")!;
  for (const uid of ["amy", "pat"]) await db.set(PROFILES, uid, { uid, handle: uid, name: uid.toUpperCase(), bio: "", area: place, createdAt: now });
  const shared = { title: "Steel water bottle", summary: "A steel water bottle", category: "goods", mode: "in_person", area: place.name, requirements: [], budget: null, questions: [] };
  await db.set(BRIEFS, "b1", { id: "b1", owner: "amy", shared, createdAt: now,
    need: { id: "n", category: "goods", text: "", place, radiusKm: 8, maxPrice: null, attributes: {}, mustAsk: [], unit: null, mode: "in_person", filters: [], mandate: null } });
  const w = await startWatch(db, "amy", "b1", []);
  await db.merge(WATCHES, w.id, { nextRun: now - 1 });
  assert.deepEqual(await runDue(db, model, async () => {}), { ran: 1, alerts: 0 }, "nobody yet");

  const text = "Steel water bottles, 1 litre, ₹450 each, Indiranagar";
  await db.set(FACTS, "f1", { id: "f1", owner: "pat", text, tier: "public", topics: [], createdAt: now, updatedAt: now, embedding: (await model.embed!([text], "document"))![0],
    offer: { id: "o1", category: "goods", title: "Steel water bottles", details: text, price: { amount: 450, currency: "INR", period: null }, place, attributes: {}, askBuyer: [], publishedAt: now, expiresAt: now + 86_400, status: "active" } });
  await db.merge(WATCHES, w.id, { nextRun: now - 1 });
  const got: string[] = [];
  assert.deepEqual(await runDue(db, model, async a => { got.push(a.handle); }), { ran: 1, alerts: 1 });
  assert.deepEqual(got, ["pat"]);
  await db.merge(WATCHES, w.id, { nextRun: now - 1 });
  assert.equal((await runDue(db, model, async () => {})).alerts, 0, "the same person isn't announced twice");
  assert.equal((await db.find(ALERTS, [["owner", "==", "amy"]])).length, 1);

  await db.merge(WATCHES, w.id, { nextRun: now - 1, expires: now - 1 });
  await runDue(db, model, async () => {});
  assert.equal((await db.get(WATCHES, w.id)).active, false);
});
