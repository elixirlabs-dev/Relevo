/**
 * Receipt → CSV for accounting tools: one row per payout, plain decimals (USDC with 6 places), ISO 8601
 * UTC times, and the batch id and receipt hash on every row. RFC 4180 quoting, CRLF line endings, and
 * a leading ' on cells a spreadsheet would treat as a formula. Browser-safe.
 */
import type { DirectReceipt } from "./direct-receipt.ts";
import type { Receipt } from "./receipt.ts";

export const CSV_COLUMNS = [
  "batch_id",
  "network",
  "escrow",
  "receipt_hash",
  "payout_id",
  "state",
  "amount_usdc",
  "fee_usdc",
  "penalty_usdc",
  "amount_mxn",
  "payee_ref",
  "clabe_last4",
  "final_firm",
  "firms_tried",
  "delivered_at",
  "reason",
  "proof_ref",
  "tx_hashes",
] as const;

/** USDC base units → "1000.000000". */
function usdc(units: bigint): string {
  const whole = units / 1_000_000n;
  const frac = (units % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

function iso(ns: string | null): string {
  return ns ? new Date(Number(BigInt(ns) / 1_000_000n)).toISOString() : "";
}

function cell(v: string): string {
  const safe = /^[=+\-@]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function receiptToCsv(r: Receipt, receiptHash: string): string {
  const rows = r.payouts.map((p) => {
    const amount = BigInt(p.amount_usdc);
    const fee = p.state === "Delivered" ? (amount * BigInt(p.quote_bps)) / 10_000n : 0n;
    const txs = Object.entries(p.txs ?? {}).flatMap(([kind, hashes]) => hashes.map((h) => `${kind}:${h}`));
    const row: Record<(typeof CSV_COLUMNS)[number], string> = {
      batch_id: r.batch_id,
      network: r.network,
      escrow: r.escrow,
      receipt_hash: receiptHash,
      payout_id: String(p.id),
      state: p.state,
      amount_usdc: usdc(amount),
      fee_usdc: usdc(fee),
      penalty_usdc: usdc(BigInt(p.penalties_total)),
      amount_mxn: p.amount_mxn,
      payee_ref: p.payee_ref,
      clabe_last4: p.clabe_last4,
      final_firm: p.final_firm ?? "",
      firms_tried: p.firms_tried.join(" > "),
      delivered_at: iso(p.delivered_at_ns),
      reason: p.reason ?? "",
      proof_ref: p.proof_ref ?? "",
      tx_hashes: txs.join(" "),
    };
    return CSV_COLUMNS.map((c) => cell(row[c])).join(",");
  });
  return `${[CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}

export const DIRECT_CSV_COLUMNS = [
  "issuer",
  "receipt_id",
  "network",
  "registry",
  "receipt_hash",
  "payout_id",
  "status",
  "amount",
  "currency",
  "rail",
  "payee_ref",
  "account_last4",
  "paid_at",
  "reference",
] as const;

/**
 * A direct receipt (payouts made outside the escrow; v1 or v2, same columns) → CSV, one row per payout,
 * same rules as above.
 */
export function directReceiptToCsv(
  r: Pick<DirectReceipt, "issuer" | "receipt_id" | "network" | "registry" | "currency" | "rail" | "payouts">,
  receiptHash: string,
): string {
  const rows = r.payouts.map((p) => {
    const row: Record<(typeof DIRECT_CSV_COLUMNS)[number], string> = {
      issuer: r.issuer,
      receipt_id: r.receipt_id,
      network: r.network,
      registry: r.registry,
      receipt_hash: receiptHash,
      payout_id: String(p.id),
      status: p.status,
      amount: p.amount,
      currency: r.currency,
      rail: r.rail,
      payee_ref: p.payee_ref,
      account_last4: p.account_last4,
      paid_at: p.paid_at ?? "",
      reference: p.reference ?? "",
    };
    return DIRECT_CSV_COLUMNS.map((c) => cell(row[c])).join(",");
  });
  return `${[DIRECT_CSV_COLUMNS.join(","), ...rows].join("\r\n")}\r\n`;
}
