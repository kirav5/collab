// What a visitor is offered to ask (QR card and agent card), what kind of pass a paid deal gets, how fair-price
// sources are labelled, and which API calls wait for App Check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { forOffer, itemName, kindOf, suggestionsFor } from "../src/core/suggest.ts";
import { passKind, pickupDetails } from "../src/core/pickup.ts";
import { cleanLabel } from "../src/core/price-check.ts";
import { appCheckRequired } from "../src/core/app-check.ts";
import type { Engagement, Fact } from "../src/core/model.ts";

const offer = (id: string, category: string, title: string, amount: number | null = 400, at = 1): Fact => ({
  id, owner: "shop", text: title, tier: "public", topics: [], createdAt: at, updatedAt: at,
  offer: { id, category, title, details: "", price: { amount: amount as number, currency: "INR", period: null }, place: { name: "Indiranagar", lat: 0, lon: 0, isCity: false },
    attributes: {}, askBuyer: [], publishedAt: at, expiresAt: at + 1e6, status: "active" },
});

test("item names read naturally: plain words lower-cased, brands and sizes kept", () => {
  assert.equal(itemName("Water Bottles · items for sale (new or used) · Indiranagar"), "water bottles");
  assert.equal(itemName("Milton 1L Thermosteel bottle"), "Milton 1L Thermosteel bottle");
  assert.equal(itemName("IELTS coaching"), "IELTS coaching");
  assert.equal(itemName("Guitar lessons"), "guitar lessons");
});

test("a shop with tracked stock is asked about stock, price and pickup; a tutor about times, rate and a trial", () => {
  const bottles = forOffer(offer("f1", "goods", "Water Bottles · items for sale"), "quantity").map(s => s.text);
  assert.deepEqual(bottles, ["Do you have water bottles in stock?", "What's your best price for water bottles?", "Can I order water bottles now and pick it up today?"]);
  const guitar = forOffer(offer("f2", "lessons", "Guitar lessons"), "slots").map(s => s.text);
  assert.equal(guitar[0], "What times are free this week for guitar lessons?");
  assert.equal(guitar[2], "Can I book a trial session?");
  assert.equal(forOffer(offer("f3", "lessons", "Guitar lessons"), null)[0].text, "Are you free this week for guitar lessons?", "no slots: ask, don't promise a booking");
  assert.equal(forOffer(offer("f4", "goods", "Old cycle", null))[1].text, "How much is old cycle?", "no price listed: ask it");
  assert.equal(forOffer(offer("f5", "property-rent", "2BHK in Indiranagar"))[1].text, "Is the rent negotiable?");
  assert.equal(forOffer(offer("f6", "food", "Birthday cakes"))[0].text, "Can you make birthday cakes for tomorrow?");
});

test("every category gets three distinct, specific questions with no unexplained 'then' or 'that'", () => {
  const cats = ["property-sale", "property-rent", "wholesale", "freight", "services", "equipment-rental", "commercial-lease", "manufacturing", "rides", "food", "lessons", "tasks", "goods", "vehicles", "stays", "jobs", "events", "pets", "other", "unknown-category"];
  for (const c of cats) {
    const s = forOffer(offer("x", c, "Thing"));
    assert.equal(s.length, 3, c);
    assert.equal(new Set(s.map(x => x.text)).size, 3, `${c}: distinct`);
    for (const x of s) {
      assert.match(x.text, /\?$|\.$/, `${c}: a question`);
      assert.ok(!/\b(by then|that time|that date|my dates)\b/i.test(x.text), `${c}: "${x.text}" refers to nothing`);
    }
  }
  assert.equal(kindOf("unknown-category"), "other");
});

test("several offerings: the first two, a price, and what else; a person with nothing on offer is asked about themselves", () => {
  const two = suggestionsFor("Shop", [offer("a", "goods", "Steel bottles", 400, 5), offer("b", "goods", "Lunch boxes", 300, 9)]);
  assert.deepEqual(two.map(s => s.text), ["Do you have lunch boxes in stock?", "Do you have steel bottles in stock?", "What's your best price for lunch boxes?", "What else do you have?"], "newest first");
  const anu = suggestionsFor("Anu Sharma", []).map(s => s.text);
  assert.deepEqual(anu, ["What are you looking for right now?", "Are you free this weekend?", "What do you do, Anu?"]);
  assert.ok(!anu.some(t => /stock|price|order|pick/i.test(t)), "no shop questions for a person who sells nothing");
  const sold = offer("s", "goods", "Sold cycle"); sold.offer!.status = "sold";
  assert.equal(suggestionsFor("Raj", [sold])[0].text, "What are you looking for right now?", "sold listings aren't suggested");
  const priv = offer("p", "goods", "Secret stash"); priv.tier = "private";
  assert.equal(suggestionsFor("Raj", [priv])[0].text, "What are you looking for right now?", "only Public offerings are read");
});

const paidDeal = (category: string, status: "paid" | "outside" | "awaiting", by: "requester" | "provider" = "requester"): Engagement => ({
  id: "e1", phase: "agreed", seller: "provider", offer: { title: "Thing", category, price: 100, unit: null }, negotiation: { deal: { price: 100 }, requester: [], provider: [] },
  requester: { uid: "buyer", handle: "buyer", name: "Buyer" }, provider: { uid: "shop", handle: "shop", name: "Shop" }, brief: { currency: "INR" },
  payment: { status, by, paidAt: 5, cart: status === "paid" ? { total: { value: 100, currency: "INR" } } : undefined },
} as unknown as Engagement);

test("every paid deal gets a pass named for what changes hands; paid outside the app says who marked it", () => {
  assert.equal(passKind(paidDeal("goods", "paid")), "pickup");
  assert.equal(passKind(paidDeal("lessons", "paid")), "booking");
  assert.equal(passKind(paidDeal("property-rent", "paid")), "handover");
  const slot = paidDeal("goods", "paid"); slot.reservation = { slotId: "s1", slot: { start: 100, end: 200 } } as any;
  assert.equal(passKind(slot), "booking", "a reserved time slot is a booking whatever the category");
  assert.equal(pickupDetails(slot).slot, 100);
  assert.equal(pickupDetails(paidDeal("goods", "paid")).payment, "in_app_test");
  const cash = pickupDetails(paidDeal("goods", "outside", "requester"));
  assert.equal(cash.payment, "outside"); assert.equal(cash.markedBy, "buyer"); assert.deepEqual(cash.amount, { value: 100, currency: "INR" });
  assert.equal(pickupDetails(paidDeal("goods", "outside", "provider")).markedBy, "seller");
  assert.throws(() => pickupDetails(paidDeal("goods", "awaiting")), /isn't paid/);
});

test("fair-price sources are labelled without repeating their price", () => {
  assert.equal(cleanLabel("thanish Premium Stainless Steel Water Bottle 500 ml new costs INR 499 per item"), "Thanish Premium Stainless Steel Water Bottle 500 ml new");
  assert.equal(cleanLabel("Borosil Trek 500 ml is priced at ₹760."), "Borosil Trek 500 ml");
  assert.equal(cleanLabel("Milton bottle — Rs. 1,026 per item"), "Milton bottle");
  assert.equal(cleanLabel("Milton bottle 1L"), "Milton bottle 1L", "nothing to strip");
});

test("App Check: writes and model-running reads need it; plain reads don't wait for it", () => {
  assert.equal(appCheckRequired("POST", "/me"), true);
  assert.equal(appCheckRequired("POST", "/engagements/x/pay"), true);
  assert.equal(appCheckRequired("GET", "/goals"), true);
  assert.equal(appCheckRequired("GET", "/goals/abc"), true);
  assert.equal(appCheckRequired("GET", "/me"), false);
  assert.equal(appCheckRequired("GET", "/people/bottle-store"), false);
  assert.equal(appCheckRequired("GET", "/goalsx"), false);
});
