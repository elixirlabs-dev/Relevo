/**
 * Writes an issued `elivo-direct-receipt-2` and one `elivo-payee-proof-1` per payout next to it:
 *   <base>.json            the receipt
 *   <base>.payee-<i>.json  payee i's proof (hand it to that payee only)
 *   <base>.salt            the receipt salt in hex (secret: keep it with your records, mode 0600)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type DirectReceiptV2, payeeProof } from "../../packages/shared/src/direct-receipt-v2.ts";

export interface DirectV2Files {
  receipt: string;
  proofs: string[];
  salt: string;
}

export function writeDirectV2Files(
  dir: string,
  base: string,
  receipt: DirectReceiptV2,
  receiptSalt: Uint8Array,
): DirectV2Files {
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `${base}.json`);
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  const proofs = receipt.payouts.map((_, i) => {
    const f = join(dir, `${base}.payee-${i}.json`);
    writeFileSync(f, `${JSON.stringify(payeeProof(receipt, i, receiptSalt), null, 2)}\n`);
    return f;
  });
  const salt = join(dir, `${base}.salt`);
  writeFileSync(salt, `${Buffer.from(receiptSalt).toString("hex")}\n`, { mode: 0o600 });
  return { receipt: out, proofs, salt };
}
