import { api, signIn, session } from './api.js';
const [id, code] = location.hash.slice(1).split('.');
const status = document.querySelector('#status'), login = document.querySelector('#login'), collect = document.querySelector('#collect');
let details;
const note = document.querySelector('#note');
const KINDS = { pickup: { name: 'Pickup pass', done: 'Collected', verb: 'handing over the item' },
  booking: { name: 'Booking pass', done: 'Checked in', verb: 'starting' }, handover: { name: 'Handover pass', done: 'Handed over', verb: 'handing over' } };
async function refresh() {
  const r = await fetch(`/public/pickup/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  details = await r.json(); if (!r.ok) throw new Error(details.error);
  const k = KINDS[details.kind] ?? KINDS.pickup;
  document.title = `Collab ${k.name.toLowerCase()}`; document.querySelector('h1').textContent = k.name; collect.textContent = `Mark ${k.done.toLowerCase()}`;
  const when = details.slot ? `\nTime: ${new Date(details.slot * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}` : '';
  document.querySelector('#details').textContent = `${details.item}\n${details.amount.currency ?? 'INR'} ${details.amount.value}${when}\nBuyer: ${details.buyer}\nSeller: @${details.sellerHandle}`;
  const paid = details.payment === 'outside'
    ? (details.markedBy === 'seller' ? 'Paid outside the app — the seller confirmed it' : 'Marked paid outside the app by the buyer — check you received the money')
    : '✓ Paid (test mode)';
  status.textContent = details.collectedAt ? `${k.done} at ${new Date(details.collectedAt * 1000).toLocaleString()}` : `${paid} · not ${k.done.toLowerCase()} yet`;
  note.textContent = details.payment === 'outside' ? `The seller checks the buyer's name before ${k.verb}.` : `Test payment — no money moved. The seller checks the buyer's name before ${k.verb}.`;
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
