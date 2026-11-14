/**
 * "Your receipts": the v2 receipts issued from this browser, with what only this browser knows about
 * them: the payees' names and full accounts, and the secret receipt salt that makes payee links. Kept in
 * this browser's localStorage under `elivo-issued:<account>`, nowhere else; nothing here is ever sent.
 * The payout search ("where is my money?") runs over it locally.
 */
import { type DirectReceiptV2, type PayeeProof, payeeProof } from "@elivo/shared/direct-receipt-v2";
import { normaliseName } from "@elivo/shared/payout-check";
import { hexToBytes } from "@noble/hashes/utils.js";
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

/** The most receipts kept per account; older ones are dropped when a new one is saved. */
export const MAX_ISSUED = 50;

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

/**
 * Keeps an anchored receipt in this browser, newest first, replacing one saved under the same id and
 * keeping at most MAX_ISSUED receipts. Entries this version doesn't recognise are carried over as they
 * are. Returns false when the browser didn't keep it (storage blocked or full, or holding something
 * unreadable that it won't overwrite): the caller must not drop its own copy of the salt then.
 */
export function saveIssued(account: string, issued: IssuedReceipt, storage: Storage | null): boolean {
  if (!storage) return false;
  try {
    const raw = storage.getItem(key(account));
    const stored: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(stored)) return false;
    const known = stored.filter(isIssued).filter((r) => r.receipt_id !== issued.receipt_id);
    const unknown = stored.filter((v) => !isIssued(v));
    const next = [issued, ...known.slice(0, MAX_ISSUED - 1), ...unknown];
    storage.setItem(key(account), JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
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

/** One payee's proof, made from the stored receipt and its salt. */
export function payeeProofFor(r: IssuedReceipt, index: number): PayeeProof {
  return payeeProof(r.receipt, index, hexToBytes(r.receiptSaltHex));
}
