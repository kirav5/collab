// Someone's card: each offering with the action that fits it (buy, book, visit, ask), stock and free times from its
// ledger, and the words an order says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orderText, storefront } from "../src/core/storefront.ts";
import type { Fact } from "../src/core/model.ts";
import type { Resource } from "../src/core/resources.ts";

const T = 1_800_000_000;
const offer = (id: string, category: string, title: string, amount: number | null = 450, period: string | null = null): Fact => ({
  id, owner: "o", text: title, tier: "public", topics: [], createdAt: T, updatedAt: T,
  offer: { id, category, title, details: "", price: { amount: amount as number, currency: "INR", period }, place: { name: "X", lat: 0, lon: 0, isCity: false }, attributes: {}, askBuyer: [], publishedAt: T, expiresAt: T + 1e7, status: "active" },
});
const stock = (factId: string, onHand: number, held = 0, observedAt = T, source = "ledger"): Resource => ({
  id: `r-${factId}`, schemaVersion: 1, revision: 1, owner: "o", factId, type: "quantity", title: "x", unit: "each", onHand, slots: [], timezone: "Asia/Kolkata",
  holds: held ? [{ id: "h", holder: "b", engagementId: null, qty: held, slotId: null, state: "held", createdAt: T, expiresAt: T + 900 }] : [],
  source, observedAt, staleAfterSec: 3600 } as unknown as Resource);
const slots = (factId: string, starts: number[]): Resource => ({
  id: `s-${factId}`, schemaVersion: 1, revision: 1, owner: "o", factId, type: "slots", title: "x", unit: "booking", onHand: 0, timezone: "Asia/Kolkata",
  slots: starts.map((s, i) => ({ id: `slot${i}`, start: s, end: s + 3600, capacity: 1 })), holds: [], source: "ledger", observedAt: T, staleAfterSec: 3600 } as unknown as Resource);

test("goods are bought with a quantity bounded by stock; low and out of stock say so; a stale count says it's unconfirmed", () => {
  const [a] = storefront([offer("a", "goods", "Water Bottles · items for sale")], [stock("a", 12)], T);
  assert.equal(a.action, "buy"); assert.deepEqual(a.stock, { state: "in", available: 12 }); assert.equal(a.maxQuantity, 12); assert.equal(a.name, "water bottles");
  assert.deepEqual(storefront([offer("a", "goods", "B")], [stock("a", 5, 3)], T)[0].stock, { state: "low", available: 2 }, "held units aren't available");
  const out = storefront([offer("a", "goods", "B")], [stock("a", 0)], T)[0];
  assert.equal(out.stock!.state, "out"); assert.equal(out.maxQuantity, 0);
  assert.deepEqual(storefront([offer("a", "goods", "B")], [stock("a", 9, 0, T - 7200, "manual")], T)[0].stock, { state: "unknown", available: null });
  assert.equal(storefront([offer("a", "goods", "B")], [], T)[0].stock, null, "untracked: no stock line");
  assert.equal(storefront([offer("a", "goods", "B")], [], T)[0].maxQuantity, 20);
  assert.equal(storefront([offer("c", "goods", "Decathlon cycle · used")], [], T)[0].maxQuantity, 1, "a used item is one item");
  assert.equal(storefront([offer("w", "goods", "Water Bottles · items for sale (new or used)")], [], T)[0].maxQuantity, 20, "the category's label isn't a condition");
});

test("lessons are booked from the next free times (two weeks, soonest first); flats are visited; no price means ask", () => {
  const [g] = storefront([offer("g", "lessons", "Guitar lessons", 800, "hour")], [slots("g", [T + 30 * 86_400, T + 7200, T - 100, T + 3600])], T);
  assert.equal(g.action, "book"); assert.deepEqual(g.slots!.map(s => s.id), ["slot3", "slot1"], "past and far-off times left out");
  assert.equal(g.timezone, "Asia/Kolkata"); assert.equal(g.maxQuantity, 1);
  assert.equal(storefront([offer("g", "lessons", "Guitar")], [], T)[0].slots, null, "no schedule: request a booking");
  assert.equal(storefront([offer("k", "property-rent", "2BHK")], [], T)[0].action, "visit");
  assert.equal(storefront([offer("n", "goods", "Old cycle", null)], [], T)[0].action, "ask");
  assert.equal(storefront([offer("r", "rides", "Airport ride", 1100, "ride")], [], T)[0].action, "book");
});

test("a paused owner's card shows offerings but no stock or times; sold and private offerings never show", () => {
  const paused = storefront([offer("a", "goods", "B")], [stock("a", 5)], T, true)[0];
  assert.equal(paused.stock, null);
  const sold = offer("s", "goods", "Sold"); sold.offer!.status = "sold";
  const priv = offer("p", "goods", "Private"); priv.tier = "private";
  assert.deepEqual(storefront([sold, priv, offer("a", "goods", "B")], [], T).map(i => i.factId), ["a"]);
});

test("an order reads naturally: how many, when, at the listed price or as an offer", () => {
  const it = { name: "water bottles", currency: "INR" };
  assert.equal(orderText(it, 2, 450, 450, null), "I'd like 2 × water bottles at ₹450 each. (₹900 in all)");
  assert.equal(orderText(it, 1, 450, 450, null), "I'd like water bottles at ₹450.");
  assert.equal(orderText(it, 2, 400, 450, null), "I'd like 2 × water bottles — would you take ₹400 each? (₹800 in all)");
  assert.equal(orderText({ name: "guitar lessons", currency: "INR" }, 1, 800, 800, "Sat 18 Oct, 6:00 pm"), "I'd like guitar lessons on Sat 18 Oct, 6:00 pm at ₹800.");
});
