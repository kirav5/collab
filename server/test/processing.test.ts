// Where private-note questions are answered (TP-14), Gemma only by default: on this device, else on another of the
// person's own devices, and the cloud only if they chose it. "Device only" never leaves the device; when nothing
// allowed can answer, the owner is told and no request is made. Plus the answer check and the encryption between devices.
import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-ignore browser modules, pure functions
import { LIMITATION, checkedAnswer, decideProcessing, limitation, normalizeMode } from "../../web/js/processing.js";
// @ts-ignore browser module (WebCrypto, available in Node)
import { deviceKeys, open, openReply, publicJwk, seal, sealReply } from "../../web/js/e2e.js";

test("Gemma here first; then the person's other devices; the cloud only when chosen", () => {
  for (const mode of ["device-only", "my-devices", "cloud"]) assert.equal(decideProcessing(mode, { here: true, remote: true }), "here", mode);
  assert.equal(decideProcessing("device-only", { here: false, remote: true }), "limitation", "device only never asks another device");
  assert.equal(decideProcessing("my-devices", { here: false, remote: true }), "remote");
  assert.equal(decideProcessing("my-devices", { here: false, remote: false }), "limitation", "never the cloud");
  assert.equal(decideProcessing("cloud", { here: false, remote: true }), "remote", "own devices before the cloud");
  assert.equal(decideProcessing("cloud", { here: false, remote: false }), "cloud");
  assert.equal(normalizeMode("device-first"), "my-devices", "the old cloud-fallback choice becomes Gemma only");
  assert.equal(normalizeMode(null), "my-devices"); assert.equal(normalizeMode("cloud"), "cloud");
  assert.match(LIMITATION, /this device only/);
  assert.match(limitation("my-devices"), /Nothing was sent anywhere/);
  assert.match(limitation("my-devices", { offline: true }), /offline/i);
  assert.match(limitation("my-devices", { canRunHere: false }), /laptop or desktop/);
});

test("a model's answer counts only if its evidence is quoted from the notes and it invents no numbers", () => {
  const notes = [{ text: "The gate code is 4471 and the guard leaves at 9 pm." }];
  assert.deepEqual(checkedAnswer('```json\n{"answer":"It is 4471.","evidence":["gate code is 4471"]}\n```', notes), { text: "It is 4471.", evidence: ["gate code is 4471"] });
  assert.equal(checkedAnswer('{"answer":"It is 4472.","evidence":["gate code is 4471"]}', notes), null, "a number not in the notes");
  assert.equal(checkedAnswer('{"answer":"It is 4471.","evidence":["the code is 4471"]}', notes), null, "evidence not quoted");
  assert.equal(checkedAnswer('{"answer":null}', notes), null);
  assert.equal(checkedAnswer("I think it's 4471", notes), null, "not JSON");
});

test("questions between a person's devices are readable only by the device they're sealed to, for that job", async () => {
  const laptop = await deviceKeys(), stranger = await deviceKeys();
  const { envelope, key } = await seal(await publicJwk(laptop), "job1", { question: "What's my gate code?", notes: [{ text: "Gate code 4471" }] });
  assert.ok(!JSON.stringify(envelope).includes("4471") && !JSON.stringify(envelope).includes("gate"), "only ciphertext is stored");
  const opened = await open(laptop.privateKey, "job1", envelope);
  assert.equal(opened.payload.question, "What's my gate code?");
  await assert.rejects(open(stranger.privateKey, "job1", envelope), "another key can't open it");
  await assert.rejects(open(laptop.privateKey, "job2", envelope), "bound to its job: moved to another job, it doesn't open");
  const reply = await sealReply(opened.key, "job1", { text: "4471", evidence: ["Gate code 4471"] });
  assert.deepEqual(await openReply(key, "job1", reply), { text: "4471", evidence: ["Gate code 4471"] }, "the asking device reads the answer");
  await assert.rejects(openReply(key, "job2", reply));
  assert.deepEqual(Object.keys(await publicJwk(laptop)).sort(), ["crv", "kty", "x", "y"], "only the public half is shared");
});
