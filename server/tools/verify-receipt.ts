// Offline: node tools/verify-receipt.ts receipt.json trusted-key.json
// Obtain and pin the trusted public key independently (for example from an agent card).
import { readFileSync } from 'node:fs';
// @ts-ignore Browser module is also a standalone WebCrypto verifier.
import { verifyReceiptBundle } from '../../web/js/verify-receipt.js';
const [receiptPath, keyPath] = process.argv.slice(2);
if (!receiptPath || !keyPath) throw new Error('Usage: node tools/verify-receipt.ts receipt.json trusted-key.json');
const r = JSON.parse(readFileSync(receiptPath, 'utf8')), key = JSON.parse(readFileSync(keyPath, 'utf8'));
const result = await verifyReceiptBundle(r, key);
console.log(JSON.stringify(result, null, 2));
process.exitCode = result.receipt && result.cart !== false && result.payment !== false ? 0 : 1;
