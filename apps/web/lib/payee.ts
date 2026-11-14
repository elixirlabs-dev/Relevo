/**
 * Payee links: `/payee#p=<base64url(deflate-raw(payee proof JSON))>`. One payee's `elivo-payee-proof-1`
 * (the signed receipt header, their payout, its Merkle path and their payee_salt) travels in the URL
 * fragment, which browsers never send to a server. The proof carries that payee's salt, so whoever holds
 * the link can test guesses of their account against payee_ref: treat it like a payslip.
 *
 * Verifying a proof: the registry and network from this app's config, the issuer's keys and the anchored
 * hash from the registry's get_receipt, never from the link. Then the Merkle path, run locally, shows the
 * payout is one of the payouts the issuer signed.
 */
import {
  directV2HashB58Web,
  isPayeeProof,
  type PayeeProof,
  verifyDirectV2SignaturesWeb,
  verifyPayeeProofStructure,
} from "@elivo/shared/direct-receipt-v2";
import { viewCall } from "./rpc.ts";
import { decodeFragment, encodeShare } from "./share.ts";
import { type Check, verifyRegistryDocument } from "./verify.ts";

const PREFIX = "#p=";

export async function payeeLink(origin: string, proof: PayeeProof): Promise<string> {
  return `${origin}/payee${PREFIX}${await encodeShare(JSON.stringify(proof))}`;
}

/** The payee proof carried by a `#p=` fragment (or a bare payload), or null for anything else. */
export async function decodePayeeLink(fragment: string): Promise<PayeeProof | null> {
  const text = await decodeFragment(fragment, PREFIX);
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isPayeeProof(v) ? v : null;
  } catch {
    return null;
  }
}

export type PayeeCheckId = "registry" | "signature" | "anchor" | "merkle";
export interface PayeeCheck {
  id: PayeeCheckId;
  ok: boolean;
  /** Technical detail, in English. */
  detail: string;
}
export interface PayeeOutcome {
  checks: PayeeCheck[];
  ok: boolean;
  /** The anchored hash of the receipt header, once the chain had one to compare. */
  hash: string | null;
  /** When the registry anchored the receipt (ISO 8601, UTC), from the chain. */
  anchoredAt: string | null;
}

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;

const nsToIso = (ns: string | undefined): string | null => {
  if (!ns || !/^\d{1,20}$/.test(ns)) return null;
  const d = new Date(Number(BigInt(ns) / 1_000_000n));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Registry, signature and anchor checks against the chain, then the Merkle path. The path is checked
 * even when the chain checks stop early, so a changed payout always shows.
 */
export async function verifyPayeeProof(
  p: PayeeProof,
  app: { network: string; registry?: string | null },
  view: View = viewCall,
): Promise<PayeeOutcome> {
  const problems = verifyPayeeProofStructure(p);
  const n = p.header.payout_count;
  const merkle: Check = {
    id: "totals",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `Payout ${p.proof.index + 1} of ${n}: its Merkle path leads to the payouts root ${p.header.issuer} signed`
        : `This payout is not one the issuer signed: ${problems.join(", ")}`,
  };
  const out = await verifyRegistryDocument(
    p.header,
    {
      id: p.header.receipt_id,
      noun: "receipt",
      totals: () => merkle,
      hash: directV2HashB58Web,
      signatures: verifyDirectV2SignaturesWeb,
    },
    app,
    view,
  );
  const checks: PayeeCheck[] = out.checks.map((c) =>
    c.id === "totals" ? { ...c, id: "merkle" } : { ...c, id: c.id as PayeeCheckId },
  );
  if (!checks.some((c) => c.id === "merkle")) checks.push({ ...merkle, id: "merkle" });
  return { checks, ok: out.ok, hash: out.hash, anchoredAt: nsToIso(out.anchor?.anchored_at_ns) };
}
