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
