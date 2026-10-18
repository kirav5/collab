// Firestore behind a small interface, so the same code runs on Firestore (Cloud Run) and in memory (tests, local
// development without a Google project). Only what the market needs: get/set/merge/delete, equality and `in` queries,
// one range bound, counts, and read-modify-write.

export type Op = "==" | "in" | "array-contains" | "array-contains-any" | "<" | "<=" | ">" | ">=";
export type Where = [field: string, op: Op, value: unknown];

export interface Docs {
  get(col: string, id: string): Promise<any | null>;
  /** Replaces the document. */
  set(col: string, id: string, data: any): Promise<void>;
  /** Merges top-level fields into the document (creating it if needed). */
  merge(col: string, id: string, data: any): Promise<void>;
  delete(col: string, id: string): Promise<void>;
  /** `newest`: ordered by that field, highest first (needs a composite index on Firestore). */
  find(col: string, where: Where[], limit?: number, newest?: string): Promise<any[]>;
  count(col: string, where: Where[]): Promise<number>;
  /** Read, change, write atomically. `fn` returns the new document, or null to leave it unchanged. */
  update(col: string, id: string, fn: (current: any | null) => any | null): Promise<any | null>;
  /** The documents whose `field` vector is nearest `vector` (cosine), among those matching `where`. */
  nearest(col: string, field: string, vector: number[], where: Where[], limit: number): Promise<{ doc: any; distance: number }[]>;
}

/** Stored vectors: Firestore keeps them as a vector value; in memory they're plain arrays. */
export const vectorOf = (v: any): number[] | null => (Array.isArray(v) ? v : typeof v?.toArray === "function" ? v.toArray() : null);

function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  return 1 - dot / (Math.sqrt(na * nb) || 1);
}

/** Firestore document ids can't contain "/" (and shouldn't be long); listing keys and AT URIs can. */
export const docId = (key: string) => encodeURIComponent(key).slice(0, 1400);

// MARK: - Memory

function test(doc: any, [field, op, value]: Where): boolean {
  const v = doc[field];
  switch (op) {
    case "==": return v === value;
    case "in": return (value as unknown[]).includes(v);
    case "array-contains": return Array.isArray(v) && v.includes(value);
    case "array-contains-any": return Array.isArray(v) && (value as unknown[]).some(x => v.includes(x));
    case "<": return v < (value as any);
    case "<=": return v <= (value as any);
    case ">": return v > (value as any);
    case ">=": return v >= (value as any);
  }
}

export function memoryDocs(): Docs {
  const cols = new Map<string, Map<string, any>>();
  const col = (name: string) => { let c = cols.get(name); if (!c) cols.set(name, c = new Map()); return c; };
  const copy = (x: any) => (x == null ? null : structuredClone(x));
  return {
    async get(c, id) { return copy(col(c).get(id)); },
    async set(c, id, data) { col(c).set(id, copy(data)); },
    async merge(c, id, data) { col(c).set(id, { ...(col(c).get(id) ?? {}), ...copy(data) }); },
    async delete(c, id) { col(c).delete(id); },
    async find(c, where, limit = 1000, newest) {
      const rows = [...col(c).values()].filter(d => where.every(w => test(d, w)));
      if (newest) rows.sort((a, b) => (b[newest] ?? 0) - (a[newest] ?? 0));
      return rows.slice(0, limit).map(copy);
    },
    async count(c, where) { return [...col(c).values()].filter(d => where.every(w => test(d, w))).length; },
    async update(c, id, fn) {
      const next = fn(copy(col(c).get(id)));
      if (next !== null) col(c).set(id, copy(next));
      return copy(next);
    },
    async nearest(c, field, vector, where, limit) {
      return [...col(c).values()].filter(d => where.every(w => test(d, w)) && Array.isArray(d[field]))
        .map(d => ({ doc: copy(d), distance: cosineDistance(vector, d[field]) }))
        .sort((a, b) => a.distance - b.distance).slice(0, limit);
    },
  };
}

// MARK: - Firestore

export async function firestoreDocs(): Promise<Docs> {
  const { initializeApp, getApps } = await import("firebase-admin/app");
  const { getFirestore, FieldValue } = await import("firebase-admin/firestore");
  if (!getApps().length) initializeApp();
  const db = getFirestore();
  db.settings({ ignoreUndefinedProperties: true });
  const query = (c: string, where: Where[]) => {
    let q: FirebaseFirestore.Query = db.collection(c);
    for (const [f, op, v] of where) q = q.where(f, op, v);
    return q;
  };
  // Vector fields are written as Firestore vectors (for findNearest) and read back as plain arrays.
  const VECTOR_FIELDS = new Set(["embedding"]);
  const encode = (data: any) => {
    if (!data || typeof data !== "object") return data;
    const out = { ...data };
    for (const f of VECTOR_FIELDS) if (Array.isArray(out[f])) out[f] = FieldValue.vector(out[f]);
    return out;
  };
  const decode = (data: any) => {
    if (!data) return data;
    for (const f of VECTOR_FIELDS) if (data[f] && !Array.isArray(data[f])) data[f] = vectorOf(data[f]);
    return data;
  };
  return {
    async get(c, id) { const s = await db.collection(c).doc(id).get(); return s.exists ? decode(s.data()) : null; },
    async set(c, id, data) { await db.collection(c).doc(id).set(encode(data)); },
    async merge(c, id, data) { await db.collection(c).doc(id).set(encode(data), { merge: true }); },
    async delete(c, id) { await db.collection(c).doc(id).delete(); },
    async find(c, where, limit = 1000, newest) {
      const q = newest ? query(c, where).orderBy(newest, "desc") : query(c, where);
      return (await q.limit(limit).get()).docs.map(d => decode(d.data()));
    },
    async count(c, where) { return (await query(c, where).count().get()).data().count; },
    async update(c, id, fn) {
      const ref = db.collection(c).doc(id);
      return db.runTransaction(async tx => {
        const s = await tx.get(ref);
        const next = fn(s.exists ? decode(s.data()) : null);
        if (next !== null) tx.set(ref, encode(next));
        return next;
      });
    },
    async nearest(c, field, vector, where, limit) {
      const snap = await query(c, where).findNearest({ vectorField: field, queryVector: vector, limit: Math.min(limit, 1000), distanceMeasure: "COSINE", distanceResultField: "_distance" }).get();
      return snap.docs.map(d => { const data = decode(d.data()); const distance = data._distance; delete data._distance; return { doc: data, distance }; });
    },
  };
}
