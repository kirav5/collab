// "Tell your agent in your own words": instructions read into rules the engine enforces — every number one the owner
// wrote, limits that make sense together, and what can't be enforced said back rather than dropped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkRules, readRulesPlain, restates, rulesLines, RulesTask } from "../src/core/rules.ts";

const SELLER = "Don't go below ₹400 a lamp, max 10 per buyer, pickups only on weekdays after 5 pm, and close deals yourself above ₹420";

test("a seller's sentence becomes a floor, a close-at price, a per-buyer cap and a public pickup term", () => {
  const ctx = { side: "seller" as const, price: 450 };
  const r = checkRules(readRulesPlain(SELLER, ctx), SELLER, ctx)!;
  assert.equal(r.floor, 400); assert.equal(r.closeAt, 420); assert.equal(r.maxPerBuyer, 10); assert.equal(r.autonomy, "close");
  assert.deepEqual(r.terms.map(t => t.label), ["Pickup"]);
  const lines = rulesLines(r);
  assert.ok(lines.find(l => /Lowest price: ₹400/.test(l.text))?.private, "the floor is private");
  assert.ok(lines.find(l => /at ₹420 or more; between ₹400 and ₹419 you give the final yes/.test(l.text)));
  assert.equal(lines.find(l => /Most per person: 10/.test(l.text))?.private, false, "buyers are told the cap");
});

test("a buyer's sentence becomes a limit and a must-be-yes question", () => {
  const t = "Up to ₹3,200 for the table, only if I can pick it up this weekend", ctx = { side: "buyer" as const };
  const r = checkRules(readRulesPlain(t, ctx), t, ctx)!;
  assert.equal(r.limit, 3200); assert.deepEqual(r.mustAsk, ["Can I pick it up this weekend?"]); assert.equal(r.autonomy, "negotiate");
});

test("numbers the owner didn't write are dropped; limits that contradict each other are dropped; nothing usable is null", () => {
  const ctx = { side: "seller" as const, price: 450 };
  const invented = RulesTask.parse({ floor: 380, closeAt: 420, maxPerBuyer: 10, autonomy: "close", terms: [], mustAsk: [], unsupported: [] }, { text: "close yourself above ₹420", ctx })!;
  const r = checkRules(invented, "close yourself above ₹420", ctx)!;
  assert.equal(r.floor, null, "380 was never said"); assert.equal(r.maxPerBuyer, null); assert.equal(r.closeAt, 420);
  assert.equal(checkRules({ ...invented, floor: 500 }, "never below 500", ctx)?.floor ?? null, null, "a lowest price above the listed one isn't one");
  const b = { side: "buyer" as const };
  const both = RulesTask.parse({ limit: 300, closeAt: 350, autonomy: "close" }, { text: "up to 300, close below 350", ctx: b })!;
  assert.equal(checkRules(both, "up to 300, close below 350", b)?.closeAt ?? null, null, "close-at above the limit is dropped");
  assert.equal(checkRules(readRulesPlain("be nice", b), "be nice", b), null);
  const odd = RulesTask.parse({ unsupported: ["only nice buyers"] }, { text: "only nice buyers", ctx })!;
  assert.deepEqual(rulesLines(checkRules(odd, "only nice buyers", ctx)!).at(-1), { text: "Can't follow this one: only nice buyers", private: true });
});

test("a model that misses an explicit rule is backed by the plain reading; both only keep numbers the owner wrote", async () => {
  const { readRules } = await import("../src/core/rules.ts");
  const words = "Never below ₹3,000, max 2 per buyer, pickups only on weekends, and close deals yourself above ₹3,300";
  const missing: any = { name: "t", complete: async () => JSON.stringify({ floor: 3000, closeAt: null, autonomy: "negotiate", maxPerBuyer: null, terms: [{ label: "Pickup Time", text: "Pickups are only available on weekends." }], mustAsk: [], unsupported: [] }) };
  const { rules, byModel } = await readRules(missing, words, { side: "seller", price: 3500 });
  assert.equal(byModel, true);
  assert.equal(rules.floor, 3000); assert.equal(rules.closeAt, 3300); assert.equal(rules.maxPerBuyer, 2); assert.equal(rules.autonomy, "close");
  assert.equal(rules.terms.length, 1, "the same pickup term isn't added twice");
});

test("what became a term isn't also listed as something the agent can't follow", async () => {
  const { checkRules } = await import("../src/core/rules.ts");
  const words = "Never below ₹3,000, pickups only on weekends";
  const r = checkRules({ side: "seller", floor: 3000, limit: null, closeAt: null, autonomy: "negotiate", maxPerBuyer: null, quantity: null,
    terms: [{ label: "Pickup", text: "Pickups only on weekends." }], mustAsk: [], lookups: [], pricing: [], unsupported: ["pickups only on weekends", "only nice buyers"] }, words, { side: "seller", price: 3500 })!;
  assert.deepEqual(r.unsupported, ["only nice buyers"]);
});

test("web lookups and the owner's own percentages are rules the agent follows, not 'can't follow'", async () => {
  const { checkRules, readRulesPlain, rulesLines } = await import("../src/core/rules.ts");
  const words = `My always-on agent negotiates inside my limit; I confirm the deal.
look for price over internet - look for replacable part cost over internet - look for relacement service cost over internet
i'll go 25% cheaper if within manufacturer guarantee
repair cost also looked up over internet, and 25% markup over that service
this, sold as insurance for 12.5% price`;
  const r = checkRules(readRulesPlain(words, { side: "seller", price: 9245 }), words, { side: "seller", price: 9245 })!;
  assert.deepEqual(r.lookups, ["new price", "part cost", "repair cost"]);
  assert.deepEqual(r.pricing.map(p => [p.basis, p.how, p.percent]), [["new price", "off", 25], ["repair cost", "over", 25], ["price", "of", 12.5]]);
  assert.equal(r.pricing[0].when, "within manufacturer guarantee");
  assert.deepEqual(r.unsupported, []);
  const lines = rulesLines(r).map(l => l.text);
  assert.ok(lines.includes("Price: 25% under the new price, when within manufacturer guarantee"));
  assert.ok(lines.includes("Insurance: 12.5% of the price"));
  // A percentage the owner never wrote is dropped.
  const made = checkRules({ ...r, pricing: [{ label: "Price", basis: "new price", percent: 40, how: "off", when: null }] }, words, { side: "seller", price: 9245 })!;
  assert.deepEqual(made.pricing, []);
});

test("'negotiates inside my limit; I confirm the deal' is how the agent bargains, not something it can't follow", async () => {
  const { checkRules } = await import("../src/core/rules.ts");
  const words = "My always-on agent negotiates inside my limit; I confirm the deal. Never below ₹8,000.";
  const r = checkRules({ side: "seller", floor: 8000, limit: null, closeAt: null, autonomy: "negotiate", maxPerBuyer: null, quantity: null, terms: [], mustAsk: [], lookups: [], pricing: [],
    unsupported: ["My always-on agent negotiates inside my limit; I confirm the deal", "Owner confirms deal", "Listed at 9245 (no floor/limit explicitly specified)"] }, words, { side: "seller", price: 9245 })!;
  assert.deepEqual(r.unsupported, []);
});

// The case from 18 Oct: rules that span lines and say "12.5% price" must not yield a "5% price" Returns term, and a term
// that only repeats the seller's own wording must not replace the term they wrote.
const OWN_TERMS = [
  { label: "Returns", text: "No returns or refunds once the items are inspected and handed over.\n\nseller may choose to assist buyer" },
  { label: "Warranty", text: "Sold as-is with no warranty unless covered under an existing manufacturer guarantee." },
  { label: "Inspection", text: "Check and test all appliances and devices on the spot before making payment." },
];
const WEB_RULES = "look for price over internet - look for replacable part cost over internet\n"
  + "Check and test all appliances and devices on the spot before making payment.\n"
  + "i'll go 25% cheaper if within manufacturer guarantee.\nthis, sold as insurance for 12.5% price\n"
  + "No returns or refunds once the items are inspected and handed over.";

test("a decimal percentage isn't split into a new term, and a new line ends a clause", () => {
  const ctx = { side: "seller" as const, price: 9245 };
  const r = checkRules(readRulesPlain(WEB_RULES, ctx), WEB_RULES, ctx)!;
  assert.ok(!r.terms.some(t => /(^|[^.\d])5% price/.test(t.text)), JSON.stringify(r.terms));
  assert.equal(r.terms.find(t => t.label === "Returns")?.text, "No returns or refunds once the items are inspected and handed over.");
  assert.ok(!r.terms.some(t => /look for price over internet/i.test(t.text)), "a web lookup isn't a payment term");
  assert.ok(r.pricing.some(p => p.label === "Insurance" && p.percent === 12.5));
});

test("terms that only repeat the owner's own are recognised, so theirs are kept", () => {
  assert.ok(restates({ label: "Returns", text: "No returns or refunds once the items are inspected and handed over." }, OWN_TERMS));
  assert.ok(restates({ label: "Payment", text: "Check and test all appliances and devices on the spot before making payment." }, OWN_TERMS));
  assert.ok(!restates({ label: "Warranty", text: "Six months' warranty on the screen and battery." }, OWN_TERMS), "a new term still replaces");
});
