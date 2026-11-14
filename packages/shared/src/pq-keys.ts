/**
 * ML-DSA-65 (FIPS 204) keys for post-quantum receipt signatures, via @noble/post-quantum (not
 * independently audited; acceptable for this testnet prototype). Browser-safe.
 *
 * Signatures use the FIPS 204 context string `elivo-direct-receipt-1`, so a receipt signature can't be
 * replayed as a signature over anything else.
 */
import { ml_dsa65 } from "@noble/post-quantum/ml-dsa.js";

export const MLDSA65_PK_BYTES = 1952;
export const MLDSA65_SIG_BYTES = 3309;
export const MLDSA_CONTEXT = new TextEncoder().encode("elivo-direct-receipt-1");

export interface MlDsaKey {
  seed: Uint8Array;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  /** base64 of the public key, as the registry and the receipt carry it */
  publicKeyB64: string;
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));

export function mldsaFromSeed(seed: Uint8Array): MlDsaKey {
  if (seed.length !== 32) throw new Error("ML-DSA seed must be 32 bytes");
  const { publicKey, secretKey } = ml_dsa65.keygen(seed);
  return { seed: Uint8Array.from(seed), publicKey, secretKey, publicKeyB64: toB64(publicKey) };
}

export function mldsaSign(key: MlDsaKey, msg: Uint8Array): Uint8Array {
  return ml_dsa65.sign(msg, key.secretKey, { context: MLDSA_CONTEXT });
}

export function mldsaVerify(publicKey: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
  if (publicKey.length !== MLDSA65_PK_BYTES || sig.length !== MLDSA65_SIG_BYTES) return false;
  try {
    return ml_dsa65.verify(sig, msg, publicKey, { context: MLDSA_CONTEXT });
  } catch {
    return false;
  }
}
