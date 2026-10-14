// Capability discovery (TP-03): built from domain data, versioned, and an unsupported request gets a structured
// refusal listing what is supported.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capabilities, unsupported } from "../src/core/capabilities.ts";
import { DOMAINS } from "../src/market/domains.ts";

test("every domain is a capability, plus information; each has a version and actions", () => {
  const all = capabilities();
  assert.equal(all.length, DOMAINS.length + 1);
  assert.ok(all.every(c => c.id.startsWith("collab.") && c.version && c.actions.length));
  const goods = all.find(c => c.id === "collab.goods")!;
  assert.ok(goods.actions.includes("pay.test") && goods.pricing!.currencies.includes("INR"));
  assert.deepEqual(all.find(c => c.id === "collab.information")!.actions, ["ask", "answer"]);
});

test("supported, unsupported and wrong-version requests", () => {
  assert.equal(unsupported(undefined), null);
  assert.equal(unsupported({ id: "collab.goods" }), null);
  assert.equal(unsupported({ id: "collab.goods", version: "1" }), null);
  const v = unsupported({ id: "collab.goods", version: "7" })!;
  assert.equal(v.code, "UNSUPPORTED_CAPABILITY"); assert.deepEqual(v.supported, [{ id: "collab.goods", versions: ["1"] }]);
  const u = unsupported({ id: "collab.teleportation" })!;
  assert.ok(u.supported.length > 10, "lists everything supported");
});
