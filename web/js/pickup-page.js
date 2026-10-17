// The page a pass's QR opens (scanned with any phone camera): the pass itself, and — for the seller, signed in — the
// button to mark it done. Inside the app the same pass opens as a modal instead.
import { api, signIn, session } from './api.js';
import { passHTML } from './pass.js';
const [id, code] = location.hash.slice(1).split('.');
const box = document.querySelector('#pass'), status = document.querySelector('#status'), login = document.querySelector('#login');
let details, seller = false;
const MISSING = "This pass doesn't exist or its link is incomplete.";
async function refresh() {
  if (!id || !code) throw new Error(MISSING);
  const r = await fetch(`/public/pickup/${encodeURIComponent(id)}?code=${encodeURIComponent(code)}`, { cache: 'no-store' });
  const j = await r.json().catch(() => ({ error: 'pass not found' }));
  if (!r.ok) throw new Error(j.error === 'pass not found' ? MISSING : j.error);
  details = j;
  box.innerHTML = passHTML(details, { seller });
}
async function sellerCheck() {
  const me = await api('/api/me').catch(() => null);
  seller = !details.collectedAt && me?.handle === details.sellerHandle;
  login.hidden = !!details.collectedAt || seller || !session.google;
  box.innerHTML = passHTML(details, { seller });
}
login.onclick = async () => { try { await session.google(); await sellerCheck(); } catch (e) { status.textContent = e.message; } };
box.addEventListener('click', async ev => {
  const b = ev.target.closest('[data-act="pass-collect"]'); if (!b) return;
  b.disabled = true; status.textContent = '';
  try { await api(`/api/pickup/${encodeURIComponent(id)}/collect`, { code }); }
  catch (e) { status.textContent = e.message; }
  await refresh().then(sellerCheck).catch(e => { status.textContent ||= e.message; b.disabled = false; });
});
try { await refresh(); await signIn(); await sellerCheck(); } catch (e) { if (!box.querySelector('.pass')) box.replaceChildren(); status.textContent = e.message; }
