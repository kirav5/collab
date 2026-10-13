// Dedicated synthetic accounts only. Credentials stay in memory. Never disable production App Check for a benchmark.
import { readFileSync } from 'node:fs';
export interface Actor { token: string; uid: string; appCheck?: string }
export async function actors(base: string, count = 2): Promise<Actor[]> {
  if (process.env.BENCH_AUTH_FILE) return JSON.parse(readFileSync(process.env.BENCH_AUTH_FILE, 'utf8'));
  const config = await fetch(base + '/api/config').then(r => r.json());
  if (new URL(base).hostname === 'localhost' || new URL(base).hostname === '127.0.0.1') {
    if (!config.devAuth) throw new Error('Local service has no DEV_AUTH; use BENCH_AUTH_FILE.');
    return Array.from({ length: count }, (_, i) => ({ uid: `bench-${Date.now()}-${i}`, token: `dev:bench-${Date.now()}-${i}` }));
  }
  if (process.env.BENCH_ADMIN !== '1') throw new Error('Use BENCH_AUTH_FILE with dedicated test ID/App Check tokens, or BENCH_ADMIN=1 with authorized ADC credentials.');
  if (!config.firebase) throw new Error('No Firebase config.');
  const { initializeApp, applicationDefault } = await import('firebase-admin/app');
  const { getAppCheck } = await import('firebase-admin/app-check');
  const projectId = config.firebase.projectId;
  const app = initializeApp({ credential: applicationDefault(), projectId, serviceAccountId: `collab-market@${projectId}.iam.gserviceaccount.com` }, `bench-${Date.now()}`);
  const { token: custom } = await getAppCheck(app).createToken(config.firebase.appId, { ttlMillis: 3600000 });
  const acResponse = await fetch(`https://firebaseappcheck.googleapis.com/v1/projects/${projectId}/apps/${config.firebase.appId}:exchangeCustomToken?key=${config.firebase.apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customToken: custom }) });
  if (!acResponse.ok) throw new Error(`App Check exchange failed (${acResponse.status})`);
  const ac = await acResponse.json();
  const out: Actor[] = [];
  for (let i = 0; i < count; i++) {
    const response = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${config.firebase.apiKey}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!response.ok) throw new Error(`Test account creation failed (${response.status})`);
    const r = await response.json(); out.push({ uid: r.localId, token: r.idToken, appCheck: ac.token });
  }
  return out;
}
