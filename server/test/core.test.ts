// Who may see what, and what may cross: the policy (deny by default), the privacy wall, and the brief providers see.
import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryDocs } from "../src/docs.ts";
import { FACTS, PROFILES, RULES, allowedFor, shapeAnswer } from "../src/core/policy.ts";
import { clean } from "../src/core/wall.ts";
import { SharedBriefTask } from "../src/core/tasks.ts";
import { type Turn, fresh, requesterTurn } from "../src/core/engage.ts";
import type { Engagement, Fact, Rule, SharedBrief } from "../src/core/model.ts";

const now = Math.floor(Date.now() / 1000);
const fact = (id: string, tier: Fact["tier"], topics: string[] = []): Fact => ({ id, owner: "ann", text: id, tier, topics, offer: null, createdAt: now, updatedAt: now });
const rule = (id: string, audience: string, topics: string[], extra: Partial<Rule> = {}): Rule =>
  ({ id, owner: "ann", audience, audienceName: audience, topics, shape: "full", approval: "auto", expires: null, createdAt: now, ...extra });

async function world() {
  const db = memoryDocs();
  await db.set(PROFILES, "ann", { uid: "ann", handle: "ann", name: "Ann", bio: "", area: null, createdAt: now });
  for (const f of [fact("public note", "public"), fact("availability", "protected", ["availability"]), fact("health", "protected", ["health"]), fact("work", "protected", ["work"])]) await db.set(FACTS, f.id, f);
  await db.set(RULES, "r1", rule("r1", "bob", ["availability"]));
  await db.set(RULES, "r2", rule("r2", "anyone", ["work"], { approval: "review" }));
  await db.set(RULES, "r3", rule("r3", "bob", ["health"], { expires: now - 10 }));
  await db.set(RULES, "r4", rule("r4", "bob", ["health"], { revoked: true }));
  return db;
}

test("strangers get Public facts and only what an 'anyone' rule names", async () => {
  const db = await world();
  assert.deepEqual((await allowedFor(db, "ann", null, now)).map(a => a.fact.id).sort(), ["public note", "work"]);
});

test("a named person gets their rule's topics; expired and revoked rules give nothing", async () => {
  const db = await world();
  const bob = await allowedFor(db, "ann", "bob", now);
  assert.deepEqual(bob.map(a => a.fact.id).sort(), ["availability", "public note", "work"]);
  assert.equal(bob.find(a => a.fact.id === "work")?.via?.approval, "review");
  assert.ok(!bob.some(a => a.fact.id === "health"));
});

test("pausing shares nothing at all", async () => {
  const db = await world();
  await db.merge(PROFILES, "ann", { paused: true });
  assert.deepEqual(await allowedFor(db, "ann", "bob", now), []);
});

test("answers are cut to the rule's level of detail", () => {
  assert.equal(shapeAnswer("Yes, weekday evenings after 6. Not weekends.", "oneLine"), "Yes, weekday evenings after 6.");
  assert.equal(shapeAnswer("No, not this week.", "yesNo"), "No.");
});

test("the wall removes contact details and the owner's other people, keeps the recipient's name", () => {
  const out = clean("Call Priya on +91 98450 12345 or mail priya@x.com, Sam knows; see https://x.y", [{ name: "Priya", replacement: "a contact" }, { name: "Sam", replacement: "a contact" }], ["Sam"]);
  assert.ok(!/98450|@x\.com|https/.test(out));
  assert.ok(out.includes("a contact") && out.includes("Sam"));
});

test("the brief providers see carries no money and no limit", () => {
  const input = { text: "2BHK in Indiranagar, budget 36000", category: "property-rent", limit: 36_000 };
  assert.equal(SharedBriefTask.validate({ title: "2BHK in Indiranagar", summary: "Budget 36,000 a month." }, input), null);
  assert.equal(SharedBriefTask.validate({ title: "2BHK in Indiranagar", summary: "Up to 36 thousand." }, input), null);
  assert.ok(SharedBriefTask.validate({ title: "2BHK in Indiranagar", summary: "A two-bedroom flat to rent near 100 Feet Road, pets welcome." }, input));
});

test("an information must-ask judged unmet never ends it; a yes/no check does", async () => {
  const db = memoryDocs();
  const brief: SharedBrief = { title: "Guitar lessons", summary: "Wants lessons.", category: "lessons", mode: null, area: "Jayanagar", requirements: [], budget: null, questions: [] };
  const mk = () => fresh({ briefId: "b1", brief, requester: { uid: "amy", handle: "amy", name: "Amy" }, provider: { uid: "pat", handle: "pat", name: "Pat" },
    offer: { factId: null, title: "Guitar lessons", price: 800, unit: "hour", category: "lessons" } });
  const turn = (e: Engagement, question: string): Turn => ({ kind: "collab.turn/v1", from: "provider", engagementId: e.id, answers: [{ id: "q1", question, answer: "No." }] });
  const info = mk();
  info.qa.push({ id: "q1", from: "requester", question: "How many years have you been teaching this?", status: "open", required: true });
  await requesterTurn(db, null, info, turn(info, info.qa[0].question));
  assert.notEqual(info.phase, "closed", "an information question can't end the conversation");
  assert.equal(info.qa[0].verdict, "unmet");
  assert.ok(info.events.some(x => x.text.includes("didn't settle a must-have")));
  const check = mk();
  check.qa.push({ id: "q1", from: "requester", question: "Can you come on weekends?", status: "open", required: true });
  const out = await requesterTurn(db, null, check, turn(check, check.qa[0].question));
  assert.equal(check.phase, "closed");
  assert.ok(out?.decline);
  assert.ok(check.events.some(x => x.text.includes("didn't meet a must-have")));
});
