// End-to-end encryption between a person's own devices (WebCrypto: ECDH P-256 → AES-GCM 256). Each device keeps a key
// pair whose private half can't be exported; a question is sealed to the answering device's public key with a fresh
// one-time key, and the answer comes back under the same shared key. Firestore only ever carries ciphertext, bound to
// its job id, so neither Google nor the Collab server can read a question, a note or an answer. Pure: runs in Node too.
const subtle = globalThis.crypto.subtle;
const CURVE = { name: "ECDH", namedCurve: "P-256" };

const b64 = buf => { const a = new Uint8Array(buf); let s = ""; for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const aad = jobId => new TextEncoder().encode(`collab-job:${jobId}`);

/** A device's key pair; the private key is non-extractable (it can be stored in IndexedDB, never read out). */
export const deviceKeys = () => subtle.generateKey(CURVE, false, ["deriveKey"]);
export const publicJwk = async pair => { const { kty, crv, x, y } = await subtle.exportKey("jwk", pair.publicKey); return { kty, crv, x, y }; };

async function shared(privateKey, jwk) {
  const pub = await subtle.importKey("jwk", { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, CURVE, false, []);
  return subtle.deriveKey({ name: "ECDH", public: pub }, privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encrypt(key, jobId, payload) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad(jobId) }, key, new TextEncoder().encode(JSON.stringify(payload)));
  return { iv: b64(iv), ct: b64(ct) };
}
async function decrypt(key, jobId, box) {
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: unb64(box.iv), additionalData: aad(jobId) }, key, unb64(box.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}

/** Seals a question to a device. Returns the envelope to store and the key that opens the reply. */
export async function seal(toJwk, jobId, payload) {
  const eph = await subtle.generateKey(CURVE, true, ["deriveKey"]);
  const key = await shared(eph.privateKey, toJwk);
  const { kty, crv, x, y } = await subtle.exportKey("jwk", eph.publicKey);
  return { envelope: { epk: { kty, crv, x, y }, ...(await encrypt(key, jobId, payload)) }, key };
}
/** Opens a question sealed to this device; returns it and the key to seal the reply with. */
export async function open(privateKey, jobId, envelope) {
  const key = await shared(privateKey, envelope.epk);
  return { payload: await decrypt(key, jobId, envelope), key };
}
export const sealReply = (key, jobId, payload) => encrypt(key, jobId, payload);
export const openReply = (key, jobId, box) => decrypt(key, jobId, box);
