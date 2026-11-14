/**
 * `elivo-direct-receipt-2`: a direct receipt whose signatures and anchored hash cover a header that
 * commits to the payouts through a Merkle root, so each payee can be handed a proof of their own payout
 * (`elivo-payee-proof-1`) that verifies against the registry without the other rows. Browser-safe.
 *
 * - Header: every v1 body field except `payouts`, with `version: elivo-direct-receipt-2`, plus
 *   `payouts_root` (hex, see merkle.ts), `payout_count` and `check_ref` (the pre-payout check, or null).
 * - Signed bytes: RFC 8785 canonical JSON of the header (no `payouts`, no `signatures`). Same algorithms
 *   as v1: ed25519, plus ML-DSA-65 with the context string in pq-keys.ts when the issuer has that key.
 * - Anchored hash: base58(sha256(canonical JSON of header + `signatures`)), i.e. the receipt without
 *   `payouts`.
 * - Payee refs: payee_salt_i = sha256(receipt_salt ‖ uint32be(i)), payee_ref_i =
 *   hex(sha256(payee_salt_i ‖ utf8(upper-case account))). The issuer keeps receipt_salt; a payee proof
 *   reveals its own payee_salt, which lets whoever holds the proof test guesses of that payee's account.
 *
 * The keys to verify against always come from the registry, never from the file.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { b58encode } from "./base58.ts";
import type { ChainAccount } from "./chain.ts";
import { type DirectMeta, ed25519PublicKeyStr, type ResultRow } from "./direct-build.ts";
import {
  AMOUNT_2DP,
  ANCHOR_DEPOSIT,
  type DirectPayout,
  type DirectReceipt,
  type DirectSignature,
  type DirectTotals,
  directTotals,
  RECEIPT_ID,
} from "./direct-receipt.ts";
import { directHashB58Web, type IssuerKeys, verifyDirectSignaturesWeb } from "./direct-verify-web.ts";
import { LABEL } from "./label.ts";
import {
  type MerkleProof,
  merkleLeaf,
  merklePathSides,
  merkleProof,
  merkleRoot,
  merkleVerify,
} from "./merkle.ts";
import { type MlDsaKey, mldsaSign } from "./pq-keys.ts";
import type { VerifyResult } from "./receipt.ts";

export const DIRECT_V2 = "elivo-direct-receipt-2";
export const PAYEE_PROOF = "elivo-payee-proof-1";

export interface CheckRef {
  report_id: string;
  report_hash: string;
}

export interface DirectReceiptV2Header {
  version: typeof DIRECT_V2;
  label: string;
  network: string;
  registry: string;
  issuer: string;
  receipt_id: string;
  generated_at: string;
  rail: string;
  currency: string;
  totals: DirectTotals;
  /** hex Merkle root over the payouts, in order */
  payouts_root: string;
  payout_count: number;
  check_ref: CheckRef | null;
}

/** What the registry anchors: the header and its signatures. */
export type SignedHeaderV2 = DirectReceiptV2Header & { signatures: DirectSignature[] };

export type DirectReceiptV2 = SignedHeaderV2 & { payouts: DirectPayout[] };

export interface PayeeProof {
  version: typeof PAYEE_PROOF;
  header: SignedHeaderV2;
  payout: DirectPayout;
  proof: MerkleProof;
  /** hex payee_salt_i, so the payee can check payee_ref against their own account */
  payee_salt: string;
}

const enc = new TextEncoder();
const canonicalBytes = (v: unknown) => enc.encode(canonicalize(v) ?? "");
const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const u32be = (i: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, i, false);
  return b;
};

/** payee_salt_i = sha256(receipt_salt ‖ uint32be(i)) */
export function payeeSalt(receiptSalt: Uint8Array, index: number): Uint8Array {
  return sha256(concatBytes(receiptSalt, u32be(index)));
}

/**
 * Accounts are hashed in upper case (a no-op for a CLABE), so a payee who types their IBAN in lower case
 * still matches the row /issue built.
 */
const normAccount = (account: string) => account.toUpperCase();
const payeeRef = (salt: Uint8Array, account: string) =>
  bytesToHex(sha256(concatBytes(salt, enc.encode(normAccount(account)))));

export function buildDirectReceiptV2(
  rows: ResultRow[],
  m: DirectMeta & { check_ref?: CheckRef | null },
): { header: DirectReceiptV2Header; payouts: DirectPayout[] } {
  if (!RECEIPT_ID.test(m.receipt_id)) throw new Error("receipt id: 1-64 of A-Z a-z 0-9 . _ -");
  if (!/^[A-Z]{3}$/.test(m.currency)) throw new Error("currency: ISO 4217 code, e.g. MXN");
  if (rows.length === 0) throw new Error("no payouts");
  const payouts: DirectPayout[] = rows.map((r, id) => ({
    id,
    payee_ref: payeeRef(payeeSalt(m.salt, id), r.account),
    account_last4: normAccount(r.account).slice(-4),
    amount: r.amount,
    status: r.status,
    paid_at: r.paid_at,
    reference: r.reference,
  }));
  const header: DirectReceiptV2Header = {
    version: DIRECT_V2,
    label: LABEL,
    network: m.network,
    registry: m.registry,
    issuer: m.issuer,
    receipt_id: m.receipt_id,
    generated_at: m.generated_at ?? new Date().toISOString(),
    rail: m.rail.toUpperCase(),
    currency: m.currency,
    totals: directTotals(payouts),
    payouts_root: bytesToHex(merkleRoot(payouts.map(merkleLeaf))),
    payout_count: payouts.length,
    check_ref: m.check_ref ?? null,
  };
  return { header, payouts };
}

/** The header of a receipt or proof header: everything except `payouts` and `signatures`. */
function headerOf(r: DirectReceiptV2Header): DirectReceiptV2Header {
  const { payouts: _p, signatures: _s, ...header } = r as DirectReceiptV2Header & Partial<DirectReceiptV2>;
  return header;
}

/** What is anchored: the receipt without `payouts`. */
function signedHeaderOf(r: SignedHeaderV2): SignedHeaderV2 {
  const { payouts: _p, ...rest } = r as SignedHeaderV2 & Partial<DirectReceiptV2>;
  return rest;
}

/** The bytes every signature covers: canonical JSON of the header (no `payouts`, no `signatures`). */
export function directV2SigningBytes(header: DirectReceiptV2Header): Uint8Array {
  return canonicalBytes(headerOf(header));
}

/** Signs the header with the ed25519 seed, and also with ML-DSA-65 when a post-quantum key is given. */
export function signDirectReceiptV2(
  built: { header: DirectReceiptV2Header; payouts: DirectPayout[] },
  edSeed: Uint8Array,
  pq?: MlDsaKey,
): DirectReceiptV2 {
  const msg = directV2SigningBytes(built.header);
  const signatures: DirectSignature[] = [
    { alg: "ed25519", public_key: ed25519PublicKeyStr(edSeed), sig: toB64(ed25519.sign(msg, edSeed)) },
  ];
  if (pq) signatures.push({ alg: "ml-dsa-65", public_key: pq.publicKeyB64, sig: toB64(mldsaSign(pq, msg)) });
  return { ...headerOf(built.header), signatures, payouts: built.payouts };
}

/** base58(sha256(canonical JSON of header + signatures)): the hash the registry anchors. */
export function directV2HashB58(r: SignedHeaderV2): string {
  return b58encode(sha256(canonicalBytes(signedHeaderOf(r))));
}

/** The v1 machinery over the v2 anchored object: it signs/hashes "everything but signatures"/"everything". */
const asV1 = (r: SignedHeaderV2) => signedHeaderOf(r) as unknown as DirectReceipt;

/** Same as directV2HashB58, with WebCrypto. */
export function directV2HashB58Web(r: SignedHeaderV2): Promise<string> {
  return directHashB58Web(asV1(r));
}

/**
 * The v1 signature checks (ed25519 by `receipt_pk`, ML-DSA-65 by `mldsa65_pk` exactly when the registry
 * has one) over the v2 signing bytes. Takes a receipt or a payee proof's header.
 */
export function verifyDirectV2SignaturesWeb(r: SignedHeaderV2, keys: IssuerKeys): Promise<VerifyResult> {
  return verifyDirectSignaturesWeb(asV1(r), keys);
}

// ---- shape checks (strict: exact keys) ----

const HEX32 = /^[0-9a-f]{64}$/;
const HEADER_KEYS = [
  "version",
  "label",
  "network",
  "registry",
  "issuer",
  "receipt_id",
  "generated_at",
  "rail",
  "currency",
  "totals",
  "payouts_root",
  "payout_count",
  "check_ref",
];
const STATUSES = new Set(["Paid", "Returned", "Failed"]);
const ALGS = new Set(["ed25519", "ml-dsa-65"]);

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const hasKeys = (v: Record<string, unknown>, keys: string[]) => {
  const k = Object.keys(v);
  return k.length === keys.length && keys.every((x) => Object.hasOwn(v, x));
};
const strOrNull = (v: unknown) => v === null || typeof v === "string";
const str = (v: unknown) => typeof v === "string";

function isPayoutStrict(v: unknown): v is DirectPayout {
  return (
    isObj(v) &&
    hasKeys(v, ["id", "payee_ref", "account_last4", "amount", "status", "paid_at", "reference"]) &&
    Number.isInteger(v.id) &&
    (v.id as number) >= 0 &&
    str(v.payee_ref) &&
    HEX32.test(v.payee_ref as string) &&
    str(v.account_last4) &&
    str(v.amount) &&
    AMOUNT_2DP.test(v.amount as string) &&
    STATUSES.has(v.status as string) &&
    strOrNull(v.paid_at) &&
    strOrNull(v.reference)
  );
}

const isSignatureStrict = (v: unknown) =>
  isObj(v) &&
  hasKeys(v, ["alg", "public_key", "sig"]) &&
  ALGS.has(v.alg as string) &&
  str(v.public_key) &&
  str(v.sig);

const isTotalsStrict = (v: unknown) =>
  isObj(v) &&
  hasKeys(v, ["count", "paid", "not_paid"]) &&
  Number.isInteger(v.count) &&
  str(v.paid) &&
  AMOUNT_2DP.test(v.paid as string) &&
  str(v.not_paid) &&
  AMOUNT_2DP.test(v.not_paid as string);

const isCheckRef = (v: unknown) =>
  v === null ||
  (isObj(v) && hasKeys(v, ["report_id", "report_hash"]) && str(v.report_id) && str(v.report_hash));

function headerFieldsOk(r: Record<string, unknown>): boolean {
  return (
    r.version === DIRECT_V2 &&
    str(r.label) &&
    str(r.network) &&
    str(r.registry) &&
    str(r.issuer) &&
    str(r.receipt_id) &&
    RECEIPT_ID.test(r.receipt_id as string) &&
    str(r.generated_at) &&
    str(r.rail) &&
    str(r.currency) &&
    isTotalsStrict(r.totals) &&
    str(r.payouts_root) &&
    HEX32.test(r.payouts_root as string) &&
    Number.isInteger(r.payout_count) &&
    (r.payout_count as number) >= 1 &&
    isCheckRef(r.check_ref) &&
    Array.isArray(r.signatures) &&
    r.signatures.length >= 1 &&
    r.signatures.every(isSignatureStrict)
  );
}

const isSignedHeaderV2 = (v: unknown): v is SignedHeaderV2 =>
  isObj(v) && hasKeys(v, [...HEADER_KEYS, "signatures"]) && headerFieldsOk(v);

/** Strict shape check: exactly the v2 fields, each with the type a verifier reads. */
export function isDirectReceiptV2(v: unknown): v is DirectReceiptV2 {
  return (
    isObj(v) &&
    hasKeys(v, [...HEADER_KEYS, "signatures", "payouts"]) &&
    headerFieldsOk(v) &&
    Array.isArray(v.payouts) &&
    v.payouts.every(isPayoutStrict)
  );
}

export function isPayeeProof(v: unknown): v is PayeeProof {
  if (!isObj(v) || !hasKeys(v, ["version", "header", "payout", "proof", "payee_salt"])) return false;
  const p = v.proof;
  return (
    v.version === PAYEE_PROOF &&
    isSignedHeaderV2(v.header) &&
    isPayoutStrict(v.payout) &&
    isObj(p) &&
    hasKeys(p, ["index", "siblings"]) &&
    Number.isInteger(p.index) &&
    (p.index as number) >= 0 &&
    Array.isArray(p.siblings) &&
    p.siblings.every(
      (s) =>
        isObj(s) &&
        hasKeys(s, ["side", "hash"]) &&
        (s.side === "L" || s.side === "R") &&
        HEX32.test(String(s.hash)),
    ) &&
    str(v.payee_salt) &&
    HEX32.test(v.payee_salt as string)
  );
}

// ---- structure checks ----

/**
 * What doesn't add up in a v2 receipt (empty when all does): `payout_ids` (ids are not 0..n-1 in order),
 * `payouts_root_mismatch`, `payout_count_mismatch`, `totals_mismatch`.
 */
export function verifyDirectV2Structure(r: DirectReceiptV2): string[] {
  const problems: string[] = [];
  if (!r.payouts.every((p, i) => p.id === i)) problems.push("payout_ids");
  const root = r.payouts.length ? bytesToHex(merkleRoot(r.payouts.map(merkleLeaf))) : "";
  if (root !== r.payouts_root) problems.push("payouts_root_mismatch");
  if (r.payouts.length !== r.payout_count) problems.push("payout_count_mismatch");
  let want: DirectTotals | null = null;
  try {
    want = directTotals(r.payouts);
  } catch {
    // unreadable amounts: the totals can't match
  }
  if (!want || (Object.keys(want) as Array<keyof DirectTotals>).some((k) => r.totals?.[k] !== want[k]))
    problems.push("totals_mismatch");
  return problems;
}

/** One payee's proof: the signed header, their payout, its Merkle path and their payee_salt. */
export function payeeProof(r: DirectReceiptV2, index: number, receiptSalt: Uint8Array): PayeeProof {
  if (!Number.isInteger(index) || index < 0 || index >= r.payouts.length)
    throw new Error(`no payout ${index} in this receipt`);
  const leaves = r.payouts.map(merkleLeaf);
  return {
    version: PAYEE_PROOF,
    header: signedHeaderOf(r),
    payout: r.payouts[index],
    proof: merkleProof(leaves, index),
    payee_salt: bytesToHex(payeeSalt(receiptSalt, index)),
  };
}

/**
 * What doesn't add up in a payee proof (empty when all does): `index_out_of_range`, `index_mismatch`
 * (payout.id !== proof.index), `path_shape` (the sides don't fit the index in a tree of payout_count
 * leaves), `merkle_path` (the path doesn't lead to payouts_root).
 */
export function verifyPayeeProofStructure(p: PayeeProof): string[] {
  const problems: string[] = [];
  const { index, siblings } = p.proof;
  const inRange = index < p.header.payout_count;
  if (!inRange) problems.push("index_out_of_range");
  if (p.payout.id !== index) problems.push("index_mismatch");
  if (inRange && siblings.map((s) => s.side).join() !== merklePathSides(index, p.header.payout_count).join())
    problems.push("path_shape");
  if (!merkleVerify(merkleLeaf(p.payout), p.proof, hexToBytes(p.header.payouts_root)))
    problems.push("merkle_path");
  return problems;
}

/** True when `account` is the payee of this proof: payee_ref and last 4 match. */
export function payeeRefMatches(p: PayeeProof, account: string): boolean {
  if (!HEX32.test(p.payee_salt)) return false;
  return (
    payeeRef(hexToBytes(p.payee_salt), account) === p.payout.payee_ref &&
    normAccount(account).slice(-4) === p.payout.account_last4
  );
}

/** Anchors a v2 receipt's hash in the registry (Node or browser; the caller brings the signer). */
export async function anchorDirectReceiptV2(
  issuer: ChainAccount,
  registry: string,
  r: DirectReceiptV2,
): Promise<{ txHash: string; hash: string }> {
  if (r.issuer !== issuer.accountId)
    throw new Error(`receipt is for ${r.issuer}, signer is ${issuer.accountId}`);
  const hash = directV2HashB58(r);
  const res = await issuer.call(
    registry,
    "anchor",
    { receipt_id: r.receipt_id, receipt_hash: hash },
    { gasTgas: 30, depositYocto: ANCHOR_DEPOSIT },
  );
  return { txHash: res.txHash, hash };
}
