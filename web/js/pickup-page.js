import { api, signIn, session } from './api.js';
const [id, code] = location.hash.slice(1).split('.');
const status = document.querySelector('#status'), login = document.querySelector('#login'), collect = document.querySelector('#collect');
let details;
async function refresh() {
  const r = await fetch(`/public/pickup/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  details = await r.json(); if (!r.ok) throw new Error(details.error);
  document.querySelector('#details').textContent = `${details.item}\nINR ${details.amount.value}\nBuyer: ${details.buyer}\nSeller: @${details.sellerHandle}`;
  status.textContent = details.collectedAt ? `Already collected at ${new Date(details.collectedAt * 1000).toLocaleString()}` : '✓ Paid (test mode) · Not collected yet';
  if (details.collectedAt) { collect.hidden = true; login.hidden = true; }
}
async function sellerButtons() {
  const me = await api('/api/me').catch(() => null);
  collect.hidden = !!details.collectedAt || me?.handle !== details.sellerHandle;
  login.hidden = !!details.collectedAt || !collect.hidden || !session.google;
}
login.onclick = async () => {
  try { await session.google(); await sellerButtons(); } catch(e) { status.textContent = e.message; }
};
collect.onclick = async () => {
  collect.disabled = true;
  try { await api(`/api/pickup/${encodeURIComponent(id)}/collect`, { code }); await refresh(); }
  catch(e) { await refresh().catch(() => {}); if (!details.collectedAt) status.textContent = e.message; }
  finally { collect.disabled = false; }
};
try { await refresh(); await signIn(); await sellerButtons(); } catch(e) { status.textContent = e.message; }
