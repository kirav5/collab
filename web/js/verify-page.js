import { verifyReceiptBundle } from './verify-receipt.js';
try {
  const [id, code] = location.hash.slice(1).split('.');
  const response = await fetch(`/public/receipts/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  const r = await response.json();
  if (!response.ok) throw new Error(r.error);
  const keyResponse = await fetch('/public/keys', { cache: 'no-store' });
  if (!keyResponse.ok) throw new Error('Could not load Collab public keys.');
  const { keys } = await keyResponse.json();
  // Every published key is tried (the current one and any retired by rotation); the record names which it used.
  const candidates = keys.filter(k => k.kty === 'OKP' && k.crv === 'Ed25519');
  if (!candidates.length) throw new Error('Collab has published no verification keys.');
  let result = null;
  for (const key of candidates) { const r2 = await verifyReceiptBundle(r, key); if (!result || r2.receipt) result = r2; if (r2.receipt) break; }
  document.querySelector('#status').textContent = result.receipt ? '✓ Receipt signature verified in this browser' : 'Verification failed';
  document.querySelector('#details').textContent = `${r.terms.title}\nINR ${r.terms.price}\n${r.parties.requester.name} ↔ ${r.parties.provider.name}\nCart signature: ${result.cart === true ? 'valid' : result.cart === null ? 'none' : 'invalid or legacy HMAC'}\nPayment signature: ${result.payment === true ? 'valid · TEST MODE' : result.payment === null ? 'none' : 'invalid or legacy HMAC'}${result.ap2 ? `\nAP2 v0.2 checkout (seller agent): ${result.ap2.merchant ? 'valid' : 'invalid'}\nAP2 v0.2 mandates (buyer agent): ${result.ap2.mandates ? 'valid' : 'invalid'}\nInstrument: ${r.payment.ap2.instrument.type === 'google_pay' ? `Google Pay TEST · ${r.payment.ap2.instrument.description ?? ''}` : 'test'}` : ''}${r.legacyAttestation ? '\nLegacy agreement: receipt attested on export.' : ''}`;
  const a = document.querySelector('#download');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })); a.download = `collab-${id}.json`; a.hidden = false;
} catch (e) { document.querySelector('#status').textContent = e.message; }
