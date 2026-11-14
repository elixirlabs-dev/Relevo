/**
 * "Check a batch before paying": everything the /check page does around the wallet. The browser runs the
 * pre-payout checks on the planned CSV, signs a check report with the visitor's receipt keys (the same
 * keys /issue uses) and builds one transaction to the registry: publish the keys if they changed, then
 * anchor the report. Names and account numbers never leave the browser: the report keeps a salted hash
 * and the last 4 digits, and the account history used for `account_changed` stays in localStorage.
 */
import {
  buildCheckReport,
  type CheckReport,
  checkReportHashB58,
  checkReportId,
  isCheckReport,
  signCheckReport,
} from "@elivo/shared/check-report";
import { ANCHOR_DEPOSIT, KEYS_DEPOSIT } from "@elivo/shared/direct-receipt";
import {
  type CheckCode,
  type CheckResult,
  checkBatch,
  normaliseName,
  type PlannedRow,
  parsePlannedCsv,
} from "@elivo/shared/payout-check";
import { issuerKeys } from "./issue.ts";
import type { FunctionCallSpec, TxSpec } from "./txs.ts";

/** The five invented payouts /issue starts with, as a planned batch: passes every check. */
export const SAMPLE_PLANNED_CSV = `name,account,amount
Lucía Fernández,002010077777777771,37000.00
Mateo Ríos,032180000118359719,37000.00
Sofía Herrera,012180001234567899,27750.00
Diego Navarro,072180009876543213,46250.00
Valentina Cruz,646180005555555554,18500.00
`;

/**
 * The same invented payees with one problem of each kind: Mateo's first row uses Lucía's account
 * (duplicate account, and a name with two accounts), Diego's amount is ten times the usual, Valentina's
 * CLABE has a typo, and Sofía's account is at a bank code outside the list and differs from last time.
 */
export const SAMPLE_PROBLEMS_CSV = `name,account,amount
Lucía Fernández,002010077777777771,37000.00
Mateo Ríos,002010077777777771,37000.00
Mateo Ríos,032180000118359719,37000.00
Diego Navarro,072180009876543213,462500.00
Valentina Cruz,646180005555555555,18500.00
Sofía Herrera,990180002222333347,27750.00
`;

/** An invented "last time" for the sample with problems, so the account-change check has a comparison. */
export const SAMPLE_PROBLEMS_HISTORY: Record<string, string> = { "sofia herrera": "012180001234567899" };

/** Short words for each finding, shown on its chip next to "Block" or "Warning". */
export const FINDING_WORDS: Record<CheckCode, string> = {
  missing_name: "no name",
  bad_amount: "bad amount",
  clabe_length: "CLABE length",
  clabe_non_digit: "CLABE not digits",
  clabe_check_digit: "CLABE check digit",
  bad_account: "bad account",
  unknown_bank: "unknown bank",
  duplicate_account: "duplicate account",
  name_multiple_accounts: "name with two accounts",
  amount_outlier: "unusual amount",
  account_changed: "account changed",
};

/** Where the signed report waits while the wallet signs (a wallet may reload the page). */
export const PENDING_CHECK_KEY = "elivo-pending-check";
const TGAS = 1_000_000_000_000n;

type History = Record<string, string>;

export function historyKey(account: string | null): string {
  return `elivo-check-history:${account ?? "local"}`;
}
const lastKey = (account: string) => `elivo-check-last:${account}`;

const isStringMap = (v: unknown): v is History =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  Object.values(v as object).every((x) => typeof x === "string");

function readJson(storage: Storage | null, key: string): unknown {
  try {
    const raw = storage?.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function writeJson(storage: Storage | null, key: string, v: unknown) {
  try {
    storage?.setItem(key, JSON.stringify(v));
  } catch {}
}

/** Normalised payee name → the account used last time, for this account (or "local" when signed out). */
export function readHistory(account: string | null, storage: Storage | null): History {
  const h = readJson(storage, historyKey(account));
  return isStringMap(h) ? h : {};
}

/** Records these accounts as the ones used last time (after the check that used them is anchored). */
export function acceptHistory(account: string | null, accept: History, storage: Storage | null) {
  writeJson(storage, historyKey(account), { ...readHistory(account, storage), ...accept });
}

export type Checked =
  | {
      ok: true;
      result: CheckResult;
      rows: PlannedRow[];
      /** When the check ran (ISO 8601 UTC); the report id comes from it. */
      checkedAt: string;
      /** Name → account for the rows that passed, to record once the check is anchored. */
      accept: History;
    }
  | { ok: false; errors: string[] };

/**
 * Parses and checks the planned batch against the history. Afterwards it adds payees seen for the first
 * time to the history; a changed account is recorded only when its check is anchored, so the warning
 * stays until then. The sample with problems uses its own invented history and records nothing.
 */
export function runCheck(
  input: { csv: string; rail: string; account: string | null },
  storage: Storage | null,
): Checked {
  const parsed = parsePlannedCsv(input.csv);
  const errors = parsed.errors.map((e) => (e.row ? `Row ${e.row}: ${e.reason}` : e.reason));
  if (!errors.length && parsed.rows.length === 0) errors.push("No payouts in the CSV");
  if (errors.length) return { ok: false, errors };
  const sample = input.csv.trim() === SAMPLE_PROBLEMS_CSV.trim();
  const history = sample ? SAMPLE_PROBLEMS_HISTORY : readHistory(input.account, storage);
  const result = checkBatch(parsed.rows, { rail: input.rail, history });

  const accept: History = {};
  const added: History = {};
  result.rows.forEach((c, i) => {
    const r = parsed.rows[i];
    const key = normaliseName(r?.name ?? "");
    if (!r || !key || c.findings.some((f) => f.level === "block")) return;
    accept[key] = r.account;
    if (!(key in history) && !(key in added)) added[key] = r.account;
  });
  if (!sample && Object.keys(added).length) acceptHistory(input.account, added, storage);
  return { ok: true, result, rows: parsed.rows, checkedAt: new Date().toISOString(), accept };
}

export interface CheckAnchorInput {
  result: CheckResult;
  rows: PlannedRow[];
  account: string;
  registry: string;
  network: string;
  postQuantum: boolean;
  /** The account's current key set in the registry (get_keys), or null if it has none. */
  currentKeys: { receipt_pk: string; mldsa65_pk: string | null } | null;
  checkedAt?: string;
}

export type PreparedCheck =
  | { ok: true; report: CheckReport; hash: string; tx: TxSpec }
  | { ok: false; errors: string[] };

function call(methodName: string, args: object, deposit: bigint): FunctionCallSpec {
  return {
    type: "FunctionCall",
    params: { methodName, args, gas: (30n * TGAS).toString(), deposit: deposit.toString() },
  };
}

/** Signs the check report with the visitor's receipt keys and builds the set_keys (if needed) + anchor tx. */
export function prepareCheckAnchor(input: CheckAnchorInput, storage: Storage | null): PreparedCheck {
  if (!input.result.ok)
    return { ok: false, errors: ["Some rows are blocked: fix them and check again before anchoring"] };
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const keys = issuerKeys(input.account, storage);
  const pq = input.postQuantum ? keys.pq : undefined;
  let report: CheckReport;
  try {
    const body = buildCheckReport(input.result, input.rows, {
      network: input.network,
      registry: input.registry,
      issuer: input.account,
      report_id: checkReportId(checkedAt),
      salt: crypto.getRandomValues(new Uint8Array(16)),
      checked_at: checkedAt,
    });
    report = signCheckReport(body, keys.edSeed, pq);
  } catch (e) {
    return { ok: false, errors: [(e as Error).message] };
  }
  const wantPq = pq?.publicKeyB64 ?? null;
  const cur = input.currentKeys;
  const publish = !cur || cur.receipt_pk !== keys.edPk || (cur.mldsa65_pk ?? null) !== wantPq;
  const hash = checkReportHashB58(report);
  const actions = [
    ...(publish ? [call("set_keys", { receipt_pk: keys.edPk, mldsa65_pk: wantPq }, KEYS_DEPOSIT)] : []),
    call("anchor", { receipt_id: report.report_id, receipt_hash: hash }, ANCHOR_DEPOSIT),
  ];
  return { ok: true, report, hash, tx: { receiverId: input.registry, actions } };
}

/** The last check report this browser anchored for `account`: Task 4's receipts point at it. */
export function lastAnchoredCheck(
  account: string,
  storage: Storage | null,
): { report_id: string; hash: string; checked_at: string } | null {
  const v = readJson(storage, lastKey(account)) as Record<string, unknown> | null;
  return v &&
    typeof v === "object" &&
    typeof v.report_id === "string" &&
    typeof v.hash === "string" &&
    typeof v.checked_at === "string"
    ? { report_id: v.report_id, hash: v.hash, checked_at: v.checked_at }
    : null;
}

export function recordAnchoredCheck(
  account: string,
  last: { report_id: string; hash: string; checked_at: string },
  storage: Storage | null,
) {
  writeJson(storage, lastKey(account), last);
}

/** The report waiting for its anchor transaction, with the history to record once it is anchored. */
export function readPendingCheck(storage: Storage | null): { report: CheckReport; accept: History } | null {
  const v = readJson(storage, PENDING_CHECK_KEY) as { report?: unknown; accept?: unknown } | null;
  if (!v || typeof v !== "object" || !isCheckReport(v.report)) return null;
  return { report: v.report, accept: isStringMap(v.accept) ? v.accept : {} };
}
