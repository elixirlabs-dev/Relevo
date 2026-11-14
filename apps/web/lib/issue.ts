/**
 * "Issue a receipt": everything the /issue page does before and after the wallet signs. The browser
 * parses the payout results, signs an elivo-direct-receipt-2 with the visitor's own receipt keys
 * (ed25519, plus ML-DSA-65 if chosen), and builds one transaction to the registry: publish the keys if
 * they changed, then anchor the receipt. The receipt points at the last check this browser anchored
 * (`check_ref`), unless told not to. Names, account numbers and the receipt salt never leave the browser.
 */

import { CHECK_REPORT_ID } from "@elivo/shared/check-report";
import { parseResultsCsv } from "@elivo/shared/direct-build";
import { RECEIPT_ID } from "@elivo/shared/direct-receipt";
import {
  buildDirectReceiptV2,
  type CheckRef,
  type DirectReceiptV2,
  directV2HashB58,
  isDirectReceiptV2,
  signDirectReceiptV2,
} from "@elivo/shared/direct-receipt-v2";
import { bytesToHex } from "@noble/hashes/utils.js";
import { lastAnchoredCheck } from "./check.ts";
import { issuerKeys, publishKeysThenAnchorTx } from "./issuer.ts";
import type { TxSpec } from "./txs.ts";

export { type IssuerKeys, issuerKeys } from "./issuer.ts";

export const SAMPLE_RESULTS_CSV = `name,account,amount,status,paid_at,reference
Lucía Fernández,002010077777777771,37000.00,paid,2026-11-14T15:02:11Z,SIM-SPEI-20261114-0001
Mateo Ríos,032180000118359719,37000.00,paid,2026-11-14T15:02:40Z,SIM-SPEI-20261114-0002
Sofía Herrera,012180001234567899,27750.00,returned,,ACCOUNT_CLOSED
Diego Navarro,072180009876543213,46250.00,paid,2026-11-14T15:03:05Z,SIM-SPEI-20261114-0004
Valentina Cruz,646180005555555554,18500.00,paid,2026-11-14T15:03:31Z,SIM-SPEI-20261114-0005
`;

/**
 * Where the signed receipt waits while the wallet signs (a wallet may reload the page), with its secret
 * salt and the payees' names and accounts, so the payee links can still be made afterwards.
 */
export const PENDING_KEY = "elivo-pending-receipt";

export interface IssueInput {
  csv: string;
  rail: string;
  currency: string;
  receiptId: string;
  account: string;
  registry: string;
  network: string;
  postQuantum: boolean;
  /** The account's current key set in the registry (get_keys), or null if it has none. */
  currentKeys: { receipt_pk: string; mldsa65_pk: string | null } | null;
  /**
   * The check made before paying. Left out: the last check this browser anchored for the account (if
   * any). null: link no check.
   */
  checkRef?: CheckRef | null;
}

/** A signed receipt waiting for its anchor, with what only this browser knows about it. */
export interface PendingIssue {
  receipt: DirectReceiptV2;
  /** hex; secret: whoever has it can tell which account each payee_ref belongs to */
  receiptSaltHex: string;
  /** In payout order. */
  names: string[];
  accounts: string[];
}

export type Prepared =
  | { ok: true; receipt: DirectReceiptV2; hash: string; tx: TxSpec; pending: PendingIssue }
  | { ok: false; errors: string[] };

/** The check a new receipt should point at: the one given, else the last one anchored from here. */
function checkRefFor(input: IssueInput, storage: Storage | null): CheckRef | null {
  if (input.checkRef !== undefined) return input.checkRef;
  const last = lastAnchoredCheck(input.account, storage);
  return last ? { report_id: last.report_id, report_hash: last.hash } : null;
}

export function prepareIssue(input: IssueInput, storage: Storage | null): Prepared {
  const errors: string[] = [];
  if (!RECEIPT_ID.test(input.receiptId))
    errors.push("Receipt id: 1 to 64 letters, digits, dots, dashes or underscores");
  else if (CHECK_REPORT_ID.test(input.receiptId))
    errors.push("Receipt id: check-YYYYMMDD-HHMMSS is kept for check reports; choose another id");
  if (!/^[A-Z]{3}$/.test(input.currency)) errors.push("Currency: a 3-letter code such as MXN");
  const parsed = parseResultsCsv(input.csv, { rail: input.rail });
  for (const e of parsed.errors) errors.push(e.row ? `Row ${e.row}: ${e.reason}` : e.reason);
  if (!errors.length && parsed.rows.length === 0) errors.push("No payouts in the CSV");
  if (errors.length) return { ok: false, errors };

  const keys = issuerKeys(input.account, storage);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const receipt = signDirectReceiptV2(
    buildDirectReceiptV2(parsed.rows, {
      network: input.network,
      registry: input.registry,
      issuer: input.account,
      receipt_id: input.receiptId,
      rail: input.rail,
      currency: input.currency,
      salt,
      check_ref: checkRefFor(input, storage),
    }),
    keys.edSeed,
    input.postQuantum ? keys.pq : undefined,
  );
  const hash = directV2HashB58(receipt);
  const tx = publishKeysThenAnchorTx({
    registry: input.registry,
    keys,
    postQuantum: input.postQuantum,
    currentKeys: input.currentKeys,
    id: input.receiptId,
    hash,
  });
  const pending: PendingIssue = {
    receipt,
    receiptSaltHex: bytesToHex(salt),
    names: parsed.rows.map((r) => r.name),
    accounts: parsed.rows.map((r) => r.account),
  };
  return { ok: true, receipt, hash, tx, pending };
}

const strings = (v: unknown, n: number): v is string[] =>
  Array.isArray(v) && v.length === n && v.every((x) => typeof x === "string");

/** True when `v` is a v2 receipt with a salt and one name and account per payout. */
export function isPendingIssue(v: unknown): v is PendingIssue {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  if (!isDirectReceiptV2(p.receipt)) return false;
  const n = p.receipt.payouts.length;
  return (
    typeof p.receiptSaltHex === "string" &&
    /^[0-9a-f]{32}$/.test(p.receiptSaltHex) &&
    strings(p.names, n) &&
    strings(p.accounts, n)
  );
}

/** The receipt waiting for its anchor transaction, if any. */
export function readPending(storage: Storage | null): PendingIssue | null {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return isPendingIssue(v) ? v : null;
  } catch {
    return null;
  }
}
