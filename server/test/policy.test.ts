// Operational policy: defaults, validated overrides, rejected typos and ranges, a stable hash, and the same numbers
// enforced by the server and shown by the app.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_POLICY, PolicyError, loadPolicy, policyHash, setPolicy } from "../src/config/policy.ts";
import { memoryDocs } from "../src/docs.ts";
import { quotaStatus, reserveCheck } from "../src/core/price-check.ts";

test("defaults load; overrides merge; the hash follows the content", () => {
  const d = loadPolicy({});
  assert.deepEqual(d, DEFAULT_POLICY);
  const o = loadPolicy({ POLICY_JSON: JSON.stringify({ quotas: { priceChecksPerDay: 9 }, timing: { checkoutValiditySec: 300 } }) });
  assert.equal(o.quotas.priceChecksPerDay, 9); assert.equal(o.quotas.nearbyPerDay, 0, "no cap by default"); assert.equal(o.timing.checkoutValiditySec, 300);
  assert.notEqual(policyHash(o), policyHash(d));
  assert.equal(policyHash(loadPolicy({})), policyHash(d), "same content, same hash");
  assert.equal(loadPolicy({ GEMINI_GROUNDING_MODEL: "gemini-3.6-flash" }).models.grounding, "gemini-3.6-flash");
  assert.ok(Object.isFrozen(o));
});

test("typos, wrong types, out-of-range values and unknown currencies stop the server", () => {
  const bad = (x: unknown) => assert.throws(() => loadPolicy({ POLICY_JSON: JSON.stringify(x) }), PolicyError, JSON.stringify(x));
  bad({ quotas: { priceCheckPerDay: 5 } });
  bad({ quotas: { priceChecksPerDay: "5" } });
  bad({ quotas: { priceChecksPerDay: 100000 } });
  bad({ timing: { checkoutValiditySec: 5 } });
  bad({ money: { currencies: ["INR", "EUR"] } });
  bad({ money: { defaultCurrency: "USD", currencies: ["INR"] } });
  bad({ admin: true });
  bad({ reports: { warnAt: 0 } });
  bad({ reports: { foo: 1 } });
  assert.throws(() => loadPolicy({ POLICY_JSON: "{not json" }), PolicyError);
});

test("the quota the server enforces is the quota the app is told", async () => {
  setPolicy(loadPolicy({ POLICY_JSON: JSON.stringify({ quotas: { priceChecksPerDay: 2 } }) }));
  const db = memoryDocs(), t = 1_800_000_000;
  assert.equal((await quotaStatus(db, "price-check", "u", 2, t)).remaining, 2);
  assert.equal(await reserveCheck(db, "u", t), 1);
  assert.equal(await reserveCheck(db, "u", t), 0);
  await assert.rejects(reserveCheck(db, "u", t), /All 2 price checks used today/);
  const s = await quotaStatus(db, "price-check", "u", 2, t);
  assert.equal(s.remaining, 0); assert.ok(s.resetsAt > t && s.resetsAt - t <= 86_400);
  setPolicy(DEFAULT_POLICY);
});
