/**
 * Browser-safe checks for `elivo-direct-receipt-1` (WebCrypto, no Node built-ins); the CLI uses them too.
 * The expected keys always come from the registry contract, never from the file.
 */
import canonicalize from "canonicalize";
import { b58decode, b58encode } from "./base58.ts";
import type { DirectSignature } from "./direct-receipt.ts";
import { mldsaVerify } from "./pq-keys.ts";
import type { VerifyResult } from "./receipt.ts";

const canonicalBytes = (v: unknown) => new TextEncoder().encode(canonicalize(v) ?? "");

/** A direct receipt or a check report: any registry-anchored document signed the same way. */
export type SignedDocument = { signatures: DirectSignature[] };

function fromBase64(s: string): Uint8Array | null {
  try {
    return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

function rawEd25519(pk: string): Uint8Array | null {
  if (!pk.startsWith("ed25519:")) return null;
  try {
    const k = b58decode(pk.slice("ed25519:".length));
    return k.length === 32 ? k : null;
  } catch {
    return null;
  }
}

/** The bytes every signature covers: canonical JSON of the receipt without `signatures`. */
export function directSigningBytes<T extends SignedDocument>(r: T): Uint8Array {
  const { signatures: _s, ...body } = r;
  return canonicalBytes(body);
}

async function ed25519Verify(pk: Uint8Array, sig: Uint8Array, msg: Uint8Array): Promise<boolean> {
  const key = await crypto.subtle.importKey("raw", new Uint8Array(pk), { name: "Ed25519" }, false, [
    "verify",
  ]);
  return crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(sig), new Uint8Array(msg));
}

export interface IssuerKeys {
  receipt_pk: string;
  /** base64 ML-DSA-65 public key, when the issuer has published one. */
  mldsa65_pk?: string | null;
}

/**
 * ok when the ed25519 signature is by `keys.receipt_pk` and, if the issuer published an ML-DSA-65 key,
 * the ML-DSA-65 signature is by that key. Both cover the same bytes. A post-quantum signature with no
 * post-quantum key on-chain, or a missing one when there is, is malformed.
 */
export async function verifyDirectSignaturesWeb<T extends SignedDocument>(
  r: T,
  keys: IssuerKeys,
): Promise<VerifyResult> {
  const sigs = Array.isArray(r?.signatures) ? r.signatures : [];
  const ed = sigs.filter((s) => s?.alg === "ed25519");
  const pq = sigs.filter((s) => s?.alg === "ml-dsa-65");
  const wantPq = !!keys.mldsa65_pk;
  if (ed.length !== 1 || pq.length !== (wantPq ? 1 : 0) || sigs.length !== ed.length + pq.length)
    return { ok: false, reason: "malformed" };
  if (ed[0].public_key !== keys.receipt_pk || (wantPq && pq[0].public_key !== keys.mldsa65_pk))
    return { ok: false, reason: "key_mismatch" };
  const raw = rawEd25519(keys.receipt_pk);
  const sig = typeof ed[0].sig === "string" ? fromBase64(ed[0].sig) : null;
  if (!raw || !sig || sig.length !== 64) return { ok: false, reason: "malformed" };
  const msg = directSigningBytes(r);
  try {
    if (!(await ed25519Verify(raw, sig, msg))) return { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (wantPq) {
    const pk = fromBase64(keys.mldsa65_pk as string);
    const pqSig = typeof pq[0].sig === "string" ? fromBase64(pq[0].sig) : null;
    if (!pk || !pqSig) return { ok: false, reason: "malformed" };
    if (!mldsaVerify(pk, msg, pqSig)) return { ok: false, reason: "bad_signature" };
  }
  return { ok: true };
}

/** base58(sha256(canonical JSON of the whole signed receipt)): the hash the registry anchors. */
export async function directHashB58Web<T extends SignedDocument>(r: T): Promise<string> {
  return b58encode(new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes(r))));
}
