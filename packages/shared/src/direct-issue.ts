/**
 * Issuing `elivo-direct-receipt-1` (Node): sign the receipt, publish the issuer's keys and anchor the
 * receipt's hash in the registry contract. Parsing and building live in the browser-safe direct-build.ts.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { b58encode } from "./base58.ts";
import type { ChainAccount } from "./chain.ts";
import type { DirectReceipt, DirectReceiptBody } from "./direct-receipt.ts";
import { type Ed25519Key, sign } from "./keys.ts";
import { type MlDsaKey, mldsaSign } from "./pq-keys.ts";

export {
  buildDirectReceipt,
  type DirectMeta,
  MAX_RESULT_ROWS,
  parseResultsCsv,
  type ResultRow,
} from "./direct-build.ts";

const canonicalBytes = (v: unknown) => Buffer.from(canonicalize(v) ?? "", "utf8");

/** Signs with ed25519, and also with ML-DSA-65 when a post-quantum key is given (same signed bytes). */
export function signDirectReceipt(body: DirectReceiptBody, key: Ed25519Key, pq?: MlDsaKey): DirectReceipt {
  const msg = canonicalBytes(body);
  const signatures: DirectReceipt["signatures"] = [
    { alg: "ed25519", public_key: key.publicKeyStr, sig: Buffer.from(sign(key, msg)).toString("base64") },
  ];
  if (pq)
    signatures.push({
      alg: "ml-dsa-65",
      public_key: pq.publicKeyB64,
      sig: Buffer.from(mldsaSign(pq, new Uint8Array(msg))).toString("base64"),
    });
  return { ...body, signatures };
}

export function directHashB58(r: DirectReceipt): string {
  return b58encode(new Uint8Array(createHash("sha256").update(canonicalBytes(r)).digest()));
}

export { ANCHOR_DEPOSIT, KEYS_DEPOSIT } from "./direct-receipt.ts";

import { ANCHOR_DEPOSIT, KEYS_DEPOSIT } from "./direct-receipt.ts";

interface KeysView {
  version: number;
  receipt_pk: string;
  mldsa65_pk: string | null;
}

/**
 * Publishes the issuer's receipt keys (ed25519, plus ML-DSA-65 if given) unless they are already the
 * current ones; returns the key version.
 */
export async function ensureIssuerKeys(
  view: <T>(contractId: string, method: string, args?: object) => Promise<T>,
  issuer: ChainAccount,
  registry: string,
  key: Ed25519Key,
  pq?: MlDsaKey,
): Promise<number> {
  const cur = await view<KeysView | null>(registry, "get_keys", { issuer: issuer.accountId });
  const pqPk = pq?.publicKeyB64 ?? null;
  if (cur && cur.receipt_pk === key.publicKeyStr && (cur.mldsa65_pk ?? null) === pqPk) return cur.version;
  const r = await issuer.call(
    registry,
    "set_keys",
    { receipt_pk: key.publicKeyStr, mldsa65_pk: pqPk },
    { gasTgas: 30, depositYocto: KEYS_DEPOSIT },
  );
  return r.value as number;
}

export async function anchorDirectReceipt(
  issuer: ChainAccount,
  registry: string,
  r: DirectReceipt,
): Promise<{ txHash: string; hash: string }> {
  if (r.issuer !== issuer.accountId)
    throw new Error(`receipt is for ${r.issuer}, signer is ${issuer.accountId}`);
  const hash = directHashB58(r);
  const res = await issuer.call(
    registry,
    "anchor",
    { receipt_id: r.receipt_id, receipt_hash: hash },
    { gasTgas: 30, depositYocto: ANCHOR_DEPOSIT },
  );
  return { txHash: res.txHash, hash };
}
