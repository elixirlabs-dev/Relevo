/**
 * `elivo-direct-receipt-1`: a signed receipt for payouts an issuer made itself, outside the escrow, on
 * any rail (SPEI, SEPA, ...). Its hash is anchored in the receipt registry contract under the issuer's
 * account, together with the issuer's keys at that moment. Browser-safe: types, shape and totals only.
 *
 * Signatures: one ed25519 signature, plus an ML-DSA-65 signature when the issuer has published a
 * post-quantum key. All signatures cover the same bytes: the RFC 8785 canonical JSON of the receipt
 * without its `signatures` field.
 */

export const DIRECT_VERSION = "elivo-direct-receipt-1";
export const RECEIPT_ID = /^[A-Za-z0-9._-]{1,64}$/;
/** Amounts in a direct receipt: decimal strings with exactly two places. */
export const AMOUNT_2DP = /^\d{1,15}\.\d{2}$/;

export type DirectStatus = "Paid" | "Returned" | "Failed";

export interface DirectPayout {
  id: number;
  /** sha256(salt ‖ account) in hex; the salt stays with the issuer. */
  payee_ref: string;
  account_last4: string;
  amount: string;
  status: DirectStatus;
  /** ISO 8601 UTC, for a Paid payout. */
  paid_at: string | null;
  /** The rail's own reference (for SPEI, the tracking key), or the reason a payout was not made. */
  reference: string | null;
}

export interface DirectTotals {
  count: number;
  paid: string;
  not_paid: string;
}

export interface DirectReceiptBody {
  version: typeof DIRECT_VERSION;
  label: string;
  network: string;
  registry: string;
  issuer: string;
  receipt_id: string;
  generated_at: string;
  rail: string;
  currency: string;
  payouts: DirectPayout[];
  totals: DirectTotals;
}

export type SignatureAlg = "ed25519" | "ml-dsa-65";

export interface DirectSignature {
  alg: SignatureAlg;
  /** "ed25519:<base58>" for ed25519; base64 of the 1,952-byte key for ML-DSA-65. */
  public_key: string;
  /** base64 */
  sig: string;
}

export interface DirectReceipt extends DirectReceiptBody {
  signatures: DirectSignature[];
}

const cents = (s: string) => {
  if (!AMOUNT_2DP.test(s)) throw new Error(`bad amount ${s}`);
  return BigInt(s.replace(".", ""));
};
const fromCents = (c: bigint) => `${c / 100n}.${(c % 100n).toString().padStart(2, "0")}`;

export function directTotals(payouts: DirectPayout[]): DirectTotals {
  let paid = 0n;
  let notPaid = 0n;
  for (const p of payouts) {
    if (p.status === "Paid") paid += cents(p.amount);
    else notPaid += cents(p.amount);
  }
  return { count: payouts.length, paid: fromCents(paid), not_paid: fromCents(notPaid) };
}

/** Names of the totals that don't add up from the rows (empty when all do). */
export function directTotalsProblems(r: DirectReceiptBody): string[] {
  let want: DirectTotals;
  try {
    want = directTotals(r.payouts);
  } catch {
    return ["unreadable amounts"];
  }
  return (Object.keys(want) as Array<keyof DirectTotals>).filter((k) => r.totals?.[k] !== want[k]);
}

export function isDirectReceipt(v: unknown): v is DirectReceipt {
  const r = v as DirectReceipt | null;
  return (
    !!r &&
    typeof r === "object" &&
    r.version === DIRECT_VERSION &&
    typeof r.registry === "string" &&
    typeof r.issuer === "string" &&
    typeof r.receipt_id === "string" &&
    RECEIPT_ID.test(r.receipt_id) &&
    Array.isArray(r.payouts) &&
    !!r.totals &&
    typeof r.totals === "object" &&
    Array.isArray(r.signatures)
  );
}
