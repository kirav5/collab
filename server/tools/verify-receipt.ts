// Offline: node tools/verify-receipt.ts receipt.json trusted-key.json
// Obtain and pin the trusted public key independently (for example from an agent card).
import { readFileSync } from 'node:fs';
// @ts-ignore Browser module is also a standalone WebCrypto verifier.
import { verifyReceiptBundle } from '../../web/js/verify-receipt.js';
const [receiptPath, keyPath] = process.argv.slice(2);
if (!receiptPath || !keyPath) throw new Error('Usage: node tools/verify-receipt.ts receipt.json trusted-key.json');
const r = JSON.parse(readFileSync(receiptPath, 'utf8')), keyFile = JSON.parse(readFileSync(keyPath, 'utf8'));
// Every trusted key is tried (current and retired); the record names which one it used (by id or an older alias).
const keys = Array.isArray(keyFile.keys) ? keyFile.keys : [keyFile];
let result: any = null;
for (const key of keys) { const r2 = await verifyReceiptBundle(r, key); if (!result || r2.receipt) result = r2; if (r2.receipt) break; }
if (!result) throw new Error('No trusted keys in the key file.');
console.log(JSON.stringify({ ...result, ...(r.legacyAttestation ? { note: 'Legacy agreement was attested on export; HMAC cart/payment signatures cannot be independently verified.' } : {}) }, null, 2));
process.exitCode = result.receipt && result.cart !== false && result.payment !== false ? 0 : 1;
