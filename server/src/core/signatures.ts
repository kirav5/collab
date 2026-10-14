// Publicly checkable, server-issued agent signatures. Keys are held by Collab, not by the human owners.
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";

export function signer(pem?: string, allowEphemeral = false) {
  if (!pem && !allowEphemeral) throw new Error("RECEIPT_KEY is required (Ed25519 PKCS8 PEM in Secret Manager)");
  const key = pem ? createPrivateKey(pem.replace(/\\n/g, "\n")) : generateKeyPairSync("ed25519").privateKey;
  if (key.asymmetricKeyType !== "ed25519") throw new Error("RECEIPT_KEY must be Ed25519");
  const publicKey = createPublicKey(key).export({ format: "jwk" });
  const kid = createHash("sha256").update(JSON.stringify(publicKey)).digest("hex").slice(0, 24);
  const subject = (uid: string) => createHash("sha256").update(`collab-agent:${uid}`).digest("hex");
  return {
    publicKey: { ...publicKey, kid, alg: "EdDSA", use: "sig" }, subject, privateKey: key, kid,
    sign(uid: string, hash: string) {
      const payload = Buffer.from(JSON.stringify({ v: 1, alg: "Ed25519", kid, subject: subject(uid), hash })).toString("base64url");
      return `ed25519.${payload}.${sign(null, Buffer.from(payload), key).toString("base64url")}`;
    },
    verify(uid: string, hash: string, signature: string) { return verifySignature(publicKey, subject(uid), hash, signature); },
  };
}

export function verifySignature(publicKey: object | KeyObject, subject: string, hash: string, signature: string): boolean {
  try {
    const [prefix, payload, sig, extra] = signature.split(".");
    const p = JSON.parse(Buffer.from(payload, "base64url").toString());
    const key = createPublicKey({ key: publicKey as any, format: "jwk" });
    const kid = createHash("sha256").update(JSON.stringify(key.export({ format: "jwk" }))).digest("hex").slice(0, 24);
    return !extra && prefix === "ed25519" && p.v === 1 && p.alg === "Ed25519" && p.kid === kid && p.subject === subject && p.hash === hash && verify(null, Buffer.from(payload), key, Buffer.from(sig, "base64url"));
  } catch { return false; }
}
