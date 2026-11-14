/**
 * Browser-safe checks for `elivo-direct-receipt-1` (WebCrypto, no Node built-ins); the CLI uses them too.
 * The expected keys always come from the registry contract, never from the file.
 */
import canonicalize from "canonicalize";
import { b58decode, b58encode } from "./base58.ts";
import type { DirectReceipt } from "./direct-receipt.ts";
import type { VerifyResult } from "./receipt.ts";

const canonicalBytes = (v: unknown) => new TextEncoder().encode(canonicalize(v) ?? "");

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
export function directSigningBytes(r: DirectReceipt): Uint8Array {
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
 * ok when the ed25519 signature is by `keys.receipt_pk`. A receipt that carries an ML-DSA-65
 * signature, or whose issuer published an ML-DSA-65 key, is not supported by this verifier.
 */
export async function verifyDirectSignaturesWeb(r: DirectReceipt, keys: IssuerKeys): Promise<VerifyResult> {
  const sigs = Array.isArray(r?.signatures) ? r.signatures : [];
  const ed = sigs.filter((s) => s?.alg === "ed25519");
  if (ed.length !== 1 || sigs.length !== 1 || keys.mldsa65_pk) return { ok: false, reason: "malformed" };
  if (ed[0].public_key !== keys.receipt_pk) return { ok: false, reason: "key_mismatch" };
  const raw = rawEd25519(keys.receipt_pk);
  const sig = typeof ed[0].sig === "string" ? fromBase64(ed[0].sig) : null;
  if (!raw || !sig || sig.length !== 64) return { ok: false, reason: "malformed" };
  try {
    return (await ed25519Verify(raw, sig, directSigningBytes(r)))
      ? { ok: true }
      : { ok: false, reason: "bad_signature" };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

/** base58(sha256(canonical JSON of the whole signed receipt)): the hash the registry anchors. */
export async function directHashB58Web(r: DirectReceipt): Promise<string> {
  return b58encode(new Uint8Array(await crypto.subtle.digest("SHA-256", canonicalBytes(r))));
}
