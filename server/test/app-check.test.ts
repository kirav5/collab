import assert from "node:assert/strict";
import { test } from "node:test";
import { appCheckDecision, replayProtected, verifyAppCheckToken } from "../src/core/app-check.ts";

test("only sensitive writes consume App Check tokens", () => {
  assert.equal(replayProtected("POST", "/price-check"), true);
  assert.equal(replayProtected("POST", "/engagements/deal-1/pay"), true);
  assert.equal(replayProtected("POST", "/pickup/deal-1/collect"), true);
  assert.equal(replayProtected("GET", "/price-check"), false);
  assert.equal(replayProtected("POST", "/engagements/deal-1/paid-outside"), false);
  assert.equal(replayProtected("POST", "/engagements/deal-1/pay/again"), false);
});

test("a consumed limited-use token cannot authorize a second sensitive write", async () => {
  const calls: Array<{ consume: boolean } | undefined> = [];
  let used = false;
  const verify = async (_: string, options?: { consume: boolean }) => {
    calls.push(options);
    if (!options?.consume) return { alreadyConsumed: false };
    const alreadyConsumed = used;
    used = true;
    return { alreadyConsumed };
  };
  assert.equal(await verifyAppCheckToken("token", true, verify), true);
  assert.equal(await verifyAppCheckToken("token", true, verify), false);
  assert.equal(await verifyAppCheckToken("token", false, verify), true);
  assert.deepEqual(calls, [{ consume: true }, { consume: true }, undefined]);
});

test("sensitive actions fail closed when tokens can't be consumed; ordinary calls aren't affected", async () => {
  const noRole = async (_: string, o?: { consume: boolean }) => { if (o?.consume) throw new Error("7 PERMISSION_DENIED: missing firebaseappcheck.appCheckTokens.verify"); return {}; };
  assert.equal(await appCheckDecision("t", true, noRole), "unavailable", "never downgraded to a reusable-token check");
  assert.equal(await appCheckDecision("t", false, noRole), "ok");
  const bad = async () => { throw new Error("invalid token signature"); };
  assert.equal(await appCheckDecision("t", true, bad), "invalid");
  assert.equal(await appCheckDecision(undefined, false, noRole), "invalid");
  let used = false;
  const once = async (_: string, o?: { consume: boolean }) => { const r = { alreadyConsumed: used && !!o?.consume }; if (o?.consume) used = true; return r; };
  assert.deepEqual([await appCheckDecision("t", true, once), await appCheckDecision("t", true, once)], ["ok", "replay"]);
});
