// The daily agent: what the owner did in the last day becomes one Private summary note — once a day, nothing on a
// quiet day, never contact details.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { summarise, runDaily } from "../src/core/daily.ts";

const model = (o: unknown) => ({ name: "t", complete: async () => JSON.stringify(o) }) as any;
const NOW = 2_000_000_000;

async function seed() {
  const db = memoryDocs();
  await db.set("profiles", "u1", { uid: "u1", name: "Asha", handle: "asha" });
  await db.set("briefs", "b1", { id: "b1", owner: "u1", createdAt: NOW - 3600, shared: { title: "Home deep cleaning", area: "Koramangala" } });
  await db.set("engagements", "e1", { id: "e1", participants: ["u1", "demo-sparkle"], requester: { uid: "u1", name: "Asha" }, provider: { uid: "demo-sparkle", name: "Sparkle" },
    offer: { title: "Home deep cleaning · 2BHK", unit: "task" }, phase: "agreed", negotiation: { deal: { price: 3200 } }, createdAt: NOW - 3000, updatedAt: NOW - 600 });
  return db;
}

test("a day's activity becomes one Private summary, once a day", async () => {
  const db = await seed();
  const f = await summarise(db, model({ summary: "You booked a deep clean in Koramangala with Sparkle at 3200.", preferences: ["Books cleaning on weekends", "Call me on 98450 12345"] }), "u1", "Asha", NOW);
  assert.ok(f); assert.equal(f!.tier, "private"); assert.equal(f!.source, "summary");
  assert.match(f!.text, /deep clean/); assert.match(f!.text, /Books cleaning on weekends/); assert.doesNotMatch(f!.text, /98450/);
  assert.equal(await summarise(db, model({ summary: "again", preferences: [] }), "u1", "Asha", NOW + 600), null, "not twice in a day");
});

test("the scheduler summarises active owners only, never demo people; a quiet day writes nothing", async () => {
  const db = await seed();
  await db.set("profiles", "u2", { uid: "u2", name: "Quiet" });
  assert.equal(await runDaily(db, null, NOW), 1);
  const notes = (await db.find("facts", [["owner", "==", "u1"]])).filter((f: any) => f.source === "summary");
  assert.equal(notes.length, 1); assert.match(notes[0].text, /Home deep cleaning/);
  assert.equal((await db.find("facts", [["owner", "==", "demo-sparkle"]])).length, 0);
});

test("a daily summary is never used to answer anyone else", async () => {
  const db = await seed();
  await summarise(db, null, "u1", "Asha", NOW);
  const { ownContext } = await import("../src/core/engage.ts");
  assert.equal((await ownContext(db, "u1", new Set())).filter(a => a.fact.source === "summary").length, 0);
});
