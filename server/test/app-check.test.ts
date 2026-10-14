import assert from "node:assert/strict";
import { test } from "node:test";
import { replayProtected, verifyAppCheckToken } from "../src/core/app-check.ts";

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
