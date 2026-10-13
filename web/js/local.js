// The device: what this browser keeps is chat history (sessions), also kept in the account so every device and the
// installed app show the same chats. Facts of every tier — Private included —
// live on the server under the owner's account; Private is stored but the policy gate never shares it. The old
// "facts"/"limits" stores may still exist in older browsers' IndexedDB; they are simply no longer read.
const DB = "collab", VERSION = 1;
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, VERSION);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ["facts", "sessions", "limits", "meta"]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const out = fn(s);
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

// The account the data belongs to: one browser can hold several (each sees only its own).
let owner = "anon";
export const setOwner = uid => { owner = uid; };
const key = id => `${owner}:${id}`;
const strip = x => { if (!x) return x; const { id, ...rest } = x; return { ...rest, id: id.slice(owner.length + 1) }; };

export const local = {
  async all(store) {
    const rows = await tx(store, "readonly", s => s.getAll());
    return rows.filter(r => r.id.startsWith(owner + ":")).map(strip);
  },
  async get(store, id) { return strip(await tx(store, "readonly", s => s.get(key(id)))); },
  async put(store, value) { await tx(store, "readwrite", s => s.put({ ...value, id: key(value.id) })); return value; },
  async del(store, id) { await tx(store, "readwrite", s => s.delete(key(id))); },
  async clear() { for (const s of ["facts", "sessions", "limits", "meta"]) for (const r of await this.all(s)) await this.del(s, r.id); },
};

/** The owner's notes that look relevant to a question: words in common, newest first. */
export function relevant(facts, question, n = 8) {
  const words = new Set((question.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).map(w => w.replace(/s$/, "")));
  return facts.map(f => ({ f, score: (f.text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []).filter(w => words.has(w.replace(/s$/, ""))).length }))
    .filter(x => x.score > 0).sort((a, b) => b.score - a.score || b.f.createdAt - a.f.createdAt).slice(0, n).map(x => x.f);
}
