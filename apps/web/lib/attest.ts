/**
 * Attestations on the receipt registry: an account records that it checked a receipt. The transaction
 * /verify sends, the DAO roles that label an attester, and the contract's errors in plain words.
 */
import { ATTEST_DEPOSIT } from "@elivo/shared/direct-receipt";
import type { TxSpec } from "./txs.ts";

const TGAS = 1_000_000_000_000n;

/** One entry of the registry's get_attestations, in attestation order. */
export interface Attestation {
  attester: string;
  /** U64 as a JSON string */
  attested_at_ns: string;
}

/** sessionStorage key for an attest sent from this tab, so a wallet that reloads the page is picked up. */
export const ATTEST_PENDING_KEY = "elivo-attest-pending";
export interface PendingAttest {
  issuer: string;
  receipt_id: string;
  account: string;
}

export function attestTx(p: { registry: string; issuer: string; receiptId: string; hash: string }): TxSpec {
  return {
    receiverId: p.registry,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "attest",
          args: { issuer: p.issuer, receipt_id: p.receiptId, receipt_hash: p.hash },
          gas: (30n * TGAS).toString(),
          deposit: ATTEST_DEPOSIT.toString(),
        },
      },
    ],
  };
}

/** The names of the Sputnik DAO policy roles whose `kind.Group` holds the account. */
export function daoRoles(policy: unknown, account: string): string[] {
  const roles = (policy as { roles?: unknown } | null)?.roles;
  if (!Array.isArray(roles)) return [];
  const out: string[] = [];
  for (const r of roles) {
    const role = r as { name?: unknown; kind?: { Group?: unknown } } | null;
    const group = role && typeof role.kind === "object" ? role.kind?.Group : null;
    if (typeof role?.name === "string" && Array.isArray(group) && group.includes(account))
      out.push(role.name);
  }
  return out;
}

const ERROR_WORDS: Array<[string, string]> = [
  ["already_attested", "You've already attested this receipt."],
  ["hash_mismatch", "This file doesn't match the anchored receipt."],
  ["not_anchored", "This receipt is not anchored in the registry, so it can't be attested."],
  ["too_many_attestations", "This receipt already has the most attestations the registry keeps (100)."],
];

/** A wallet or contract error as one plain sentence. */
export function attestErrorWords(e: unknown): string {
  const msg = (e as Error)?.message ?? String(e ?? "");
  for (const [code, words] of ERROR_WORDS) if (msg.includes(code)) return words;
  return msg || "The transaction did not go through.";
}

export function readPendingAttest(storage: Storage | null): PendingAttest | null {
  try {
    const raw = storage?.getItem(ATTEST_PENDING_KEY);
    const p = raw ? (JSON.parse(raw) as PendingAttest) : null;
    return p &&
      typeof p.issuer === "string" &&
      typeof p.receipt_id === "string" &&
      typeof p.account === "string"
      ? p
      : null;
  } catch {
    return null;
  }
}

export function writePendingAttest(storage: Storage | null, p: PendingAttest | null): void {
  try {
    if (p) storage?.setItem(ATTEST_PENDING_KEY, JSON.stringify(p));
    else storage?.removeItem(ATTEST_PENDING_KEY);
  } catch {}
}
