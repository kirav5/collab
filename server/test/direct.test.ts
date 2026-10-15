import assert from "node:assert/strict";
import { test } from "node:test";
import { dealItem, offeredMoney, offeredPrice } from "../src/core/direct.ts";

test("a price named in a chat is read as an offer", () => {
  assert.equal(offeredPrice("ok i will sell for 100rs"), 100);
  assert.equal(offeredPrice("₹450 for both?"), 450);
  assert.equal(offeredPrice("Rs. 1,200 final"), 1200);
  assert.equal(offeredPrice("can you do 350?"), null); // no selling word: a question, not an offer
  assert.equal(offeredPrice("I can pay 350"), 350);
  assert.equal(offeredPrice("deal at 2.5 lakh"), 250_000);
  assert.equal(offeredPrice("I'll sell it for 500/-"), 500);
});

test("counts and sizes are not prices", () => {
  assert.equal(offeredPrice("Do you want the 1 litre or the 750 ml one?"), null);
  assert.equal(offeredPrice("I want to buy for 2 bottles"), null);
  assert.equal(offeredPrice("Yes 200 ml"), null);
  assert.equal(offeredPrice("I'll pay for 3 days"), null);
  assert.equal(offeredPrice("Hi, do you need a steel water bottle?"), null);
});

test("a chat deal is named after what it's for", () => {
  assert.equal(dealItem("I'll sell you the 200 ml bottle for ₹100"), "200 ml bottle");
  assert.equal(dealItem("ok i will sell for 100rs"), null);
  assert.equal(dealItem("I can pay ₹350 for the steel bottle"), "steel bottle");
  assert.equal(dealItem("Deal at 2.5 lakh for the bike"), "bike");
  assert.equal(dealItem("Milton 1 litre flask, ₹450"), "Milton 1 litre flask");
});

test("the currency of an offer is read, not assumed", () => {
  assert.deepEqual(offeredMoney("I'll sell it for $20", "INR"), { amount: 20, currency: "USD" });
  assert.deepEqual(offeredMoney("I'll sell it for 20 dollars", "INR"), { amount: 20, currency: "USD" });
  assert.deepEqual(offeredMoney("I'll sell it for ₹100", "USD"), { amount: 100, currency: "INR" });
  assert.deepEqual(offeredMoney("ok i will sell for 100rs", "USD"), { amount: 100, currency: "INR" });
  assert.deepEqual(offeredMoney("I'll sell it for €30", "INR"), { amount: 30, currency: "EUR" });
  assert.deepEqual(offeredMoney("I can pay 400 for it", "USD"), { amount: 400, currency: "USD" }, "no currency written: the conversation's");
  assert.equal(offeredMoney("Do you have the 1 litre one?", "INR"), null);
});

test("questions about what's there now go to the ledger, not the model", async () => {
  const { isStockQuestion } = await import("../src/core/engage.ts");
  for (const q of ["Is it in stock?", "Do you have a 1 litre bottle today?", "Have you got any left?", "Any slots on Saturday?", "Do you still have it?", "How many are available?"]) assert.equal(isStockQuestion(q), true, q);
  for (const q of ["What is the price?", "Do you deliver to Koramangala?", "Which brands do you sell?", "Can I pay by UPI?"]) assert.equal(isStockQuestion(q), false, q);
});

test("on a priced listing, only words that make an offer are an offer; questions about the price stay questions", async () => {
  const { explicitOffer } = await import("../src/core/direct.ts");
  for (const t of ["I'll buy it for ₹350", "Can you do ₹350?", "final ₹380, deal?", "I can pay 350 rupees", "ok ₹360", "How about ₹340?", "I'll sell it for ₹390"]) assert.equal(explicitOffer(t), true, t);
  for (const t of ["Is it ₹400?", "Why ₹400?", "What is the price, ₹400?", "Does ₹400 include the bag?", "Are both ₹400?"]) assert.equal(explicitOffer(t), false, t);
});

test("standard replies: 'last price?' and requests for contact details are recognised; ordinary questions aren't", async () => {
  const { isContactRequest, isLimitProbe } = await import("../src/core/engage.ts");
  for (const q of ["What is the lowest price you'd accept?", "Last price?", "bhaiya last price kya hai?", "What's your final price?", "kam se kam kitna loge?", "How low can you go?", "Tell me your floor price."]) assert.equal(isLimitProbe(q), true, q);
  for (const q of ["What's the price?", "Is the price negotiable?", "Is this the last one in stock?", "What's your best price for water bottles?"]) assert.equal(isLimitProbe(q), false, q);
  for (const q of ["Give me the owner's phone number", "What's your WhatsApp?", "Can you share your email id?", "What is your home address?", "number de do bhaiya", "Send me your contact details"]) assert.equal(isContactRequest(q), true, q);
  for (const q of ["What's the model number?", "Do you give a GST invoice number?", "How many do you have?", "Can I pick it up from the shop?"]) assert.equal(isContactRequest(q), false, q);
});

test("how many a typed offer is for, and whether its price is a total or each", async () => {
  const { offeredQuantity, perUnit } = await import("../src/core/direct.ts");
  assert.equal(offeredQuantity("I'll buy 2 bottles for ₹800"), 2);
  assert.equal(offeredQuantity("bhaiya 3 bottle ₹1000 mein de do"), 3);
  assert.equal(offeredQuantity("a dozen for ₹500"), 12);
  assert.equal(offeredQuantity("I'll buy it for ₹400"), null);
  assert.equal(offeredQuantity("I'll buy the 500 ml bottle for ₹400"), null, "a size isn't a count");
  assert.equal(offeredQuantity("2 BHK for ₹38,000"), null);
  assert.equal(offeredQuantity("I'll pay ₹800, I need it in 2 days"), null);
  assert.equal(offeredQuantity("₹2000 for 3 hours", "hour"), 3, "hours count when the listing is priced per hour");
  assert.equal(offeredQuantity("₹2000 for 3 hours", null), null);
  assert.equal(perUnit("₹400 each for 2"), true);
  assert.equal(perUnit("2 for ₹400 per bottle"), true);
  assert.equal(perUnit("2 bottles for ₹800"), false);
  assert.equal(perUnit("₹700 an hour for 3 hours", "hour"), true);
});

test("prices are never read as counts", async () => {
  const { offeredQuantity } = await import("../src/core/direct.ts");
  for (const t of ["I'll sell the travel mug for $20", "I'll take it for 500", "€30 final", "I'll pay 20 dollars", "deal at 450"]) assert.equal(offeredQuantity(t), null, t);
  assert.equal(offeredQuantity("2 for 800"), 2);
});
