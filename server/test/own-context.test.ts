// An owner's agent answers from everything they told it, by default — never from a note they marked "never use", one
// with contact details or one that states a price limit, and never saying the limit itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { FACTS } from "../src/core/policy.ts";
import { LIMITS, namesLimit, ownContext } from "../src/core/engage.ts";

const fact = (id: string, text: string, extra: Record<string, unknown> = {}) => ({ id, owner: "amy", text, tier: "private", topics: [], offer: null, createdAt: 1, updatedAt: 1, ...extra });

test("private notes, earlier answers and unnamed Protected facts answer by default; the rest never", async () => {
  const db = memoryDocs();
  await db.set(FACTS, "a", fact("a", "I'm vegetarian and prefer lunch only"));
  await db.set(FACTS, "b", fact("b", "Which language do you prefer? — English", { source: "answer", question: "Which language do you prefer?", answer: "English" }));
  await db.set(FACTS, "c", fact("c", "I'm free weekday evenings", { tier: "protected", topics: ["schedule"] }));
  await db.set(FACTS, "d", fact("d", "My budget is up to 3,000 for this"));
  await db.set(FACTS, "e", fact("e", "Call me on 98450 12345"));
  await db.set(FACTS, "f", fact("f", "My landlord is Kabir", { noShare: true }));
  await db.set(FACTS, "g", fact("g", "Public listing", { tier: "public" }));
  await db.set(FACTS, "h", { ...fact("h", "Bob's note"), owner: "bob" });
  await db.set(FACTS, "i", fact("i", "My supplier charges me ₹170 a bottle; never go below ₹250"));
  const ids = (await ownContext(db, "amy", new Set(["c"]))).map(a => a.fact.id).sort();
  assert.deepEqual(ids, ["a", "b"], "a rule already covers c; d and i mention money; e has a phone number; f is never used; g is public; h isn't hers");
});

test("an answer that names the owner's limit for this conversation is held back", async () => {
  const db = memoryDocs();
  await db.set(LIMITS, "brief:b1", { key: "brief:b1", owner: "amy", mandate: { price: { opening: 2700, limit: 3000 }, terms: {}, maxRounds: 5 } });
  const e = { briefId: "b1", offer: { factId: null } } as any;
  assert.equal(await namesLimit(db, e, "requester", "She can pay up to ₹3,000."), true);
  assert.equal(await namesLimit(db, e, "requester", "She'd like lunch on weekdays."), false);
  assert.equal(await namesLimit(db, e, "requester", "She can pay 3k."), true);
  assert.equal(await namesLimit(db, e, "requester", "Notice period is 3 months."), false, "3 isn't ₹3,000");
  assert.equal(await namesLimit(db, e, "provider", "₹3,000"), false, "the other side's limit isn't this side's");
});
