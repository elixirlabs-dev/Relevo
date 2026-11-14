/**
 * Browser-safe issuing of `elivo-direct-receipt-1`: parse the issuer's payout results, build the receipt
 * and sign it (ed25519 via @noble/curves, ML-DSA-65 via @noble/post-quantum). The Node signer in
 * direct-issue.ts produces byte-identical receipts; a test pins that.
 *
 * Results CSV: `name,account,amount,status,paid_at,reference`, at most 500 data rows.
 * - status: paid, returned or failed; paid_at (ISO 8601 UTC) is required for a paid row.
 * - On the SPEI rail every account must be a valid CLABE; on other rails 4–34 letters or digits.
 */
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import { parse } from "csv-parse/browser/esm/sync";
import { b58encode } from "./base58.ts";
import { validateClabe } from "./clabe.ts";
import type { RowError } from "./csv.ts";
import {
  DIRECT_VERSION,
  type DirectPayout,
  type DirectReceipt,
  type DirectReceiptBody,
  type DirectStatus,
  directTotals,
  RECEIPT_ID,
} from "./direct-receipt.ts";
import { LABEL } from "./label.ts";
import { type MlDsaKey, mldsaSign } from "./pq-keys.ts";

export const MAX_RESULT_ROWS = 500;
const HEADER = "name,account,amount,status,paid_at,reference";
const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/;
const STATUS: Record<string, DirectStatus> = { paid: "Paid", returned: "Returned", failed: "Failed" };

export interface ResultRow {
  row: number;
  name: string;
  account: string;
  /** two decimal places */
  amount: string;
  status: DirectStatus;
  paid_at: string | null;
  reference: string | null;
}

function twoDp(s: string): string {
  const [w, f = ""] = s.split(".");
  return `${BigInt(w)}.${f.padEnd(2, "0")}`;
}

export function parseResultsCsv(
  text: string,
  opts: { rail: string },
): { rows: ResultRow[]; errors: RowError[] } {
  let records: string[][];
  try {
    records = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
  } catch {
    return { rows: [], errors: [{ row: 0, reason: "unparseable_csv" }] };
  }
  const [head, ...data] = records;
  if (head?.map((h) => h.toLowerCase()).join(",") !== HEADER)
    return { rows: [], errors: [{ row: 1, reason: "bad_header" }] };
  const errors: RowError[] = [];
  if (data.length > MAX_RESULT_ROWS) errors.push({ row: 0, reason: "too_many_rows" });
  const rows: ResultRow[] = [];
  const spei = opts.rail.toUpperCase() === "SPEI";
  data.forEach((rec, i) => {
    const row = i + 2;
    const [name = "", account = "", amount = "", status = "", paidAt = "", reference = ""] = rec;
    const st = STATUS[status.toLowerCase()];
    let reason: string | null = null;
    if (rec.length !== 6) reason = "bad_column_count";
    else if (!name) reason = "missing_name";
    else if (!account) reason = "missing_account";
    else if (spei && !validateClabe(account).ok)
      reason = (validateClabe(account) as { reason: string }).reason;
    else if (!spei && !/^[A-Za-z0-9]{4,34}$/.test(account)) reason = "bad_account";
    else if (!AMOUNT.test(amount) || Number(amount) <= 0) reason = "bad_amount";
    else if (!st) reason = "bad_status";
    else if (paidAt && (!ISO_UTC.test(paidAt) || Number.isNaN(Date.parse(paidAt)))) reason = "bad_paid_at";
    else if (st === "Paid" && !paidAt) reason = "missing_paid_at";
    else if (reference.length > 64) reason = "reference_too_long";
    if (reason) errors.push({ row, reason });
    else
      rows.push({
        row,
        name,
        account,
        amount: twoDp(amount),
        status: st,
        paid_at: paidAt || null,
        reference: reference || null,
      });
  });
  return errors.length ? { rows: [], errors } : { rows, errors };
}

export interface DirectMeta {
  network: string;
  registry: string;
  issuer: string;
  receipt_id: string;
  rail: string;
  currency: string;
  /** Per-receipt salt for payee_ref; keep it with the issuer's records. */
  salt: Uint8Array;
  generated_at?: string;
}

export function buildDirectReceipt(rows: ResultRow[], m: DirectMeta): DirectReceiptBody {
  if (!RECEIPT_ID.test(m.receipt_id)) throw new Error("receipt id: 1-64 of A-Z a-z 0-9 . _ -");
  if (!/^[A-Z]{3}$/.test(m.currency)) throw new Error("currency: ISO 4217 code, e.g. MXN");
  if (rows.length === 0) throw new Error("no payouts");
  const payouts: DirectPayout[] = rows.map((r, id) => ({
    id,
    payee_ref: bytesToHex(sha256(concatBytes(m.salt, new TextEncoder().encode(r.account)))),
    account_last4: r.account.slice(-4),
    amount: r.amount,
    status: r.status,
    paid_at: r.paid_at,
    reference: r.reference,
  }));
  return {
    version: DIRECT_VERSION,
    label: LABEL,
    network: m.network,
    registry: m.registry,
    issuer: m.issuer,
    receipt_id: m.receipt_id,
    generated_at: m.generated_at ?? new Date().toISOString(),
    rail: m.rail.toUpperCase(),
    currency: m.currency,
    payouts,
    totals: directTotals(payouts),
  };
}

const toB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const canonicalBytes = (v: unknown) => new TextEncoder().encode(canonicalize(v) ?? "");

/** "ed25519:<base58>" for a 32-byte ed25519 seed. */
export function ed25519PublicKeyStr(seed: Uint8Array): string {
  return `ed25519:${b58encode(ed25519.getPublicKey(seed))}`;
}

/** Signs with the ed25519 seed, and also with ML-DSA-65 when a post-quantum key is given. */
export function signDirectReceiptWeb(
  body: DirectReceiptBody,
  edSeed: Uint8Array,
  pq?: MlDsaKey,
): DirectReceipt {
  const msg = canonicalBytes(body);
  const signatures: DirectReceipt["signatures"] = [
    { alg: "ed25519", public_key: ed25519PublicKeyStr(edSeed), sig: toB64(ed25519.sign(msg, edSeed)) },
  ];
  if (pq) signatures.push({ alg: "ml-dsa-65", public_key: pq.publicKeyB64, sig: toB64(mldsaSign(pq, msg)) });
  return { ...body, signatures };
}

/** base58(sha256(canonical JSON of the whole signed receipt)), synchronously: the hash the registry anchors. */
export function directHashB58Sync(r: DirectReceipt): string {
  return b58encode(sha256(canonicalBytes(r)));
}
