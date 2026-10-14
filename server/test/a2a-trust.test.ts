// A2A trust: agent cards are signed (JWS over the JCS-canonical card) and verify with the published key only;
// push webhooks can't point at private or internal addresses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { AgentCard, generateAgentCardSignature, verifyAgentCardSignature } from "@a2a-js/sdk";
import { signer } from "../src/core/signatures.ts";
import { safeWebhook } from "../src/a2a/agents.ts";

const card = () => AgentCard.fromJSON({ name: "Shop's agent (@shop)", description: "Test", version: "1.0.0",
  supportedInterfaces: [{ url: "https://example.com/a2a/shop", protocolBinding: "JSONRPC", protocolVersion: "1.0" }],
  capabilities: { streaming: true, pushNotifications: true }, defaultInputModes: ["text/plain"], defaultOutputModes: ["text/plain"], skills: [] });

test("a signed agent card verifies with the published key and fails when changed", async () => {
  const s = signer(undefined, true);
  const signed = await generateAgentCardSignature(s.privateKey, { alg: "EdDSA", kid: s.kid, typ: "JOSE", jku: "https://example.com/public/keys" })(card());
  assert.equal(signed.signatures.length, 1);
  const verify = verifyAgentCardSignature(async kid => { assert.equal(kid, s.kid); return s.publicKey as any; });
  await verify(signed);
  const wire = AgentCard.toJSON(signed) as any;
  wire.name = "Someone else's agent";
  await assert.rejects(verify(AgentCard.fromJSON(wire)));
  const other = signer(undefined, true);
  await assert.rejects(verifyAgentCardSignature(async () => other.publicKey as any)(signed));
});

test("push webhooks must be public https URLs", () => {
  assert.equal(safeWebhook("https://agents.example.com/hooks/collab"), true);
  for (const bad of ["http://agents.example.com/hook", "https://localhost/hook", "https://127.0.0.1/hook", "https://[::1]/hook",
    "https://10.0.0.4/x", "https://metadata.google.internal/computeMetadata/v1/", "https://intranet/hook", "https://user:pw@example.com/h", "not a url"])
    assert.equal(safeWebhook(bad), false, bad);
});
