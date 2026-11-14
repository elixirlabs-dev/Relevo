/**
 * "Your receipts": the v2 receipts issued from this browser, with what only this browser knows about
 * them: the payees' names and full accounts, and the secret receipt salt that makes payee links. Kept in
 * this browser's localStorage under `elivo-issued:<account>`, nowhere else; nothing here is ever sent.
 * The payout search ("where is my money?") runs over it locally.
 */
import { type DirectReceiptV2, type PayeeProof, payeeProof } from "@elivo/shared/direct-receipt-v2";
import { normaliseName } from "@elivo/shared/payout-check";
import { isPendingIssue } from "./issue.ts";

export interface IssuedReceipt {
  receipt_id: string;
  /** the anchored hash */
  hash: string;
  receipt: DirectReceiptV2;
  /** hex; secret */
  receiptSaltHex: string;
  /** In payout order. */
  names: string[];
  accounts: string[];
}

export interface PayoutMatch {
  receipt_id: string;
  /** 0-based payout index (show it as index + 1) */
  index: number;
  name: string;
  amount: string;
  status: string;
}

const key = (account: string) => `elivo-issued:${account}`;

const isIssued = (v: unknown): v is IssuedReceipt =>
  isPendingIssue(v) &&
  typeof (v as Partial<IssuedReceipt>).receipt_id === "string" &&
  typeof (v as Partial<IssuedReceipt>).hash === "string" &&
  (v as IssuedReceipt).receipt.receipt_id === (v as IssuedReceipt).receipt_id;

/** The receipts issued from this browser for `account`, newest first. */
export function listIssued(account: string, storage: Storage | null): IssuedReceipt[] {
  try {
    const raw = storage?.getItem(key(account));
    const v = raw ? JSON.parse(raw) : [];
    return Array.isArray(v) ? v.filter(isIssued) : [];
  } catch {
    return [];
  }
}

/** Keeps an anchored receipt in this browser (replacing one saved under the same id). */
export function saveIssued(account: string, issued: IssuedReceipt, storage: Storage | null) {
  const rest = listIssued(account, storage).filter((r) => r.receipt_id !== issued.receipt_id);
  try {
    storage?.setItem(key(account), JSON.stringify([issued, ...rest]));
  } catch {}
}

const compact = (s: string) => s.replace(/\s+/g, "");

/**
 * The payouts in this browser's receipts for a payee: `query` is a name (accents, case and spaces don't
 * matter) or a full account number. Newest receipt first, payouts in order.
 */
export function findPayout(account: string, query: string, storage: Storage | null): PayoutMatch[] {
  const name = normaliseName(query);
  const acct = compact(query);
  if (!name) return [];
  const out: PayoutMatch[] = [];
  for (const r of listIssued(account, storage))
    r.receipt.payouts.forEach((p, i) => {
      if (normaliseName(r.names[i]) === name || r.accounts[i] === acct)
        out.push({
          receipt_id: r.receipt_id,
          index: i,
          name: r.names[i],
          amount: p.amount,
          status: p.status,
        });
    });
  return out;
}

const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));

/** One payee's proof, made from the stored receipt and its salt. */
export function payeeProofFor(r: IssuedReceipt, index: number): PayeeProof {
  return payeeProof(r.receipt, index, unhex(r.receiptSaltHex));
}
