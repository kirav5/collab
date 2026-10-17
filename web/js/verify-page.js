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
  const sellerSide = r.sides?.seller ?? r.payment?.seller ?? 'provider', buyerSide = sellerSide === 'provider' ? 'requester' : 'provider';
  const cap = w => w[0].toUpperCase() + w.slice(1), payer = cap(r.sides?.payer ?? 'buyer'), payee = cap(r.sides?.payee ?? 'seller');
  const owner = sellerSide === 'provider' ? payee : payer;
  const unpaid = !!r.sides?.noPayment, priceWord = r.sides?.price ?? 'price';
  const paid = unpaid ? `By the ${payer.toLowerCase()}, as agreed — not through Collab` : r.payment?.status === 'paid' ? 'Paid in the app (test mode — no money moved)' : r.payment?.status === 'outside' ? 'Paid outside the app (cash or UPI)' : 'Not paid yet';
  const ok = v => (v === true ? 'valid' : v === null || v === undefined ? 'none' : 'invalid');
  document.querySelector('#details').innerHTML = `<dl class="kv">
      <dt>${esc(payer)}</dt><dd>${esc(r.parties[buyerSide].name)} <span class="faint">@${esc(r.parties[buyerSide].handle)}</span></dd>
      <dt>${esc(payee)}</dt><dd>${esc(r.parties[sellerSide].name)} <span class="faint">@${esc(r.parties[sellerSide].handle)}</span></dd>
      <dt>${esc(r.sides?.item ?? 'What')}</dt><dd>${esc(t.title.split(' · ')[0])}${qty > 1 ? ` × ${qty}` : ''}</dd>
      <dt>Agreed ${esc(priceWord)}</dt><dd>${amount(total / qty)}${t.unit && t.unit !== 'each' ? `/${esc(t.unit)}` : ''}${qty > 1 ? ` each · ${amount(total)} in all` : ''}</dd>
      ${unpaid ? '' : `<dt>Platform fee</dt><dd>${amount(0)}</dd>`}
      <dt>Payment</dt><dd>${esc(paid)}</dd>
      <dt>Agreed</dt><dd>${new Date(r.at * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd></dl>
    ${t.offerLetter ? (l => `<p class="small"><b>The offer letter, as accepted</b></p><p class="small">${esc(l.role)} · starts ${esc(l.start)}${l.mode ? ` · ${esc(l.mode)}` : ''}${l.probation ? ` · probation: ${esc(l.probation)}` : ''}${l.notice ? ` · notice period: ${esc(l.notice)}` : ''}${l.note ? ` · “${esc(l.note)}”` : ''}</p>`)(t.offerLetter) : ''}
    ${t.policies?.length ? `<p class="small"><b>${esc(owner)}'s terms, as they stated them</b></p>${t.policies.map(p => `<p class="small"><b>${esc(p.label)}:</b> ${esc(p.text)}</p>`).join('')}` : ''}
    <p class="small muted">Checked in this browser — agreement: ${ok(result.receipt)} · cart: ${ok(result.cart)} · payment: ${ok(result.payment)}${result.ap2 ? ` · AP2 checkout: ${ok(result.ap2.merchant)} · AP2 mandates: ${ok(result.ap2.mandates)}` : ''}${r.legacyAttestation ? ' · older agreement, attested on export' : ''}</p>`;
  const a = document.querySelector('#download');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(r, null, 2)], { type: 'application/json' })); a.download = `collab-${id}.json`; a.hidden = false;
} catch (e) { document.querySelector('#status').textContent = e.message; }
