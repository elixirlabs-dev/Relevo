import { checkReportHashB58, isCheckReport } from "@elivo/shared/check-report";
import { verifyDirectSignaturesWeb } from "@elivo/shared/direct-verify-web";
import { describe, expect, it } from "vitest";
import {
  acceptHistory,
  historyKey,
  lastAnchoredCheck,
  PENDING_CHECK_KEY,
  prepareCheckAnchor,
  readHistory,
  readPendingCheck,
  recordAnchoredCheck,
  runCheck,
  SAMPLE_PLANNED_CSV,
  SAMPLE_PROBLEMS_CSV,
} from "../lib/check.ts";
import { issuerKeys } from "../lib/issue.ts";

const registry = "registry.example.testnet";
const account = "alice.testnet";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("runCheck", () => {
  it("passes the clean sample, and writes the history only after the check runs", () => {
    const s = memoryStorage();
    expect(readHistory(null, s)).toEqual({});
    const out = runCheck({ csv: SAMPLE_PLANNED_CSV, rail: "SPEI", account: null }, s);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.result.ok).toBe(true);
    expect(out.result.summary).toEqual({ rows: 5, blocked: 0, warned: 0, clean: 5 });
    expect(historyKey(null)).toBe("elivo-check-history:local");
    expect(readHistory(null, s)["lucia fernandez"]).toBe("002010077777777771");
  });

  it("flags an account that changed since the last check, and keeps flagging it until anchored", () => {
    const s = memoryStorage();
    runCheck({ csv: SAMPLE_PLANNED_CSV, rail: "SPEI", account }, s);
    const changed = SAMPLE_PLANNED_CSV.replace("002010077777777771", "072180009876543213");
    for (let i = 0; i < 2; i++) {
      const out = runCheck({ csv: changed, rail: "SPEI", account }, s);
      if (!out.ok) throw new Error(out.errors.join());
      expect(codes(out.result.rows[0])).toContain("account_changed");
    }
    // The other account's history and the local history are separate.
    expect(readHistory(null, s)).toEqual({});
    const out = runCheck({ csv: changed, rail: "SPEI", account }, s);
    if (!out.ok) throw new Error(out.errors.join());
    acceptHistory(account, out.accept, s);
    expect(readHistory(account, s)["lucia fernandez"]).toBe("072180009876543213");
  });

  it("finds one problem of each kind in the sample with problems, without touching the history", () => {
    const s = memoryStorage();
    const out = runCheck({ csv: SAMPLE_PROBLEMS_CSV, rail: "SPEI", account: null }, s);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.rows).toHaveLength(6);
    const all = new Set(out.result.rows.flatMap(codes));
    for (const c of [
      "duplicate_account",
      "name_multiple_accounts",
      "amount_outlier",
      "clabe_check_digit",
      "unknown_bank",
      "account_changed",
    ])
      expect(all.has(c), c).toBe(true);
    expect(out.result.ok).toBe(false);
    expect(s.length).toBe(0);
  });

  it("reports a bad header instead of checking", () => {
    const out = runCheck({ csv: "name,clabe\nA,1\n", rail: "SPEI", account: null }, memoryStorage());
    expect(out).toEqual({ ok: false, errors: ["Row 1: bad_header"] });
  });
});

describe("prepareCheckAnchor", () => {
  const checked = () => {
    const out = runCheck({ csv: SAMPLE_PLANNED_CSV, rail: "SPEI", account }, memoryStorage());
    if (!out.ok) throw new Error(out.errors.join());
    return out;
  };
  const base = {
    account,
    registry,
    network: "testnet",
    postQuantum: true,
    checkedAt: "2026-11-14T15:00:00.000Z",
  };

  it("signs the report in the browser and builds set_keys + anchor the first time", async () => {
    const s = memoryStorage();
    const { result, rows } = checked();
    const out = prepareCheckAnchor({ ...base, result, rows, currentKeys: null }, s);
    if (!out.ok) throw new Error(out.errors.join());
    const keys = issuerKeys(account, s);
    expect(isCheckReport(out.report)).toBe(true);
    expect(out.report.report_id).toBe("check-20261114-150000");
    expect(out.report.issuer).toBe(account);
    expect(out.report.signatures.map((x) => x.alg)).toEqual(["ed25519", "ml-dsa-65"]);
    expect(
      await verifyDirectSignaturesWeb(out.report, {
        receipt_pk: keys.edPk,
        mldsa65_pk: keys.pq.publicKeyB64,
      }),
    ).toEqual({ ok: true });
    expect(out.hash).toBe(checkReportHashB58(out.report));
    expect(out.tx.receiverId).toBe(registry);
    expect(out.tx.actions.map((a) => a.params.methodName)).toEqual(["set_keys", "anchor"]);
    expect(out.tx.actions[1].params.args).toEqual({
      receipt_id: "check-20261114-150000",
      receipt_hash: out.hash,
    });
    // Names and full account numbers never leave the browser.
    const sent = JSON.stringify([out.tx, out.report]);
    for (const secret of ["Lucía", "Fernández", "002010077777777771"]) expect(sent).not.toContain(secret);
  });

  it("sends only the anchor when the registry already has the keys", () => {
    const s = memoryStorage();
    const keys = issuerKeys(account, s);
    const { result, rows } = checked();
    const out = prepareCheckAnchor(
      { ...base, result, rows, currentKeys: { receipt_pk: keys.edPk, mldsa65_pk: keys.pq.publicKeyB64 } },
      s,
    );
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.tx.actions.map((a) => a.params.methodName)).toEqual(["anchor"]);
  });

  it("refuses a batch with blocked rows", () => {
    const out = runCheck({ csv: SAMPLE_PROBLEMS_CSV, rail: "SPEI", account }, memoryStorage());
    if (!out.ok) throw new Error(out.errors.join());
    const p = prepareCheckAnchor(
      { ...base, result: out.result, rows: out.rows, currentKeys: null },
      memoryStorage(),
    );
    expect(p.ok).toBe(false);
  });
});

describe("anchored checks", () => {
  it("remembers the last anchored check per account, for the receipt to point at", () => {
    const s = memoryStorage();
    expect(lastAnchoredCheck(account, s)).toBeNull();
    recordAnchoredCheck(account, { report_id: "check-20261114-150000", hash: "H", checked_at: "T" }, s);
    expect(lastAnchoredCheck(account, s)).toEqual({
      report_id: "check-20261114-150000",
      hash: "H",
      checked_at: "T",
    });
    expect(lastAnchoredCheck("bob.testnet", s)).toBeNull();
    s.setItem("elivo-check-last:alice.testnet", "{broken");
    expect(lastAnchoredCheck(account, s)).toBeNull();
  });

  it("keeps a pending report across a wallet redirect, and ignores anything else", () => {
    const s = memoryStorage();
    const out = runCheck({ csv: SAMPLE_PLANNED_CSV, rail: "SPEI", account }, memoryStorage());
    if (!out.ok) throw new Error(out.errors.join());
    const p = prepareCheckAnchor(
      {
        account,
        registry,
        network: "testnet",
        postQuantum: false,
        result: out.result,
        rows: out.rows,
        currentKeys: null,
      },
      memoryStorage(),
    );
    if (!p.ok) throw new Error(p.errors.join());
    expect(readPendingCheck(s)).toBeNull();
    s.setItem(PENDING_CHECK_KEY, JSON.stringify({ report: p.report, accept: { a: "b" } }));
    expect(readPendingCheck(s)?.report.report_id).toBe(p.report.report_id);
    expect(readPendingCheck(s)?.accept).toEqual({ a: "b" });
    s.setItem(PENDING_CHECK_KEY, "{not json");
    expect(readPendingCheck(s)).toBeNull();
  });
});
