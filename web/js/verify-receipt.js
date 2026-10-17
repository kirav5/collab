// Standalone verifier: WebCrypto only, usable in the browser or Node. No login or Collab verification API.
const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
const b64url = u8 => btoa(String.fromCharCode(...u8)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** RFC 8785 canonical JSON (the subset AP2 checkouts use). */
const jcs = x => x === null || typeof x !== 'object' ? JSON.stringify(x) : Array.isArray(x) ? `[${x.map(jcs).join(',')}]`
  : `{${Object.keys(x).filter(k => x[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${jcs(x[k])}`).join(',')}}`;

/** AP2 v0.2: the seller agent's detached JWS over the checkout, and the buyer agent's SD-JWT mandates bound to it. */
async function verifyAp2(b, key, kid, dealHash, aliases = []) {
  const header = h => { try { const j = JSON.parse(new TextDecoder().decode(bytes(h))); return j.alg === 'EdDSA' && (j.kid === kid || aliases.includes(j.kid)); } catch { return false; } };
  const jws = async (h, p, sig) => header(h) && crypto.subtle.verify('Ed25519', key, bytes(sig), utf8(`${h}.${p}`)).catch(() => false);
  const canonical = jcs({ ...b.checkout, status: 'ready_for_complete' });
  const hash = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(canonical))));
  const [mh, , ms] = b.merchant_authorization.split('.');
  const merchant = hash === b.checkout_hash && b.checkout.deal_hash === dealHash && await jws(mh, b64url(utf8(canonical)), ms);
  const claims = async sd => { const [h, p, sig] = sd.replace(/~$/, '').split('.'); return (await jws(h, p, sig)) ? JSON.parse(new TextDecoder().decode(bytes(p))) : null; };
  const cm = await claims(b.checkout_mandate), pm = await claims(b.payment_mandate), total = b.checkout.totals.total;
  const mandates = !!cm && !!pm && cm.vct === 'ap2.CheckoutMandate' && cm.checkout_hash === b.checkout_hash && cm.checkout_id === b.checkout.id
    && pm.vct === 'ap2.PaymentMandate' && pm.transaction_id === b.checkout_hash && pm.payee === b.checkout.merchant.agent
    && pm.payment_amount?.value === total.value && pm.payment_amount?.currency === total.currency && pm.idempotency_key === b.idempotency_key
    && cm.iss === b.checkout.buyer.agent && pm.iss === b.checkout.buyer.agent;
  return { merchant, mandates };
}

export async function verifyReceiptBundle(r, trustedKey) {
  if (!trustedKey) throw new Error('A trusted public key is required to verify this receipt.');
  const key = await crypto.subtle.importKey('jwk', trustedKey, { name: 'Ed25519' }, false, ['verify']);
  const signature = async (subject, hash, value) => {
    try {
      const [prefix, payload, sig, extra] = value.split('.');
      const p = JSON.parse(new TextDecoder().decode(bytes(payload)));
      // The key's id is its RFC 7638 thumbprint; records made before that carry one of the key's older labels (aliases).
      const named = p.kid === trustedKey.kid || (trustedKey.aliases ?? []).includes(p.kid);
      return !extra && prefix === 'ed25519' && p.v === 1 && p.alg === 'Ed25519' && named && p.subject === subject && p.hash === hash && await crypto.subtle.verify('Ed25519', key, bytes(sig), utf8(payload));
    } catch { return false; }
  };
  const t = r.terms, a = r.parties;
  const hash = await digest({ engagementId: r.engagementId, taskId: r.taskId,
    terms: { title: t.title, price: t.price, unit: t.unit, category: t.category, terms: t.terms, ...(t.currency ? { currency: t.currency } : {}),
      // The seller's stated terms, when the deal had any (records without them are hashed exactly as before).
      ...(t.policies?.length ? { policies: t.policies.map(p => ({ label: p.label, text: p.text })) } : {}),
      // A hiring deal's accepted offer letter, field for field as the server seals it.
      ...(t.offerLetter ? { offerLetter: (l => ({ role: l.role, salary: l.salary, unit: l.unit, start: l.start, validUntil: l.validUntil, mode: l.mode, probation: l.probation,
        notice: l.notice, ...(l.note ? { note: l.note } : {}), issuedAt: l.issuedAt, revision: l.revision }))(t.offerLetter) } : {}) },
    parties: { requester: { handle: a.requester.handle, name: a.requester.name }, provider: { handle: a.provider.handle, name: a.provider.name } }, at: r.at });
  const receipt = hash === r.hash && await signature(r.subjects.requester, hash, r.signatures.requester) && await signature(r.subjects.provider, hash, r.signatures.provider);
  let cart = null, payment = null;
  if (r.payment) {
    const c = r.payment.cart, m = r.payment.mandate;
    const seller = r.payment.seller, buyer = r.payment.buyer;
    if (!['requester','provider'].includes(seller) || buyer !== (seller === 'requester' ? 'provider' : 'requester')) return { receipt, cart: false, payment: false };
    const ch = await digest({ type: c.type, id: c.id, dealHash: c.dealHash,
      merchant: { handle: c.merchant.handle, name: c.merchant.name }, buyer: { handle: c.buyer.handle, name: c.buyer.name },
      items: c.items.map(i => ({ label: i.label, amount: i.amount, ...(i.quantity !== undefined ? { quantity: i.quantity, unitPrice: i.unitPrice } : {}) })), total: { currency: c.total.currency, value: c.total.value }, createdAt: c.createdAt, expiresAt: c.expiresAt });
    // The cart's total is its lines; with no quantities it's the agreed price, with one quantified line it's that
    // price per unit, and with several lines the agreed price is their total.
    const sum = c.items.reduce((n, i) => n + i.amount, 0);
    const linesOk = c.items.every(i => i.quantity === undefined || i.amount === i.quantity * i.unitPrice);
    const priced = c.items.length === 1 && c.items[0].quantity !== undefined ? c.items[0].unitPrice === t.price : sum === t.price;
    cart = receipt && ch === c.hash && c.dealHash === hash && c.merchant.handle === a[seller].handle && c.buyer.handle === a[buyer].handle
      && c.total.currency === (t.currency ?? 'INR') && c.total.value === sum && linesOk && priced && await signature(r.subjects[seller], ch, c.merchantSignature);
    if (m) {
      const mh = await digest({ type: m.type, id: m.id, cartId: m.cartId, cartHash: m.cartHash,
        amount: { currency: m.amount.currency, value: m.amount.value }, method: m.method, payer: m.payer, payee: m.payee, userPresent: m.userPresent, createdAt: m.createdAt });
      payment = cart && mh === m.hash && m.cartHash === ch && m.cartId === c.id && m.amount.currency === c.total.currency && m.amount.value === c.total.value && m.payer === a[buyer].handle && m.payee === a[seller].handle && await signature(r.subjects[buyer], mh, m.payerSignature);
    }
  }
  const ap2 = r.payment?.ap2 ? await verifyAp2(r.payment.ap2, key, trustedKey.kid, hash, trustedKey.aliases ?? []) : null;
  return { receipt, cart, payment, ap2 };
}
