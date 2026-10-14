// Key ids are RFC 7638 thumbprints (the same on every runtime); records labelled with an older id of the same key
// still verify; keys retired by rotation keep verifying what they signed, and sign nothing new.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, createPublicKey, sign } from "node:crypto";
import { legacyKids, signer, thumbprint, verifySignature } from "../src/core/signatures.ts";

test("the key id doesn't depend on JSON property order; older labels are aliases of the same key", () => {
  const s = signer(undefined, true);
  const jwk = createPublicKey(s.privateKey).export({ format: "jwk" }) as any;
  const sorted = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("hex").slice(0, 24);
  assert.equal(s.kid, sorted);
  assert.equal(thumbprint({ x: jwk.x, kty: jwk.kty, crv: jwk.crv }), s.kid, "order of the input doesn't matter");
  const runtimeOrder = createHash("sha256").update(JSON.stringify({ crv: jwk.crv, x: jwk.x, kty: jwk.kty })).digest("hex").slice(0, 24);
  assert.ok(legacyKids(jwk).includes(runtimeOrder), "the label an older runtime produced is an alias");
  assert.ok(!legacyKids(jwk).includes(s.kid));
  assert.deepEqual(s.publicKey.aliases, legacyKids(jwk));
});

test("a record labelled with a legacy id verifies; a wrong key or label doesn't", () => {
  const s = signer(undefined, true);
  const sig = s.sign("u1", "h1");
  assert.equal(s.verify("u1", "h1", sig), true);
  // The same signature with the payload's kid rewritten to a legacy label (what an older server wrote).
  const [prefix, payload, bytes] = sig.split(".");
  const p = JSON.parse(Buffer.from(payload, "base64url").toString());
  const legacy = { ...p, kid: s.publicKey.aliases[0] };
  // Signing the relabelled payload needs the private key; emulate what the old server did by signing it now.
  const relabelled = `${prefix}.${Buffer.from(JSON.stringify(legacy)).toString("base64url")}.${sign(null, Buffer.from(Buffer.from(JSON.stringify(legacy)).toString("base64url")), s.privateKey).toString("base64url")}`;
  assert.equal(verifySignature(s.publicKey, s.subject("u1"), "h1", relabelled), true);
  const foreign = { ...p, kid: "000000000000000000000000" };
  const mislabelled = `${prefix}.${Buffer.from(JSON.stringify(foreign)).toString("base64url")}.${bytes}`;
  assert.equal(s.verify("u1", "h1", mislabelled), false);
  assert.equal(signer(undefined, true).verify("u1", "h1", sig), false, "another key");
});

test("a retired key keeps verifying its records and signs nothing new", () => {
  const old = signer(undefined, true);
  const sig = old.sign("u1", "h1");
  const oldPub = createPublicKey(old.privateKey).export({ format: "jwk" });
  const next = signer(undefined, true, [oldPub]);
  assert.equal(next.keys.length, 2);
  assert.equal(next.verify("u1", "h1", sig), true);
  assert.equal(next.knows(old.kid), true);
  const fresh = next.sign("u1", "h2");
  assert.equal(JSON.parse(Buffer.from(fresh.split(".")[1], "base64url").toString()).kid, next.kid, "new records use the current key");
});
