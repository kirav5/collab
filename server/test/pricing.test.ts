// Pricing from the web by the owner's own rules: the arithmetic, and what the buyer is told.
import { test } from "node:test";
import assert from "node:assert/strict";
import { apply, nice, quote, quoteMessage } from "../src/core/pricing.ts";
import { memoryDocs } from "../src/docs.ts";

test("the owner's percentages work out on a looked-up basis, in prices people say", () => {
  assert.equal(nice(apply({ label: "Price", basis: "new price", percent: 25, how: "off", when: null }, 11_095)), 8_320);
  assert.equal(nice(apply({ label: "Repair service", basis: "repair cost", percent: 25, how: "over", when: null }, 1_200)), 1_500);
  assert.equal(nice(apply({ label: "Insurance", basis: "price", percent: 12.5, how: "of", when: null }, 8_320)), 1_040);
});

test("a quote looks up the new price on the web and says where it came from; no evidence, no price", async () => {
  const db = memoryDocs();
  const grounded = async (item: string) => ({
    text: JSON.stringify({ items: [{ label: `${item} at Croma`, price: 11095, unit: "each" }, { label: `${item} at Amazon`, price: 10999, unit: "each" }] }),
    supports: [{ text: `${item} at Croma 11095`, indices: [0] }, { text: `${item} at Amazon 10999`, indices: [1] }],
    sources: [{ title: "croma.com", url: "https://www.croma.com/x" }, { title: "amazon.in", url: "https://www.amazon.in/y" }], searchEntryPoint: null });
  const model: any = { grounded };
  const rules = { lookups: ["new price" as const], pricing: [{ label: "Price", basis: "new price" as const, percent: 25, how: "off" as const, when: "within manufacturer guarantee" }, { label: "Insurance", basis: "price" as const, percent: 12.5, how: "of" as const, when: null }] };
  const q = await quote(db, model, "u1", "Philips HD9252 air fryer", "Bengaluru", rules, 9245, 1_800_000_000);
  assert.equal(q.price, 8_290, "25% under the typical new price (₹11,047 → ₹8,285, said as ₹8,290)");
  assert.equal(quoteMessage(q, rules.pricing[1]), "New, it's usually ₹11,047 (croma.com, amazon.in). Within manufacturer guarantee, we sell at 25% under that: ₹8,290. Optional cover: 12.5% of the price (₹1,040).");
  const none = await quote(db, { grounded: async () => ({ text: "{\"items\":[]}", supports: [], sources: [], searchEntryPoint: null }) } as any, "u1", "Mystery gadget", "Bengaluru", rules, 9245, 1_800_000_000);
  assert.equal(none.price, null);
  assert.equal(quoteMessage(none, null), null);
});

test("a seller who prices from the web opens on the item this buyer asked about, says how, and keeps its floor ratio", async () => {
  const { fresh, save, load, priceFromWeb, LIMITS } = await import("../src/core/engage.ts");
  const db = memoryDocs();
  await db.set(LIMITS, "fact:f1", { key: "fact:f1", owner: "s1", mandate: { price: { opening: 9245, limit: 8321 }, terms: {}, maxRounds: 5 }, autonomy: "negotiate",
    lookups: ["new price"], pricing: [{ label: "Price", basis: "new price", percent: 25, how: "off", when: "within manufacturer guarantee" }, { label: "Insurance", basis: "price", percent: 12.5, how: "of", when: null }] });
  const brief: any = { title: "Used 43 inch LED TV", summary: "Looking for a used 43 inch LED TV.", category: "goods", mode: null, area: "Bengaluru", requirements: [], budget: null, questions: [] };
  const e: any = fresh({ briefId: "b1", brief, requester: { uid: "u1", handle: "u1", name: "Asha" }, provider: { uid: "s1", handle: "devices", name: "Ravi Electronics" },
    offer: { factId: "f1", title: "Electronic devices · Bengaluru", price: 9245, unit: null, category: "goods" } });
  await save(db, e);
  const asked: string[] = [];
  const model: any = { grounded: async (item: string) => { asked.push(item); return {
    text: JSON.stringify({ items: [{ label: "43 inch LED TV at Croma", price: 24990, unit: "each" }, { label: "43 inch LED TV at Flipkart", price: 23990, unit: "each" }] }),
    supports: [{ text: "43 inch LED TV at Croma 24990", indices: [0] }, { text: "43 inch LED TV at Flipkart 23990", indices: [1] }],
    sources: [{ title: "croma.com", url: "https://www.croma.com/tv" }, { title: "flipkart.com", url: "https://www.flipkart.com/tv" }], searchEntryPoint: null }; } };
  const cur = await load(db, e.id);
  await priceFromWeb(db, model, cur);
  assert.equal(asked[0], "Used 43 inch LED TV new", "a shop of many things prices what this buyer asked for");
  const row: any = await db.get(LIMITS, `eng:${e.id}`);
  assert.equal(row.mandate.price.opening, 18_400, "25% under ₹24,490 (₹18,367.50, said as ₹18,400)");
  assert.equal(row.mandate.price.limit, 16_600, "the owner's floor ratio (₹8,321 of ₹9,245 = 90%)");
  assert.match(cur.events.at(-1)!.text, /^New, it's usually ₹24,490 \(croma\.com, flipkart\.com\)\. Within manufacturer guarantee, we sell at 25% under that: ₹18,400\. Optional cover: 12\.5% of the price \(₹2,300\)\.$/);
  assert.doesNotMatch(cur.events.at(-1)!.text, /16,600/, "the limit is never said");
});
