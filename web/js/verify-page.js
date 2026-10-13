import { verifyReceiptBundle } from './verify-receipt.js';
try {
  const [id, code] = location.hash.slice(1).split('.');
  const response = await fetch(`/public/receipts/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  const r = await response.json();
  if (!response.ok) throw new Error(r.error);
  const result = await verifyReceiptBundle(r);
  document.querySelector('#status').textContent = result.receipt ? '✓ Receipt signature verified in this browser' : 'Verification failed';
  document.querySelector('#details').textContent = `${r.terms.title}\nINR ${r.terms.price}\n${r.parties.requester.name} ↔ ${r.parties.provider.name}\nCart signature: ${result.cart === true ? 'valid' : result.cart === null ? 'none' : 'invalid or legacy HMAC'}\nPayment signature: ${result.payment === true ? 'valid · TEST MODE' : result.payment === null ? 'none' : 'invalid or legacy HMAC'}${r.legacyAttestation ? '\nLegacy agreement: receipt attested on export.' : ''}`;
  const a = document.querySelector('#download');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })); a.download = `collab-${id}.json`; a.hidden = false;
} catch (e) { document.querySelector('#status').textContent = e.message; }
