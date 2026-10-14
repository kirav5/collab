// Publicly checkable, server-issued agent signatures. Keys are held by Collab, not by the human owners.
import { KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";

/** RFC 7638 thumbprint: the key id is the hash of the canonical JWK, the same on every runtime. */
export const thumbprint = (jwk: { kty: string; crv: string; x: string }) =>
  createHash("sha256").update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })).digest("hex").slice(0, 24);
/** Labels older records may carry: the hash of the JWK in whichever property order the signing runtime used. */
export function legacyKids(jwk: { kty: string; crv: string; x: string }): string[] {
  const out = new Set<string>();
  const perms = (a: string[]): string[][] => (a.length <= 1 ? [a] : a.flatMap((x, i) => perms([...a.slice(0, i), ...a.slice(i + 1)]).map(p => [x, ...p])));
  for (const order of perms(["crv", "x", "kty"])) out.add(createHash("sha256").update(JSON.stringify(Object.fromEntries(order.map(k => [k, (jwk as any)[k]])))).digest("hex").slice(0, 24));
  out.delete(thumbprint(jwk));
  return [...out];
}

export interface PublishedKey { kty: string; crv: string; x: string; kid: string; alg: "EdDSA"; use: "sig"; aliases: string[] }

/**
 * `previous`: public keys retired by rotation (JSON array of JWKs, from RECEIPT_KEYS_PREVIOUS). Records signed with
 * them keep verifying; nothing new is signed with them.
 */
export function signer(pem?: string, allowEphemeral = false, previous: object[] = []) {
  if (!pem && !allowEphemeral) throw new Error("RECEIPT_KEY is required (Ed25519 PKCS8 PEM in Secret Manager)");
  const key = pem ? createPrivateKey(pem.replace(/\\n/g, "\n")) : generateKeyPairSync("ed25519").privateKey;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RECEIPT_KEY must be Ed25519");
  const jwk = createPublicKey(key).export({ format: "jwk" }) as { kty: string; crv: string; x: string };
  const publish = (j: { kty: string; crv: string; x: string }): PublishedKey => ({ kty: j.kty, crv: j.crv, x: j.x, kid: thumbprint(j), alg: "EdDSA", use: "sig", aliases: legacyKids(j) });
  const publicKey = publish(jwk), kid = publicKey.kid;
  const keys: PublishedKey[] = [publicKey, ...previous.map(p => publish(p as any))];
  const subject = (uid: string) => createHash("sha256").update(`collab-agent:${uid}`).digest("hex");
  return {
    publicKey, keys, subject, privateKey: key, kid,
    sign(uid: string, hash: string) {
      const payload = Buffer.from(JSON.stringify({ v: 1, alg: "Ed25519", kid, subject: subject(uid), hash })).toString("base64url");
      return `ed25519.${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
    },
    /** Verifies against the current key or any retired one, by the kid (or alias) the record names. */
    verify(uid: string, hash: string, signature: string) {
      return keys.some(k => verifySignature(k, subject(uid), hash, signature));
    },
    /** Is this kid (or alias) one of ours? */
    knows: (kid: string) => keys.some(k => k.kid === kid || k.aliases.includes(kid)),
  };
}

export function verifySignature(publicKey: object | KeyObject, subject: string, hash: string, signature: string): boolean {
  try {
    const [prefix, payload, sig, extra] = signature.split(".");
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    const key = createPublicKey(publicKey instanceof KeyObject ? publicKey : { key: { kty: (publicKey as any).kty, crv: (publicKey as any).crv, x: (publicKey as any).x }, format: "jwk" });
    const jwk = key.export({ format: "jwk" }) as { kty: string; crv: string; x: string };
    const kids = [thumbprint(jwk), ...legacyKids(jwk)];
    return !extra && prefix === "ed25519" && p.v === 1 && p.alg === "Ed25519" && kids.includes(p.kid) && p.subject === subject && p.hash === hash && verify(null, Buffer.from(payload), key, Buffer.from(sig, "base64url"));
  } catch { return false; }
}
