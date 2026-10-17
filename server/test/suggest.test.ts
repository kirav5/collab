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

test("a listing's own questions (written by Gemini when it was published) come first", () => {
  const f = offer("q", "beauty", "Haircuts and Beard Trims · Koramangala");
  f.offer!.questions = [{ label: "Next free", text: "Any free time this evening?" }, { label: "Price", text: "Is ₹450 your best price?" }, { label: "Fade", text: "Do you do skin fades?" }];
  assert.deepEqual(forOffer(f, "slots").map(s => s.text), ["Any free time this evening?", "Is ₹450 your best price?", "Do you do skin fades?"]);
});

test("without them, questions come only from the listing's data — what's tracked, how it's bought, its price — never canned wording by category", () => {
  assert.deepEqual(forOffer(offer("f1", "goods", "Water Bottles · items for sale"), "quantity").map(s => s.text), ["Do you have water bottles in stock?", "What's your best price for water bottles?"]);
  assert.equal(forOffer(offer("f2", "lessons", "Guitar lessons"), "slots")[0].text, "What's your next free time for guitar lessons?");
  assert.equal(forOffer(offer("f3", "lessons", "Guitar lessons"), null)[0].text, "When are you free for guitar lessons?", "no times tracked: ask, don't promise a booking");
  assert.equal(forOffer(offer("f4", "goods", "Old cycle", null))[1].text, "How much is old cycle?", "no price listed: ask it");
  assert.equal(forOffer(offer("f5", "property-rent", "2BHK in Indiranagar"))[0].text, "Is 2BHK in Indiranagar still available?");
  const cats = ["property-sale", "property-rent", "wholesale", "freight", "services", "equipment-rental", "commercial-lease", "manufacturing", "rides", "food", "lessons", "tasks", "goods", "vehicles", "stays", "jobs", "events", "pets", "beauty", "other", "unknown-category"];
  for (const c of cats) for (const tracked of [null, "quantity", "slots"] as const) {
    const s = forOffer(offer("x", c, "Thing"), tracked);
    assert.equal(new Set(s.map(x => x.text)).size, s.length, `${c}: distinct`);
    for (const x of s) {
      assert.match(x.text, /\bthing\b/i, `${c}: about the listing itself — "${x.text}"`);
      assert.ok(!/\b(RC|insurance|GST|deposit|trial|home visits?|salary|fare|operator|papers|cancellation)\b/i.test(x.text), `${c}: "${x.text}" is category wording`);
    }
  }
  assert.equal(kindOf("unknown-category"), "other");
});

test("several offerings: the first two, a price, and what else; a person with nothing on offer is asked about themselves", () => {
  const two = suggestionsFor("Shop", [offer("a", "goods", "Steel bottles", 400, 5), offer("b", "goods", "Lunch boxes", 300, 9)]);
  assert.deepEqual(two.map(s => s.text), ["Can I get lunch boxes now?", "Can I get steel bottles now?", "What's your best price for lunch boxes?", "What else do you have?"], "newest first");
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

test("fair prices for services are read per hour (or night, order…), not per item", async () => {
  const { priceEvidence, priceUnit } = await import("../src/core/price-check.ts");
  assert.equal(priceUnit("hour"), "hour"); assert.equal(priceUnit("each"), "item"); assert.equal(priceUnit("<script>"), "item"); assert.equal(priceUnit(undefined), "item");
  const s1 = "Rhythm School guitar classes for beginners costs INR 700 per hour.", s2 = "Jayanagar Music Academy guitar lessons costs INR 900 per hour.";
  const g = { text: `${s1} ${s2}`, sources: [{ title: "a", url: "https://a.example" }, { title: "b", url: "https://b.example" }],
    supports: [{ text: s1, indices: [0] }, { text: s2, indices: [1] }], searchEntryPoint: "" };
  const r = priceEvidence(g, "hour");
  assert.equal(r.status, "evidence"); assert.equal(r.unit, "hour"); assert.equal(r.low, 700); assert.equal(r.high, 900);
  assert.equal(r.items[0].label, "Rhythm School guitar classes for beginners");
  assert.equal(priceEvidence(g, "item").status, "insufficient_evidence", "per-hour prices aren't read as per item");
});

test("a salon or barber's deals get a booking pass; titles keep brand capitals and small words", async () => {
  assert.equal(passKind(paidDeal("beauty", "paid")), "booking");
  const { titleCase } = await import("../src/market/read.ts");
  assert.equal(titleCase("haircuts and beard trims"), "Haircuts and Beard Trims");
  assert.equal(titleCase("old iPhone 13 pro max"), "Old iPhone 13 Pro Max", "a word with its own capitals keeps them");
});

test("buyer questions from Gemini are kept only when they're questions without contact details", async () => {
  const { BuyerQuestionsTask } = await import("../src/core/intake.ts");
  const i = { item: "haircuts", title: "Haircuts", text: "Haircuts at my studio", attributes: {}, price: "₹450", action: "book a time", owner: "stylist", responder: "client", priceWord: "price" };
  assert.equal(BuyerQuestionsTask.validate([{ label: "Free", text: "Any free time today?" }, { label: "Phone", text: "What's your phone number?" }], i), null, "one real question isn't enough");
  assert.equal(BuyerQuestionsTask.validate([{ label: "Free", text: "Any free time today?" }, { label: "Price", text: "Is ₹450 your best price?" }, { label: "Fade", text: "Do you do fades" }], i)?.length, 2, "not a question: dropped");
  assert.deepEqual(BuyerQuestionsTask.fallback(i), [], "no canned questions");
});

test("suggested terms are short, carry no contact details or invented amounts, and fall back by kind of offering", async () => {
  const { TermsTask } = await import("../src/core/terms.ts");
  const input = { category: "beauty", offering: "Men's haircut at our studio, ₹450 a session, home visits ₹200 extra.", owner: "stylist", audience: "clients" };
  const ok = TermsTask.validate({ terms: [{ label: "Late arrival", text: "Your slot is held for 10 minutes." }, { label: "Home visits", text: "Home visits cost ₹200 extra within 5 km." }] }, input);
  assert.equal(ok?.terms.length, 2, "an amount the offering states is fine");
  assert.equal(TermsTask.validate({ terms: [{ label: "Cancellation", text: "Cancel late and pay ₹999 as a fee." }, { label: "Contact", text: "Call 98765 43210 to reschedule." }] }, input), null, "invented amounts and phone numbers are dropped");
  assert.deepEqual(TermsTask.fallback(input).terms, [], "no canned terms: without the model the seller writes their own")
});

test("time questions are recognised (so a seller with bookable slots doesn't ask them)", async () => {
  const { isTimeQuestion } = await import("../src/core/engage.ts");
  for (const q of ["What time suits you?", "When would you like to come in?", "Which day works for you?", "What's your preferred time?"]) assert.equal(isTimeQuestion(q), true, q);
  for (const q of ["Which style would you like?", "Any reference photo?", "How long is your hair now?"]) assert.equal(isTimeQuestion(q), false, q);
});

test("terms suggested from the web keep their sources, and go through the same checks", async () => {
  const { termsFromSearch, suggestTerms } = await import("../src/core/terms.ts");
  const g = { text: "**Warranty:** One year manufacturer warranty on the LED and the arm.\n- Returns: Unused lamps can be returned within 7 days in original packaging.\nCall: 98765 43210 to reschedule.\nsome prose without a label",
    sources: [{ title: "Brand warranty page", url: "https://brand.example/warranty" }, { title: "Shop returns", url: "https://shop.example/returns" }],
    supports: [{ text: "One year manufacturer warranty on the LED and the arm.", indices: [0] }, { text: "Unused lamps can be returned within 7 days", indices: [1] }], searchEntryPoint: "" };
  const found = termsFromSearch(g);
  assert.deepEqual(found.slice(0, 2).map(t => [t.label, t.sources[0]?.url]), [["Warranty", "https://brand.example/warranty"], ["Returns", "https://shop.example/returns"]]);
  // With a model that searches: the contact line is dropped; sources come back with the terms.
  const model: any = { name: "t", complete: async () => null, search: async () => g };
  const r = await suggestTerms(model, "goods", "Brass desk lamps, ₹450 each");
  assert.equal(r.grounded, true);
  assert.deepEqual(r.terms.map(t => t.label), ["Warranty", "Returns"]);
  assert.ok(r.terms.every(t => t.sources.length === 1));
  // The common terms for this kind of offering come beside them, to tap in — minus any label already suggested.
  assert.ok(r.starters.length >= 2 && !r.starters.some(t => ["warranty", "returns"].includes(t.label.toLowerCase())));
  const none = await suggestTerms(null, "lessons", "Guitar lessons on weekends");
  assert.deepEqual(none.terms, [], "without the model, nothing is presented as suggested by it");
  assert.ok(none.starters.some(t => t.label === "Cancellation"), "but the seller still has common terms to start from");
});
