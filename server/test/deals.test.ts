// Market data from closed deals: anonymised records, insights, signed receipts, autonomy levels and outcomes —
// none of it touches the model.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { Model } from "../src/ai/gemini.ts";
import { memoryDocs } from "../src/docs.ts";
import { DEALS, type Deal, dealOf, forProvider, forRequester, insights, receipt } from "../src/core/deals.ts";
import { INBOX, LIMITS, type Turn, fresh, load, providerTurn, requesterTurn, resolve, save } from "../src/core/engage.ts";
import { PROFILES } from "../src/core/policy.ts";
import type { Engagement, Profile, SharedBrief } from "../src/core/model.ts";

const model: Model = { name: "fake", complete: async () => JSON.stringify({ questions: [] }) };
const now = () => Math.floor(Date.now() / 1000);
const profile = (uid: string): Profile => ({ uid, handle: uid, name: uid, bio: "", area: null, createdAt: 0 });
const brief: SharedBrief = { title: "2BHK wanted", summary: "Looking for a flat.", category: "property-rent", mode: null, area: "Indiranagar", requirements: [], budget: null, questions: [] };

const deal = (id: string, category: string, area: string | null, dealPrice: number, extra: Partial<Deal> = {}): Deal =>
  ({ id, engagementId: `e-${id}`, category, area, unit: "month", listPrice: 150, dealPrice, discountPct: 0, rounds: 3, hours: 24, questions: 3, at: 0, ...extra });

test("insights needs 3 deals; area scope wins when 3+ match it", async () => {
  const db = memoryDocs();
  for (const p of [100, 120]) await db.set(DEALS, `d${p}`, deal(`d${p}`, "lessons", null, p, { discountPct: (150 - p) / 150 * 100 }));
  assert.equal(await insights(db, { category: "lessons" }), null);
  for (const p of [130, 150]) await db.set(DEALS, `d${p}`, deal(`d${p}`, "lessons", null, p, { discountPct: (150 - p) / 150 * 100 }));
  const i = await insights(db, { category: "lessons" });
  assert.equal(i?.n, 4);
  assert.equal(i?.scope, "category");
  assert.equal(i?.median, 125);
  assert.equal(i?.p25, 115);
  assert.equal(i?.p75, 135);
  assert.equal(i?.discountPct, 16.7);
  const db2 = memoryDocs();
  for (const [j, p] of [100, 120, 130].entries()) await db2.set(DEALS, `x${j}`, deal(`x${j}`, "lessons", "X", p));
  await db2.set(DEALS, "y", deal("y", "lessons", "Elsewhere", 200));
  const a = await insights(db2, { category: "lessons", area: "X" });
  assert.equal(a?.scope, "area");
  assert.equal(a?.n, 3);
  assert.equal(a?.median, 120);
});

test("insights pool one unit: the majority wins, or the asked-for unit filters", async () => {
  const db = memoryDocs();
  for (const [i, u] of ["hour", "hour", "hour", "day", "day"].entries())
    await db.set(DEALS, `u${i}`, deal(`u${i}`, "services", null, 100 + i * 10, { unit: u }));
  const i = await insights(db, { category: "services" });
  assert.equal(i?.n, 3);
  assert.equal(i?.unit, "hour");
  assert.equal(i?.median, 110);
  assert.equal(await insights(db, { category: "services", unit: "day" }), null, "fewer than 3 same-unit deals");
  const d2 = await insights(db, { category: "services", unit: "hour" });
  assert.equal(d2?.n, 3);
});

test("a deal record carries no person and no limit", () => {
  const e = fresh({ briefId: "b1", brief, requester: { uid: "amy", handle: "amy", name: "Amy" }, provider: { uid: "bob", handle: "bob", name: "Bob" },
    offer: { factId: "f1", title: "2BHK for rent", price: 38_000, unit: "month", category: "property-rent" } });
  e.phase = "agreed"; e.agreedAt = now();
  e.negotiation.deal = { id: "p1", price: 36_000, terms: {}, round: 2 }; // provider's delegated limit was 34,500
  const d = dealOf(e, now())!;
  assert.deepEqual(Object.keys(d).sort(), ["area", "at", "category", "dealPrice", "discountPct", "engagementId", "hours", "id", "item", "listPrice", "questions", "rounds", "unit"].sort());
  const s = JSON.stringify(d);
  assert.ok(!s.includes("amy") && !s.includes("bob") && !s.includes("Amy") && !s.includes("Bob") && !s.includes("34500"));
  const demo = dealOf({ ...e, provider: { ...e.provider, uid: "demo-bob" } }, now())!;
  assert.equal(demo.demo, true);
  assert.equal(dealOf({ ...e, phase: "deal" }, now()), null);
});

test("insight lines: medians, limits, asking price, demo tag", () => {
  const i = { n: 12, scope: "area" as const, category: "property-rent", area: "Indiranagar", unit: "month", median: 34_500, p25: 32_000, p75: 36_000, discountPct: 8, rounds: 3, demo: true };
  const r = forRequester(i, 30_000, 38_000);
  assert.ok(r[0].includes("median") && r[0].includes("12 deals in Indiranagar"));
  assert.ok(r[1].includes("under asking"));
  assert.ok(r[2].includes("₹38,000") && r[2].includes("expect around"));
  assert.ok(r[3].includes("below where most similar deals closed"));
  assert.equal(r.at(-1), "(from demo deals)");
  assert.ok(forRequester(i, 40_000).some(l => l.includes("above where most similar deals closed")));
  const p = forProvider(i, 42_000);
  assert.ok(p[0].includes("median") && p[0].includes("under asking"));
  assert.ok(p.some(l => l.includes("above the range similar deals closed")));
  assert.ok(forProvider({ ...i, demo: false }, 30_000).some(l => l.includes("already below where similar deals closed")));
});

test("receipts: stable hash, signed per side, no limit inside", () => {
  const e = fresh({ briefId: "b1", brief, requester: { uid: "amy", handle: "amy", name: "Amy" }, provider: { uid: "bob", handle: "bob", name: "Bob" },
    offer: { factId: "f1", title: "2BHK for rent", price: 38_000, unit: "month", category: "property-rent" } });
  e.phase = "agreed"; e.agreedAt = 1_700_000_000;
  e.negotiation.deal = { id: "p1", price: 36_000, terms: {}, round: 2 }; // the mandate's limit was 34,500
  e.negotiation.confirmedBy = { provider: "mandate" };
  const sign = (uid: string, hash: string) => `sig-${uid}-${hash.slice(0, 8)}`;
  const r1 = receipt(e, sign)!, r2 = receipt(e, sign)!;
  assert.equal(r1.hash, r2.hash);
  assert.equal(r1.hash.length, 64);
  assert.equal(r1.signatures.requester, `sig-amy-${r1.hash.slice(0, 8)}`);
  assert.equal(r1.signatures.provider, `sig-bob-${r1.hash.slice(0, 8)}`);
  assert.equal(r1.confirmedBy.provider, "mandate");
  assert.equal(r1.confirmedBy.requester, "owner");
  e.negotiation.deal = { ...e.negotiation.deal, price: 35_000 };
  assert.notEqual(receipt(e, sign)!.hash, r1.hash);
  // Legacy engagements without agreedAt hash off the recorded "Deal agreed" event, not the mutable updatedAt.
  const legacy = { ...e, agreedAt: undefined, events: [...e.events, { at: 1_600_000_000, who: "system" as const, text: "Deal agreed by both owners." }] };
  assert.equal(receipt({ ...legacy, updatedAt: legacy.updatedAt + 500 }, sign)!.hash, receipt(legacy, sign)!.hash);
  const without = JSON.stringify({ ...r1, confirmedBy: undefined });
  assert.ok(!without.includes("34500") && !/"limit"/.test(without) && !/"mandate"/.test(without));
});

test("an expired delegated limit falls back to asking the owner for a move", async () => {
  const db = memoryDocs();
  await db.set(PROFILES, "pat", profile("pat"));
  const e = fresh({ briefId: "b1", brief, requester: { uid: "r1", handle: "r1", name: "r1" }, provider: { uid: "pat", handle: "pat", name: "pat" },
    offer: { factId: "fact1", title: "2BHK", price: 38_000, unit: "month", category: "property-rent" } });
  await db.set(LIMITS, "fact:fact1", { key: "fact:fact1", owner: "pat", mandate: { price: { opening: 38_000, limit: 34_500 }, terms: {}, maxRounds: 5 }, expires: now() - 10, createdAt: now() - 86_400 });
  const out = await providerTurn(db, model, e, { kind: "collab.turn/v1", from: "requester", engagementId: e.id } as Turn);
  assert.equal(out.proposal, undefined, "no move under an expired mandate");
  const items = await db.find(INBOX, [["engagementId", "==", e.id]], 10);
  assert.equal(items[0]?.kind, "move");
});

test("a 'close' mandate confirms inside its limit and the deal is recorded once", async () => {
  const db = memoryDocs();
  await db.set(PROFILES, "pat", profile("pat"));
  await db.set(LIMITS, "fact:fact1", { key: "fact:fact1", owner: "pat", mandate: { price: { opening: 38_000, limit: 34_500 }, terms: {}, maxRounds: 5 }, autonomy: "close", createdAt: now() });
  const e = fresh({ briefId: "b1", brief, requester: { uid: "amy", handle: "amy", name: "Amy" }, provider: { uid: "pat", handle: "pat", name: "Pat" },
    offer: { factId: "fact1", title: "2BHK", price: 38_000, unit: "month", category: "property-rent" } });
  const turn = (t: Partial<Turn>) => ({ kind: "collab.turn/v1", from: "requester", engagementId: e.id, ...t } as Turn);
  // The provider's agent opens with its quote; the requester accepts it; the mandate confirms for the provider.
  const first = await providerTurn(db, model, e, turn({}));
  assert.ok(first.proposal);
  await save(db, e);
  const out = await providerTurn(db, model, e, turn({ accept: first.proposal!.id }));
  await save(db, e);
  assert.equal(out.confirm, true);
  assert.equal(e.negotiation.confirmed.provider, true);
  assert.equal(e.negotiation.confirmedBy?.provider, "mandate");
  assert.ok(e.events.some(ev => ev.text.includes("standing mandate")));
  // The requester's owner confirms on their device: agreed, recorded once.
  await requesterTurn(db, model, e, out);
  await save(db, e);
  const item = (await db.find(INBOX, [["owner", "==", "amy"], ["status", "==", "open"]], 10)).find((i: any) => i.kind === "confirm");
  assert.ok(item, "the requester's owner is asked to confirm");
  await resolve(db, model, item, { confirm: true });
  const done = (await load(db, e.id))!;
  assert.equal(done.phase, "agreed");
  assert.equal(done.dealRecorded, true);
  assert.equal((await db.find(DEALS, [], 10)).length, 1);
  await save(db, done);
  await save(db, done);
  assert.equal((await db.find(DEALS, [], 10)).length, 1, "the deal is written once");
});
