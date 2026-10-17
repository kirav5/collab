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
  let result = null, trusted = null;
  for (const key of candidates) { const r2 = await verifyReceiptBundle(r, key); if (!result || r2.receipt) { result = r2; trusted = key; } if (r2.receipt) break; }
  document.querySelector('#status').textContent = result.receipt ? '✓ Receipt signature verified in this browser' : 'Verification failed';
  // The receipt itself (from the signed record), then what was checked.
  const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = r.terms, cur = t.currency ?? 'INR', qty = t.terms?.quantity > 1 ? t.terms.quantity : 1;
  const amount = n => (cur === 'INR' ? '₹' + Math.round(n).toLocaleString('en-IN') : new Intl.NumberFormat('en-US', { style: 'currency', currency: cur }).format(n));
  const total = r.payment?.cart?.total?.value ?? t.price * qty;
  const sellerSide = r.payment?.seller ?? 'provider', buyerSide = sellerSide === 'provider' ? 'requester' : 'provider';
  const paid = r.payment?.status === 'paid' ? 'Paid in the app' : r.payment?.status === 'outside' ? 'Paid outside the app (cash or UPI)' : 'Not paid yet';
  const ok = v => (v === true ? 'valid' : v === null || v === undefined ? 'none' : 'invalid');
  document.querySelector('#details').innerHTML = `<dl class="kv">
      <dt>For</dt><dd>${esc(r.parties[buyerSide].name)} <span class="faint">@${esc(r.parties[buyerSide].handle)}</span></dd>
      <dt>From</dt><dd>${esc(r.parties[sellerSide].name)} <span class="faint">@${esc(r.parties[sellerSide].handle)}</span></dd>
      <dt>What</dt><dd>${esc(t.title.split(' · ')[0])}${qty > 1 ? ` × ${qty}` : ''}</dd>
      <dt>Agreed price</dt><dd>${amount(total / qty)}${t.unit && t.unit !== 'each' ? `/${esc(t.unit)}` : ''}${qty > 1 ? ` each · ${amount(total)} in all` : ''}</dd>
      <dt>Platform fee</dt><dd>${amount(0)}</dd>
      <dt>Payment</dt><dd>${esc(paid)}</dd>
      <dt>Agreed</dt><dd>${new Date(r.at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></dl>
    ${t.policies?.length ? `<p class="small"><b>Terms, as stated</b></p>${t.policies.map(p => `<p class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</p>`).join('')}` : ''}
    <p class="small muted">Checked in this browser — agreement: ${ok(result.receipt)} · cart: ${ok(result.cart)} · payment: ${ok(result.payment)}${result.ap2 ? ` · AP2 checkout: ${ok(result.ap2.merchant)} · AP2 mandates: ${ok(result.ap2.mandates)}` : ''}${r.legacyAttestation ? ' · older agreement, attested on export' : ''}</p>`;
  // Show the check failing: the same record with the price changed, verified the same way in this browser.
  const tamper = document.querySelector('#tamper'), out = document.querySelector('#tamper-result');
  if (result.receipt && tamper) {
    tamper.hidden = false;
    tamper.onclick = async () => {
      if (out.dataset.on) { out.textContent = ''; delete out.dataset.on; tamper.textContent = 'Try changing the price'; return; }
      const changed = structuredClone(r), lower = Math.max(1, Math.round(t.price * 0.8));
      changed.terms.price = lower;
      const v = await verifyReceiptBundle(changed, trusted);
      out.textContent = v.receipt ? 'Unexpected: the changed receipt verified.' : `✗ With the price changed from ${amount(t.price)} to ${amount(lower)}, the signature no longer matches. The record is refused.`;
      out.style.color = v.receipt ? '' : 'var(--danger)'; out.dataset.on = '1'; tamper.textContent = 'Show the real receipt';
    };
  }
  const a = document.querySelector('#download');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })); a.download = `collab-${id}.json`; a.hidden = false;
} catch (e) { document.querySelector('#status').textContent = e.message; }
