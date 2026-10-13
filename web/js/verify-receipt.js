// Standalone verifier: WebCrypto only, usable in the browser or Node. No login or Collab verification API.
const bytes = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
const utf8 = s => new TextEncoder().encode(s);
const digest = async value => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(JSON.stringify(value)))), b => b.toString(16).padStart(2, '0')).join('');
export async function verifyReceiptBundle(r, trustedKey = r.publicKey) {
  const key = await crypto.subtle.importKey('jwk', trustedKey, { name: 'Ed25519' }, false, ['verify']);
  const signature = async (subject, hash, value) => {
    try {
      const [prefix, payload, sig, extra] = value.split('.');
      const p = JSON.parse(new TextDecoder().decode(bytes(payload)));
      return !extra && prefix === 'ed25519' && p.v === 1 && p.alg === 'Ed25519' && p.kid === trustedKey.kid && p.subject === subject && p.hash === hash && await crypto.subtle.verify('Ed25519', key, bytes(sig), utf8(payload));
    } catch { return false; }
  };
  const t = r.terms, a = r.parties;
  const hash = await digest({ engagementId: r.engagementId, taskId: r.taskId,
    terms: { title: t.title, price: t.price, unit: t.unit, category: t.category, terms: t.terms },
    parties: { requester: { handle: a.requester.handle, name: a.requester.name }, provider: { handle: a.provider.handle, name: a.provider.name } }, at: r.at });
  const receipt = hash === r.hash && await signature(r.subjects.requester, hash, r.signatures.requester) && await signature(r.subjects.provider, hash, r.signatures.provider);
  let cart = null, payment = null;
  if (r.payment) {
    const c = r.payment.cart, m = r.payment.mandate;
    const seller = r.payment.seller, buyer = r.payment.buyer;
    if (!['requester','provider'].includes(seller) || buyer !== (seller === 'requester' ? 'provider' : 'requester')) return { receipt, cart: false, payment: false };
    const ch = await digest({ type: c.type, id: c.id, dealHash: c.dealHash,
      merchant: { handle: c.merchant.handle, name: c.merchant.name }, buyer: { handle: c.buyer.handle, name: c.buyer.name },
      items: c.items.map(i => ({ label: i.label, amount: i.amount })), total: { currency: c.total.currency, value: c.total.value }, createdAt: c.createdAt, expiresAt: c.expiresAt });
    cart = receipt && ch === c.hash && c.dealHash === hash && c.merchant.handle === a[seller].handle && c.buyer.handle === a[buyer].handle && c.total.currency === 'INR' && c.total.value === t.price && await signature(r.subjects[seller], ch, c.merchantSignature);
    if (m) {
      const mh = await digest({ type: m.type, id: m.id, cartId: m.cartId, cartHash: m.cartHash,
        amount: { currency: m.amount.currency, value: m.amount.value }, method: m.method, payer: m.payer, payee: m.payee, userPresent: m.userPresent, createdAt: m.createdAt });
      payment = cart && mh === m.hash && m.cartHash === ch && m.cartId === c.id && m.amount.currency === c.total.currency && m.amount.value === c.total.value && m.payer === a[buyer].handle && m.payee === a[seller].handle && await signature(r.subjects[buyer], mh, m.payerSignature);
    }
  }
  return { receipt, cart, payment };
}
