/**
 * Checks a receipt file against the chain, in the browser. Everything that decides the verdict comes
 * from outside the file: the escrow and network from this app's config, the key and anchored hash from
 * the escrow's get_batch. Returns each check that ran, in order; it stops early when continuing would
 * mean trusting the file (another escrow) or there is nothing to check against (no such batch).
 */
import { type CheckReport, checkSummaryProblems, isCheckReport } from "@elivo/shared/check-report";
import {
  type DirectReceipt,
  type DirectSignature,
  directTotalsProblems,
  isDirectReceipt,
} from "@elivo/shared/direct-receipt";
import { directHashB58Web, verifyDirectSignaturesWeb } from "@elivo/shared/direct-verify-web";
import type { Receipt, VerifyResult } from "@elivo/shared/receipt";
import { receiptHashB58Web, totalsProblems, verifyReceiptWeb } from "@elivo/shared/receipt-web";
import { viewCall } from "./rpc.ts";

export type CheckId = "format" | "escrow" | "registry" | "signature" | "anchor" | "totals";
export interface Check {
  id: CheckId;
  ok: boolean;
  detail: string;
}
export interface VerifyOutcome {
  /** An escrow batch receipt (elivo-receipt-1). */
  receipt: Receipt | null;
  /** A receipt for payouts made outside the escrow (elivo-direct-receipt-1). */
  direct: DirectReceipt | null;
  /** A check report for a batch, made before paying it (elivo-check-report-1). */
  check?: CheckReport | null;
  checks: Check[];
  ok: boolean;
  hash: string | null;
}

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;

/** The format check's message for a file that is none of the documents /verify accepts. */
export const NOT_A_RECEIPT = "Not an elivo-receipt-1, elivo-direct-receipt-1 or elivo-check-report-1 file";

function parse(input: string): Receipt | null {
  try {
    const r = JSON.parse(input) as Receipt;
    const shaped =
      r &&
      typeof r === "object" &&
      r.version === "elivo-receipt-1" &&
      typeof r.batch_id === "string" &&
      /^\d{1,20}$/.test(r.batch_id) &&
      Array.isArray(r.payouts) &&
      !!r.totals &&
      typeof r.totals === "object" &&
      !!r.signature &&
      typeof r.signature === "object";
    return shaped ? r : null;
  } catch {
    return null;
  }
}

function signatureDetail(v: VerifyResult, filePk: string, chainPk: string, whose: string): string {
  if (v.ok) return `Signed by ${whose} on-chain, ${chainPk}`;
  if (v.reason === "key_mismatch") return `Signed by ${filePk}, but ${whose} on-chain is ${chainPk}`;
  if (v.reason === "bad_signature")
    return "The signature does not match the contents: the file was changed after signing";
  return "No valid signature in the file";
}

export async function verifyAgainstChain(
  input: string,
  app: { escrow: string; network: string; registry?: string | null },
  view: View = viewCall,
): Promise<VerifyOutcome> {
  let json: unknown = null;
  try {
    json = JSON.parse(input);
  } catch {}
  if (isDirectReceipt(json)) return verifyDirect(json, app, view);
  if (isCheckReport(json)) return verifyCheckReport(json, app, view);
  const r = parse(input);
  if (!r)
    return {
      receipt: null,
      direct: null,
      checks: [{ id: "format", ok: false, detail: NOT_A_RECEIPT }],
      ok: false,
      hash: null,
    };
  const checks: Check[] = [];
  const done = (hash: string | null): VerifyOutcome => ({
    receipt: r,
    direct: null,
    checks,
    hash,
    ok: checks.length === 4 && checks.every((c) => c.ok),
  });

  const sameEscrow = r.escrow === app.escrow && r.network === app.network;
  checks.push({
    id: "escrow",
    ok: sameEscrow,
    detail: sameEscrow
      ? `For ${app.escrow} on ${app.network}, the escrow this app uses`
      : `This receipt is for ${r.escrow} on ${r.network}; this app checks ${app.escrow} on ${app.network}`,
  });
  if (!sameEscrow) return done(null);

  let batch: { receipt_pk: string; receipt_hash: string | null } | null;
  try {
    batch = await view(app.escrow, "get_batch", { batch_id: r.batch_id });
  } catch (e) {
    checks.push({ id: "anchor", ok: false, detail: `Could not read the chain: ${(e as Error).message}` });
    return done(null);
  }
  if (!batch) {
    checks.push({ id: "anchor", ok: false, detail: `No batch ${r.batch_id} on ${app.escrow}` });
    return done(null);
  }

  const v = await verifyReceiptWeb(r, batch.receipt_pk);
  checks.push({
    id: "signature",
    ok: v.ok,
    detail: signatureDetail(v, r.signature.public_key, batch.receipt_pk, "the batch's receipt key"),
  });

  const hash = await receiptHashB58Web(r);
  checks.push(
    !batch.receipt_hash
      ? {
          id: "anchor",
          ok: false,
          detail: `Not anchored yet: the escrow has no receipt hash for batch ${r.batch_id}`,
        }
      : batch.receipt_hash === hash
        ? { id: "anchor", ok: true, detail: `Hash ${hash} matches the hash anchored on-chain` }
        : {
            id: "anchor",
            ok: false,
            detail: `Hash ${hash} differs from the hash anchored on-chain, ${batch.receipt_hash}`,
          },
  );

  let problems: string[];
  try {
    problems = totalsProblems(r);
  } catch {
    problems = ["unreadable amounts"];
  }
  checks.push({
    id: "totals",
    ok: problems.length === 0,
    detail:
      problems.length === 0
        ? `Totals add up from the ${r.payouts.length} payout rows`
        : `These totals don't add up from the rows: ${problems.join(", ")}`,
  });
  return done(hash);
}

interface RegistryAnchor {
  receipt_hash: string;
  receipt_pk: string;
  mldsa65_pk: string | null;
  key_version: number;
}

/** A document anchored in the receipt registry: a direct receipt or a check report. */
interface RegistryDocument {
  network: string;
  registry: string;
  issuer: string;
  signatures: DirectSignature[];
}

/**
 * The registry, signature and anchor checks shared by direct receipts and check reports: the registry
 * and network from this app's config, the issuer's keys and the anchored hash from the registry's
 * get_receipt (keyed by the issuer account and the document's id). Then `totals` adds the last check.
 */
async function verifyRegistryDocument(
  r: RegistryDocument,
  doc: { id: string; noun: string; totals: () => Check },
  app: { network: string; registry?: string | null },
  view: View,
): Promise<{ checks: Check[]; hash: string | null; ok: boolean }> {
  const checks: Check[] = [];
  const done = (hash: string | null) => ({
    checks,
    hash,
    ok: checks.length === 4 && checks.every((c) => c.ok),
  });
  const registry = app.registry ?? null;
  const same = !!registry && r.registry === registry && r.network === app.network;
  checks.push({
    id: "registry",
    ok: same,
    detail: !registry
      ? "This app has no receipt registry configured"
      : same
        ? `For ${registry} on ${app.network}, the receipt registry this app uses`
        : `This ${doc.noun} is for ${r.registry} on ${r.network}; this app checks ${registry} on ${app.network}`,
  });
  if (!same || !registry) return done(null);

  let anchor: RegistryAnchor | null;
  try {
    anchor = await view(registry, "get_receipt", { issuer: r.issuer, receipt_id: doc.id });
  } catch (e) {
    checks.push({ id: "anchor", ok: false, detail: `Could not read the chain: ${(e as Error).message}` });
    return done(null);
  }
  if (!anchor) {
    checks.push({
      id: "anchor",
      ok: false,
      detail: `${r.issuer} has anchored no ${doc.noun} "${doc.id}" on ${registry}`,
    });
    return done(null);
  }

  const v = await verifyDirectSignaturesWeb(r, anchor);
  const filePk = r.signatures.find((s) => s?.alg === "ed25519")?.public_key ?? "no key";
  checks.push({
    id: "signature",
    ok: v.ok,
    detail:
      v.ok && anchor.mldsa65_pk
        ? `Signed twice, by ${r.issuer}'s keys on-chain (version ${anchor.key_version}): ed25519 ${anchor.receipt_pk} and ML-DSA-65 (FIPS 204, post-quantum)`
        : signatureDetail(
            v,
            filePk,
            anchor.receipt_pk,
            `${r.issuer}'s receipt key (version ${anchor.key_version})`,
          ),
  });

  const hash = await directHashB58Web(r);
  checks.push(
    anchor.receipt_hash === hash
      ? { id: "anchor", ok: true, detail: `Hash ${hash} matches the hash ${r.issuer} anchored on-chain` }
      : {
          id: "anchor",
          ok: false,
          detail: `Hash ${hash} differs from the hash anchored on-chain, ${anchor.receipt_hash}`,
        },
  );
  checks.push(doc.totals());
  return done(hash);
}

/** A direct receipt, keyed in the registry by its receipt id. */
async function verifyDirect(
  r: DirectReceipt,
  app: { network: string; registry?: string | null },
  view: View,
): Promise<VerifyOutcome> {
  const out = await verifyRegistryDocument(
    r,
    {
      id: r.receipt_id,
      noun: "receipt",
      totals: () => {
        const problems = directTotalsProblems(r);
        return {
          id: "totals",
          ok: problems.length === 0,
          detail:
            problems.length === 0
              ? `Totals add up from the ${r.payouts.length} payout rows`
              : `These totals don't add up from the rows: ${problems.join(", ")}`,
        };
      },
    },
    app,
    view,
  );
  return { receipt: null, direct: r, check: null, ...out };
}

/** A check report, keyed in the registry by its report id. */
async function verifyCheckReport(
  r: CheckReport,
  app: { network: string; registry?: string | null },
  view: View,
): Promise<VerifyOutcome> {
  const out = await verifyRegistryDocument(
    r,
    {
      id: r.report_id,
      noun: "check report",
      totals: () => {
        const problems = checkSummaryProblems(r);
        return {
          id: "totals",
          ok: problems.length === 0,
          detail:
            problems.length === 0
              ? `The summary adds up from the ${r.rows.length} rows' findings`
              : `These summary counts don't add up from the rows: ${problems.join(", ")}`,
        };
      },
    },
    app,
    view,
  );
  return { receipt: null, direct: null, check: r, ...out };
}
