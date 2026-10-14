import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signer, verifySignature } from '../src/core/signatures.ts';
import { memoryDocs } from '../src/docs.ts';
import { checkPrice, priceEvidence, reserveCheck } from '../src/core/price-check.ts';

test('Ed25519 verification needs only the public key and binds owner, hash and key id', () => {
  const s = signer(undefined, true), hash = 'a'.repeat(64), sig = s.sign('alice', hash);
  assert.ok(verifySignature(s.publicKey, s.subject('alice'), hash, sig));
  assert.equal(verifySignature(s.publicKey, s.subject('bob'), hash, sig), false);
  assert.equal(verifySignature(s.publicKey, s.subject('alice'), 'b'.repeat(64), sig), false);
  assert.equal(verifySignature(signer(undefined, true).publicKey, s.subject('alice'), hash, sig), false);
  assert.equal(verifySignature(s.publicKey, s.subject('alice'), hash, 'invalid'), false);
});

test('daily price cap is atomic across concurrent calls, separate by owner and UTC day', async () => {
  const { setPolicy, loadPolicy, DEFAULT_POLICY } = await import('../src/config/policy.ts');
  setPolicy(loadPolicy({ POLICY_JSON: JSON.stringify({ quotas: { priceChecksPerDay: 5 } }) }));
  const db = memoryDocs(), t = Date.UTC(2026, 9, 14) / 1000;
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => reserveCheck(db, 'one', t)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 5);
  assert.equal(await reserveCheck(db, 'two', t), 4);
  assert.equal(await reserveCheck(db, 'one', t + 86400), 4);
  setPolicy(DEFAULT_POLICY);
  assert.equal(await reserveCheck(db, 'one', t), null, 'no cap: nothing is counted');
});

test('price evidence rejects unsupported numbers, ungrounded links, incompatible units and stores privately', async () => {
  const items = [{ label: 'Steel bottle A 1L new', price: 400, unit: 'each' }, { label: 'Steel bottle B 1L new', price: 500, unit: 'each' }];
  const g = { text: JSON.stringify({ items }), sources: [{ title: 'Shop', url: 'https://example.com/bottles' }], supports: items.map(i => ({ text: JSON.stringify(i), indices: [0] })), searchEntryPoint: '' };
  const r = priceEvidence(g); assert.equal(r.typical, 450); assert.equal(r.status, 'evidence');
  assert.equal(priceEvidence({ ...g, supports: [] }).status, 'insufficient_evidence');
  assert.equal(priceEvidence({ ...g, sources: [{ title: 'bad', url: 'javascript:alert(1)' }] }).status, 'insufficient_evidence');
  const changed = structuredClone(g); changed.text = changed.text.replace('500', '900');
  assert.equal(priceEvidence(changed).high, null);
  const db = memoryDocs();
  await checkPrice(db, { name: 'fixture', complete: async () => null, grounded: async () => g }, 'alice', 'steel bottle', 'India', 100);
  assert.ok(await db.get('price_checks', 'alice')); assert.equal(await db.get('price_checks', 'bob'), null);
  assert.equal((await db.find('engagements', [])).length, 0);
});
