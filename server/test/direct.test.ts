import assert from "node:assert/strict";
import { test } from "node:test";
import { dealItem, offeredPrice } from "../src/core/direct.ts";

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
