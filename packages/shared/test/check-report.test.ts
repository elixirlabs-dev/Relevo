import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import {
  buildCheckReport,
  CHECK_VERSION,
  checkReportHashB58,
  checkReportId,
  checkSummaryProblems,
  isCheckReport,
  signCheckReport,
} from "../src/check-report.ts";
import { ed25519PublicKeyStr } from "../src/direct-build.ts";
import { buildDirectReceipt, parseResultsCsv, signDirectReceipt } from "../src/direct-issue.ts";
import { isDirectReceipt } from "../src/direct-receipt.ts";
import { directHashB58Web, verifyDirectSignaturesWeb } from "../src/direct-verify-web.ts";
import { keyFromSeed } from "../src/keys.ts";
import { LABEL } from "../src/label.ts";
import { checkBatch, parsePlannedCsv } from "../src/payout-check.ts";
import { mldsaFromSeed } from "../src/pq-keys.ts";

const PLANNED = `name,account,amount
Lucía Fernández,002010077777777771,37000.00
Mateo Ríos,032180000118359719,37000.00
Mateo Ríos,012180001234567899,27750.00
Valentina Cruz,646180005555555554,18500.00
`;
const edSeed = new Uint8Array(32).fill(7);
const pq = mldsaFromSeed(new Uint8Array(32).fill(8));
const meta = {
  network: "testnet",
  registry: "registry.example.testnet",
  issuer: "payroll.example.testnet",
  report_id: "check-20261114-150000",
  salt: new Uint8Array(16).fill(2),
  checked_at: "2026-11-14T15:00:00.000Z",
};

function body() {
  const { rows, errors } = parsePlannedCsv(PLANNED);
  expect(errors).toEqual([]);
  return buildCheckReport(checkBatch(rows, { rail: "SPEI" }), rows, meta);
}
const keys = { receipt_pk: ed25519PublicKeyStr(edSeed), mldsa65_pk: pq.publicKeyB64 };

describe("check report", () => {
  it("records the findings per row, a summary, and no names or full account numbers", () => {
    const b = body();
    expect(b.version).toBe(CHECK_VERSION);
    expect(b.label).toBe(LABEL);
    expect(b.engine).toBe("elivo-check-1");
    expect(b.rail).toBe("SPEI");
    expect(b.rows.map((r) => [r.id, r.account_last4, r.bank, r.amount, r.findings])).toEqual([
      [0, "7771", "BANAMEX", "37000.00", []],
      [1, "9719", "IXE", "37000.00", ["name_multiple_accounts"]],
      [2, "7899", "BBVA MEXICO", "27750.00", ["name_multiple_accounts"]],
      [3, "5554", "STP", "18500.00", []],
    ]);
    expect(b.rows[0].payee_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(b.summary).toEqual({ rows: 4, blocked: 0, warned: 2, clean: 2 });
    const text = JSON.stringify(b);
    for (const secret of ["Lucía", "Mateo", "002010077777777771", "646180005555555554"])
      expect(text).not.toContain(secret);
  });

  it("signs like a direct receipt: verifies with the issuer's keys, and the anchored hash is the whole file's", async () => {
    const r = signCheckReport(body(), edSeed, pq);
    expect(r.signatures.map((s) => s.alg)).toEqual(["ed25519", "ml-dsa-65"]);
    expect(await verifyDirectSignaturesWeb(r, keys)).toEqual({ ok: true });
    expect(checkReportHashB58(r)).toBe(await directHashB58Web(r));
    const edOnly = signCheckReport(body(), edSeed);
    expect(await verifyDirectSignaturesWeb(edOnly, { receipt_pk: keys.receipt_pk })).toEqual({ ok: true });
  });

  it("breaks its signature when one finding is changed", async () => {
    const r = structuredClone(signCheckReport(body(), edSeed, pq));
    r.rows[1].findings = [];
    expect(await verifyDirectSignaturesWeb(r, keys)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("is told apart from a direct receipt, both ways", () => {
    const r = signCheckReport(body(), edSeed);
    expect(isCheckReport(r)).toBe(true);
    expect(isDirectReceipt(r)).toBe(false);
    const direct = signDirectReceipt(
      buildDirectReceipt(
        parseResultsCsv(
          "name,account,amount,status,paid_at,reference\nA,002010077777777771,1,paid,2026-11-14T10:00:00Z,R\n",
          { rail: "SPEI" },
        ).rows,
        { ...meta, receipt_id: "nov", rail: "SPEI", currency: "MXN" },
      ),
      keyFromSeed(edSeed),
    );
    expect(isDirectReceipt(direct)).toBe(true);
    expect(isCheckReport(direct)).toBe(false);
  });

  it("rejects a report with the wrong field types or an unknown finding", () => {
    const bad = (f: (r: ReturnType<typeof signCheckReport>) => void) => {
      const r = structuredClone(signCheckReport(body(), edSeed));
      f(r);
      return isCheckReport(r);
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((r) => Object.assign(r.rows[0], { findings: ["made_up"] }))).toBe(false);
    expect(bad((r) => Object.assign(r.rows[0], { bank: 5 }))).toBe(false);
    expect(bad((r) => Object.assign(r, { report_id: "receipt-1" }))).toBe(false);
    expect(bad((r) => Object.assign(r, { engine: "other" }))).toBe(false);
    expect(bad((r) => Object.assign(r, { summary: null }))).toBe(false);
    expect(bad((r) => Object.assign(r.signatures, [null]))).toBe(false);
  });

  it("has a summary a verifier can recompute from the rows", () => {
    const r = signCheckReport(body(), edSeed);
    expect(checkSummaryProblems(r)).toEqual([]);
    expect(checkSummaryProblems({ ...r, summary: { ...r.summary, warned: 0, clean: 4 } })).toEqual([
      "warned",
      "clean",
    ]);
    const blocked = structuredClone(r);
    blocked.rows[0].findings = ["clabe_check_digit"];
    expect(checkSummaryProblems(blocked)).toEqual(["blocked", "clean"]);
  });

  it("refuses a batch with blocking findings, or rows that don't match the check", () => {
    const { rows } = parsePlannedCsv("name,account,amount\nA,002010077777777772,10\n");
    expect(() => buildCheckReport(checkBatch(rows, { rail: "SPEI" }), rows, meta)).toThrow(/blocked/);
    const good = parsePlannedCsv(PLANNED).rows;
    expect(() => buildCheckReport(checkBatch(good, { rail: "SPEI" }), good.slice(1), meta)).toThrow();
    expect(() =>
      buildCheckReport(checkBatch(good, { rail: "SPEI" }), good, { ...meta, report_id: "x" }),
    ).toThrow(/report id/);
  });

  it("names a report after the UTC time of the check", () => {
    expect(checkReportId("2026-11-14T09:05:07.123Z")).toBe("check-20261114-090507");
  });
});

describe("elivo-check-report-1 schema", () => {
  const read = (p: string) => readFileSync(new URL(`../../../${p}`, import.meta.url), "utf8");
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(
    JSON.parse(read("docs/receipts/elivo-check-report-1.schema.json")),
  );
  it("accepts a signed report, with and without the post-quantum signature", () => {
    for (const r of [signCheckReport(body(), edSeed, pq), signCheckReport(body(), edSeed)])
      expect(validate(r), JSON.stringify(validate.errors)).toBe(true);
  });
  it("rejects a report with an extra field, an unknown finding or no signatures", () => {
    const r = signCheckReport(body(), edSeed);
    expect(validate({ ...r, note: "x" })).toBe(false);
    expect(validate({ ...r, signatures: [] })).toBe(false);
    expect(validate({ ...r, rows: [{ ...r.rows[0], findings: ["made_up"] }] })).toBe(false);
  });
});
