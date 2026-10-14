// Where private-note questions are processed (TP-14): "device only" never falls back to the cloud — when the device
// can't answer, the owner gets a limitation, and no request is made.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore browser module, pure function
import { LIMITATION, decideProcessing } from "../../web/js/processing.js";

test("device-only never reaches the cloud; device-first falls back; cloud is cloud", () => {
  assert.equal(decideProcessing("device-only", "available"), "device");
  assert.equal(decideProcessing("device-only", "downloadable"), "limitation");
  assert.equal(decideProcessing("device-only", "unsupported"), "limitation");
  assert.equal(decideProcessing("device-only", "available", true), "limitation", "a device error is not a reason to send notes to the cloud");
  assert.equal(decideProcessing("device-first", "available"), "device");
  assert.equal(decideProcessing("device-first", "downloadable"), "cloud");
  assert.equal(decideProcessing("device-first", "available", true), "cloud");
  assert.equal(decideProcessing("cloud", "available"), "cloud");
  assert.match(LIMITATION, /this device only/);
});
