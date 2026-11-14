/**
 * Browser-safe pre-payout checks: run over a planned batch before any money moves.
 *
 * Planned CSV: `name,account,amount` (the results header `name,account,amount,status,paid_at,reference`
 * is accepted too; the extra columns are ignored). At most 500 data rows. Row-level value problems are
 * findings from `checkBatch`, not parse errors, so a bad row still shows up in the report.
 */
import { parse } from "csv-parse/browser/esm/sync";
import { clabeLast4, validateClabe } from "./clabe.ts";
import type { RowError } from "./csv.ts";
import { bankForClabe, SPEI_BANKS } from "./spei-banks.ts";

export const MAX_PLANNED_ROWS = 500;
const PLANNED_HEADER = "name,account,amount";
const RESULTS_HEADER = "name,account,amount,status,paid_at,reference";
const AMOUNT = /^\d{1,15}(\.\d{1,2})?$/;
const OTHER_ACCOUNT = /^[A-Za-z0-9]{4,34}$/;

export type CheckLevel = "block" | "warn";
export type CheckCode =
  | "missing_name"
  | "bad_amount"
  | "clabe_length"
  | "clabe_non_digit"
  | "clabe_check_digit"
  | "bad_account"
  | "unknown_bank"
  | "duplicate_account"
  | "name_multiple_accounts"
  | "amount_outlier"
  | "account_changed";

export interface PlannedRow {
  row: number;
  name: string;
  account: string;
  /** two decimal places when valid; the raw text otherwise */
  amount: string;
}

export interface Finding {
  code: CheckCode;
  level: CheckLevel;
  message: string;
}

export interface RowCheck {
  row: number;
  name: string;
  account_last4: string;
  bank: string | null;
  amount: string;
  findings: Finding[];
}

export interface CheckResult {
  rail: string;
  rows: RowCheck[];
  summary: { rows: number; blocked: number; warned: number; clean: number };
  ok: boolean;
}

/** Trim, lower-case, strip accents and collapse inner whitespace. */
export function normaliseName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function twoDp(s: string): string {
  const [w = "0", f = ""] = s.split(".");
  return `${BigInt(w)}.${f.padEnd(2, "0")}`;
}

export function parsePlannedCsv(text: string): { rows: PlannedRow[]; errors: RowError[] } {
  let records: string[][];
  try {
    records = parse(text, { bom: true, relax_column_count: true, skip_empty_lines: true, trim: true });
  } catch {
    return { rows: [], errors: [{ row: 0, reason: "unparseable_csv" }] };
  }
  const [head, ...data] = records;
  const header = head?.map((h) => h.toLowerCase()).join(",");
  if (header !== PLANNED_HEADER && header !== RESULTS_HEADER)
    return { rows: [], errors: [{ row: 1, reason: "bad_header" }] };
  const errors: RowError[] = [];
  if (data.length > MAX_PLANNED_ROWS) errors.push({ row: 0, reason: "too_many_rows" });
  const rows = data.slice(0, MAX_PLANNED_ROWS).map((rec, i): PlannedRow => {
    const [name = "", account = "", amount = ""] = rec;
    return { row: i + 2, name, account, amount: AMOUNT.test(amount) ? twoDp(amount) : amount };
  });
  return { rows, errors };
}

function validAmount(amount: string): boolean {
  return AMOUNT.test(amount) && Number(amount) > 0;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

const CLABE_MESSAGES = {
  clabe_length: "This account number is not 18 digits long, so it cannot be a CLABE.",
  clabe_non_digit: "This account number contains characters other than digits, so it cannot be a CLABE.",
  clabe_check_digit: "This CLABE fails its check digit, so it has a typo and the payment would bounce.",
} as const;

export function checkBatch(
  rows: PlannedRow[],
  opts: { rail: string; history?: Record<string, string> },
): CheckResult {
  const spei = opts.rail.toUpperCase() === "SPEI";
  const amounts = rows.filter((r) => validAmount(r.amount)).map((r) => Number(r.amount));
  const med = rows.length >= 3 && amounts.length > 0 ? median(amounts) : null;

  const rowsByAccount = new Map<string, number>();
  const accountsByName = new Map<string, Set<string>>();
  for (const r of rows) {
    if (r.account) rowsByAccount.set(r.account, (rowsByAccount.get(r.account) ?? 0) + 1);
    const key = normaliseName(r.name);
    if (key && r.account) {
      const set = accountsByName.get(key) ?? new Set<string>();
      set.add(r.account);
      accountsByName.set(key, set);
    }
  }

  const checked = rows.map((r): RowCheck => {
    const findings: Finding[] = [];
    const add = (code: CheckCode, level: CheckLevel, message: string) =>
      findings.push({ code, level, message });
    const key = normaliseName(r.name);

    if (!key) add("missing_name", "block", "This row has no payee name.");
    if (!validAmount(r.amount))
      add("bad_amount", "block", "The amount must be a number above zero with at most two decimal places.");

    if (spei) {
      const v = validateClabe(r.account);
      if (!v.ok) add(v.reason, "block", CLABE_MESSAGES[v.reason]);
      else if (!SPEI_BANKS[r.account.slice(0, 3)])
        add(
          "unknown_bank",
          "warn",
          `Bank code ${r.account.slice(0, 3)} is not in this prototype's partial list of SPEI banks, so check it against Banxico's list.`,
        );
    } else if (!OTHER_ACCOUNT.test(r.account)) {
      add("bad_account", "block", "The account must be 4 to 34 letters or digits.");
    }

    if (r.account && (rowsByAccount.get(r.account) ?? 0) > 1)
      add(
        "duplicate_account",
        "warn",
        "This account appears in more than one row, so check you are not paying it twice.",
      );
    if (key && (accountsByName.get(key)?.size ?? 0) > 1)
      add("name_multiple_accounts", "warn", "This payee name appears with different accounts in this batch.");
    if (med !== null && validAmount(r.amount) && Number(r.amount) > 3 * med)
      add("amount_outlier", "warn", "This amount is more than three times the typical amount in the batch.");
    // Own keys only: a payee named "constructor" must not read Object.prototype as last time's account.
    const last = key && opts.history && Object.hasOwn(opts.history, key) ? opts.history[key] : undefined;
    if (last !== undefined && last !== r.account)
      add(
        "account_changed",
        "warn",
        "This payee's account differs from the one used last time, which is the classic sign of payroll diversion, so confirm the change with the payee through a channel you already know.",
      );

    return {
      row: r.row,
      name: r.name,
      account_last4: clabeLast4(r.account),
      bank: spei ? bankForClabe(r.account) : null,
      amount: r.amount,
      findings,
    };
  });

  const blocked = checked.filter((r) => r.findings.some((f) => f.level === "block")).length;
  const clean = checked.filter((r) => r.findings.length === 0).length;
  return {
    rail: opts.rail,
    rows: checked,
    summary: { rows: checked.length, blocked, warned: checked.length - blocked - clean, clean },
    ok: blocked === 0,
  };
}
