// Decisions (TP-05, TP-07): an approval binds to the exact deal; the same decision isn't asked twice; every decision
// has a deadline — an unconfirmed deal lapses (silence is not approval), an unanswered question gets one reminder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { INBOX, Stale, askOwner, fresh, load, offerDeal, resolve, save } from "../src/core/engage.ts";
import { expireDecisions } from "../src/core/decisions.ts";
import { DEFAULT_POLICY } from "../src/config/policy.ts";
import type { InboxItem, SharedBrief } from "../src/core/model.ts";

const brief: SharedBrief = { title: "Mug", summary: "Mug?", category: "", mode: null, area: null, requirements: [], budget: null, questions: [] };
const setup = async () => {
  const db = memoryDocs();
  const e = fresh({ briefId: null, brief, requester: { uid: "shop", handle: "shop", name: "Shop" }, provider: { uid: "ana", handle: "ana", name: "Ana" },
    offer: { factId: null, title: "Mug", price: null, unit: null, category: null } });
  await save(db, e);
  return { db, e };
};
const openFor = async (db: any, uid: string) => ((await db.find(INBOX, [["owner", "==", uid]], 20)) as InboxItem[]).filter(i => i.status === "open");

test("approving a deal that has since changed is refused as stale", async () => {
  const { db, e } = await setup();
  await offerDeal(db, e, "requester", 100, "I'll sell the mug for ₹100");
  const [first] = await openFor(db, "ana");
  assert.equal(first.proposalId, e.negotiation.deal!.id);
  const cur = await load(db, e.id);
  await offerDeal(db, cur, "requester", 90, "Actually, ₹90");
  await assert.rejects(resolve(db, null, first, { confirm: true }), Stale);
  const [second] = await openFor(db, "ana");
  assert.notEqual(second.id, first.id);
  await resolve(db, null, second, { confirm: true });
  assert.equal((await load(db, e.id)).phase, "agreed");
});

test("the same question isn't asked twice", async () => {
  const { db, e } = await setup();
  const a = await askOwner(db, e, "provider", { kind: "answer", qaId: "q1", question: "Do you have it in blue?" });
  const b = await askOwner(db, e, "provider", { kind: "answer", qaId: "q1", question: "Do you have it in blue?" });
  assert.equal(a, b);
  assert.equal((await openFor(db, "ana")).length, 1);
});

test("at the deadline an unconfirmed deal lapses; an unanswered question is reminded once", async () => {
  const { db, e } = await setup();
  await offerDeal(db, e, "requester", 100, "I'll sell the mug for ₹100");
  const [confirm] = await openFor(db, "ana");
  assert.equal(confirm.onTimeout, "lapse");
  const cur = await load(db, e.id);
  await askOwner(db, cur, "provider", { kind: "answer", qaId: "q2", question: "When can you collect?" }); await save(db, cur);
  const later = confirm.deadline! + 1, reminders: string[] = [];
  const r = await expireDecisions(db, later, async i => { reminders.push(i.question!); });
  assert.deepEqual(r, { lapsed: 1, reminded: 1 });
  const after = await load(db, e.id);
  assert.equal(after.phase, "asking"); assert.equal(after.negotiation.deal, null);
  assert.ok(after.events.some(x => /lapsed/.test(x.text)));
  assert.equal(((await db.get(INBOX, confirm.id)) as InboxItem).status, "expired");
  await assert.rejects(resolve(db, null, confirm, { confirm: true }), Stale, "a lapsed approval can't be used later");
  assert.deepEqual((await expireDecisions(db, later + 60, async () => {})), { lapsed: 0, reminded: 0 }, "one reminder only");
  assert.equal(confirm.deadline! - confirm.createdAt, DEFAULT_POLICY.timing.decisionTtlSec);
});
