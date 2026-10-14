// Outbox recovery (TP-12): a turn saved as waiting but never queued — a crash between the save and the enqueue —
// is found and queued again under a stable name, so the recovery scan and the original request can't make two.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { ENGAGEMENTS, fresh, save } from "../src/core/engage.ts";
import { outboxKey, recoverOutbox } from "../src/core/recovery.ts";
import type { SharedBrief } from "../src/core/model.ts";

const brief: SharedBrief = { title: "Bottle", summary: "Test.", category: "goods", mode: null, area: null, requirements: [], budget: null, questions: [] };
const make = (id: string) => fresh({ id, briefId: null, brief, requester: { uid: "a", handle: "a", name: "A" }, provider: { uid: "b", handle: "b", name: "B" },
  offer: { factId: null, title: "Bottle", price: null, unit: null, category: "goods" } as never });

test("a waiting turn that was never queued is recovered, once per turn", async () => {
  const db = memoryDocs();
  const waiting = make("w1"); waiting.outbox = { kind: "collab.turn/v1", from: "requester", engagementId: "w1", questions: [{ id: "q", question: "?" }] };
  await save(db, waiting);
  const done = make("d1"); await save(db, done);
  const late = make("l1"); late.outbox = { kind: "collab.turn/v1", from: "requester", engagementId: "l1" }; late.phase = "agreed"; await save(db, late);
  const t = Math.floor(Date.now() / 1000);
  // Too soon: the original request may still be queueing it.
  const calls: string[][] = [];
  const enqueue = async (id: string, _d?: number, dedupe?: string) => { calls.push([id, dedupe!]); return true; };
  assert.equal((await recoverOutbox(db, t, enqueue, async () => {})).found, 0);
  // A minute later it's recovered, with a name that's the same on every scan of the same turn.
  const r1 = await recoverOutbox(db, t + 61, enqueue, async () => {});
  const r2 = await recoverOutbox(db, t + 122, enqueue, async () => {});
  assert.deepEqual([r1.queued, r2.queued], [1, 1]);
  assert.deepEqual(calls.map(c => c[0]), ["w1", "w1"]);
  assert.equal(calls[0][1], calls[1][1]);
  assert.equal(calls[0][1], outboxKey(waiting.outbox));
  // Sent: the flag clears with the next save and nothing more is found.
  const sent = (await db.get(ENGAGEMENTS, "w1")) as any; sent.outbox = null; await save(db, sent);
  assert.equal((await recoverOutbox(db, t + 200, enqueue, async () => {})).found, 0);
});

test("without a queue, recovered turns run directly", async () => {
  const db = memoryDocs();
  const e = make("x1"); e.outbox = { kind: "collab.turn/v1", from: "requester", engagementId: "x1" }; await save(db, e);
  const ran: string[] = [];
  const r = await recoverOutbox(db, Math.floor(Date.now() / 1000) + 61, null, async id => { ran.push(id); });
  assert.deepEqual([r.ran, ran], [1, ["x1"]]);
});
