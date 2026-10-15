// Changes made with no connection: kept on this device (IndexedDB, under the account) and sent when the connection
// returns — in order, once each. A new note carries an id made here, so sending it twice can't make two notes.
// Only the owner's own notes are queued; offers, payments, pickups and anything that involves other people need the
// network, and the app says so.
import { local } from "./local.js";

const rid = () => [...crypto.getRandomValues(new Uint8Array(16))].map(b => (b % 36).toString(36)).join("");
const isNetworkError = e => !e?.status; // fetch failed: no response at all

export async function pendingWrites() {
  return (await local.all("meta").catch(() => [])).filter(r => r.kind === "outbox").sort((a, b) => a.at - b.at);
}

async function queue(path, body) {
  await local.put("meta", { id: `outbox-${Date.now()}-${rid().slice(0, 6)}`, kind: "outbox", path, body, at: Date.now() });
}

/**
 * Sends what was queued, oldest first; returns how many went. Stops at the first network failure (tries again later);
 * a change the server refuses for good (4xx other than auth or rate limits) is dropped rather than retried forever.
 */
let replaying = null;
export function replayOutbox(api) {
  replaying ??= (async () => {
    let sent = 0;
    try {
      for (const w of await pendingWrites()) {
        try { await api(w.path, w.body); await local.del("meta", w.id); sent++; }
        catch (e) {
          if (isNetworkError(e) || [401, 408, 429].includes(e.status) || e.status >= 500) break;
          await local.del("meta", w.id);
        }
      }
    } finally { replaying = null; }
    return sent;
  })();
  return replaying;
}

/** Saves a note: straight to the account when online, else on this device to sync later. */
export async function saveNote(api, body) {
  const b = { ...body, id: body.id ?? `n${rid()}` };
  if (navigator.onLine) {
    try { return await api("/api/facts", b); }
    catch (e) { if (!isNetworkError(e)) throw e; }
  }
  await queue("/api/facts", b);
  return { ...b, queued: true, createdAt: Math.floor(Date.now() / 1000), updatedAt: Math.floor(Date.now() / 1000), topics: [] };
}
