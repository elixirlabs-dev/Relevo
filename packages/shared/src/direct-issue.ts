/**
 * Issuing `elivo-direct-receipt-1` (Node): parse the issuer's payout results, build and sign the
 * receipt, publish the issuer's keys and anchor the receipt's hash in the registry contract.
 *
 * Results CSV: `name,account,amount,status,paid_at,reference`, at most 500 data rows.
 * - status: paid, returned or failed; paid_at (ISO 8601 UTC) is required for a paid row.
 * - On the SPEI rail every account must be a valid CLABE; on other rails 4–34 letters or digits.
 */
import { createHash } from "node:crypto";
import canonicalize from "canonicalize";
import { parse } from "csv-parse/sync";
import { b58encode } from "./base58.ts";
import type { ChainAccount } from "./chain.ts";
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
import { type Ed25519Key, sign } from "./keys.ts";
import { LABEL } from "./label.ts";

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
    payee_ref: createHash("sha256").update(m.salt).update(r.account).digest("hex"),
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

const canonicalBytes = (v: unknown) => Buffer.from(canonicalize(v) ?? "", "utf8");

export function signDirectReceipt(body: DirectReceiptBody, key: Ed25519Key): DirectReceipt {
  const sig = sign(key, canonicalBytes(body));
  return {
    ...body,
    signatures: [{ alg: "ed25519", public_key: key.publicKeyStr, sig: Buffer.from(sig).toString("base64") }],
  };
}

export function directHashB58(r: DirectReceipt): string {
  return b58encode(new Uint8Array(createHash("sha256").update(canonicalBytes(r)).digest()));
}

/** Enough deposit for one anchor or one ed25519 key set; the registry refunds what it doesn't use. */
export const ANCHOR_DEPOSIT = 10_000_000_000_000_000_000_000n; // 0.01 NEAR
/** A key set with an ML-DSA-65 key stores about 2 kB more. */
export const KEYS_DEPOSIT = 50_000_000_000_000_000_000_000n; // 0.05 NEAR

interface KeysView {
  version: number;
  receipt_pk: string;
  mldsa65_pk: string | null;
}

/** Publishes the issuer's receipt key unless it is already the current one; returns the key version. */
export async function ensureIssuerKeys(
  view: <T>(contractId: string, method: string, args?: object) => Promise<T>,
  issuer: ChainAccount,
  registry: string,
  key: Ed25519Key,
): Promise<number> {
  const cur = await view<KeysView | null>(registry, "get_keys", { issuer: issuer.accountId });
  if (cur && cur.receipt_pk === key.publicKeyStr && !cur.mldsa65_pk) return cur.version;
  const r = await issuer.call(
    registry,
    "set_keys",
    { receipt_pk: key.publicKeyStr, mldsa65_pk: null },
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
