/**
 * `elivo-check-report-1`: a signed record of the pre-payout checks an issuer ran on a planned batch,
 * before any money moved. Its hash is anchored in the receipt registry under the issuer's account with
 * `anchor(receipt_id = report_id, receipt_hash)`, so anyone can later see that the batch was checked,
 * when, and what the checks found. Browser-safe.
 *
 * Signed exactly like a direct receipt (direct-build.ts): ed25519, plus ML-DSA-65 when chosen, over the
 * RFC 8785 canonical JSON of the report without `signatures`. Payees appear only as a salted hash of the
 * account and its last 4 digits; names never enter the report.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { directHashB58Sync, signDirectReceiptWeb } from "./direct-build.ts";
import { AMOUNT_2DP, type DirectSignature } from "./direct-receipt.ts";
import { LABEL } from "./label.ts";
import type { CheckCode, CheckLevel, CheckResult, PlannedRow } from "./payout-check.ts";
import type { MlDsaKey } from "./pq-keys.ts";

export const CHECK_VERSION = "elivo-check-report-1";
export const CHECK_ENGINE = "elivo-check-1";
/** `check-YYYYMMDD-HHMMSS`, the UTC time of the check. */
export const CHECK_REPORT_ID = /^check-\d{8}-\d{6}$/;

/** The level of every finding the engine can report, so a verifier can recompute the summary. */
export const CHECK_LEVELS: Record<CheckCode, CheckLevel> = {
  missing_name: "block",
  bad_amount: "block",
  clabe_length: "block",
  clabe_non_digit: "block",
  clabe_check_digit: "block",
  bad_account: "block",
  unknown_bank: "warn",
  duplicate_account: "warn",
  name_multiple_accounts: "warn",
  amount_outlier: "warn",
  account_changed: "warn",
};

export interface CheckReportRow {
  id: number;
  /** sha256(salt ‖ account) in hex, as in direct receipts; the salt stays with the issuer. */
  payee_ref: string;
  account_last4: string;
  bank: string | null;
  amount: string;
  findings: CheckCode[];
}

export interface CheckSummary {
  rows: number;
  blocked: number;
  warned: number;
  clean: number;
}

export interface CheckReportBody {
  version: typeof CHECK_VERSION;
  label: string;
  network: string;
  registry: string;
  issuer: string;
  report_id: string;
  checked_at: string;
  rail: string;
  engine: typeof CHECK_ENGINE;
  rows: CheckReportRow[];
  summary: CheckSummary;
}

export interface CheckReport extends CheckReportBody {
  signatures: DirectSignature[];
}

export interface CheckMeta {
  network: string;
  registry: string;
  issuer: string;
  report_id: string;
  /** Per-report salt for payee_ref. */
  salt: Uint8Array;
  checked_at?: string;
}

/** The report id for a check run at `iso` (UTC). */
export function checkReportId(iso: string): string {
  return `check-${iso.slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`;
}

export function checkSummary(rows: Array<{ findings: CheckCode[] }>): CheckSummary {
  const blocked = rows.filter((r) => r.findings.some((c) => CHECK_LEVELS[c] === "block")).length;
  const clean = rows.filter((r) => r.findings.length === 0).length;
  return { rows: rows.length, blocked, warned: rows.length - blocked - clean, clean };
}

/** Builds the report for a batch that passed (no blocked rows). `rows` are the rows `result` checked. */
export function buildCheckReport(result: CheckResult, rows: PlannedRow[], m: CheckMeta): CheckReportBody {
  if (!CHECK_REPORT_ID.test(m.report_id)) throw new Error("report id: check-YYYYMMDD-HHMMSS");
  if (rows.length === 0) throw new Error("no rows");
  if (rows.length !== result.rows.length || rows.some((r, i) => r.row !== result.rows[i]?.row))
    throw new Error("the rows are not the ones that were checked");
  if (!result.ok) throw new Error("the batch has blocked rows");
  const out: CheckReportRow[] = result.rows.map((c, id) => ({
    id,
    payee_ref: bytesToHex(sha256(concatBytes(m.salt, new TextEncoder().encode(rows[id]?.account ?? "")))),
    account_last4: c.account_last4,
    bank: c.bank,
    amount: c.amount,
    findings: c.findings.map((f) => f.code),
  }));
  return {
    version: CHECK_VERSION,
    label: LABEL,
    network: m.network,
    registry: m.registry,
    issuer: m.issuer,
    report_id: m.report_id,
    checked_at: m.checked_at ?? new Date().toISOString(),
    rail: result.rail.toUpperCase(),
    engine: CHECK_ENGINE,
    rows: out,
    summary: checkSummary(out),
  };
}

export function signCheckReport(body: CheckReportBody, edSeed: Uint8Array, pq?: MlDsaKey): CheckReport {
  return signDirectReceiptWeb(body, edSeed, pq);
}

/** base58(sha256(canonical JSON of the whole signed report)): the hash the registry anchors. */
export function checkReportHashB58(r: CheckReport): string {
  return directHashB58Sync(r);
}

/** Names of the summary counts that don't add up from the rows' findings (empty when all do). */
export function checkSummaryProblems(r: CheckReportBody): string[] {
  const want = checkSummary(r.rows);
  return (Object.keys(want) as Array<keyof CheckSummary>).filter((k) => r.summary?.[k] !== want[k]);
}

const count = (v: unknown) => Number.isInteger(v) && (v as number) >= 0;

function isRow(v: unknown): v is CheckReportRow {
  const x = v as CheckReportRow | null;
  return (
    !!x &&
    typeof x === "object" &&
    count(x.id) &&
    typeof x.payee_ref === "string" &&
    /^[0-9a-f]{64}$/.test(x.payee_ref) &&
    typeof x.account_last4 === "string" &&
    (x.bank === null || typeof x.bank === "string") &&
    typeof x.amount === "string" &&
    AMOUNT_2DP.test(x.amount) &&
    Array.isArray(x.findings) &&
    x.findings.every((c) => typeof c === "string" && Object.hasOwn(CHECK_LEVELS, c))
  );
}

const isSignature = (v: unknown) => {
  const x = v as DirectSignature | null;
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.alg === "string" &&
    typeof x.public_key === "string" &&
    typeof x.sig === "string"
  );
};

/** Shape check: every field a verifier or the report page reads has the type it expects. */
export function isCheckReport(v: unknown): v is CheckReport {
  const r = v as CheckReport | null;
  const s = r?.summary;
  return (
    !!r &&
    typeof r === "object" &&
    r.version === CHECK_VERSION &&
    typeof r.label === "string" &&
    typeof r.network === "string" &&
    typeof r.registry === "string" &&
    typeof r.issuer === "string" &&
    typeof r.report_id === "string" &&
    CHECK_REPORT_ID.test(r.report_id) &&
    typeof r.checked_at === "string" &&
    typeof r.rail === "string" &&
    r.engine === CHECK_ENGINE &&
    Array.isArray(r.rows) &&
    r.rows.every(isRow) &&
    !!s &&
    typeof s === "object" &&
    count(s.rows) &&
    count(s.blocked) &&
    count(s.warned) &&
    count(s.clean) &&
    Array.isArray(r.signatures) &&
    r.signatures.every(isSignature)
  );
}
