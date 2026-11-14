import { describe, expect, it } from "vitest";
import { buildDirectReceipt, parseResultsCsv, signDirectReceipt } from "../src/direct-issue.ts";
import { directTotalsProblems, isDirectReceipt } from "../src/direct-receipt.ts";
import { directHashB58Web, verifyDirectSignaturesWeb } from "../src/direct-verify-web.ts";
import { keyFromSeed } from "../src/keys.ts";

const CSV = `name,account,amount,status,paid_at,reference
Lucía Fernández,002010077777777771,37000,paid,2026-11-14T10:00:00Z,SPEI-REF-0001
Mateo Ríos,032180000118359719,37000.50,paid,2026-11-14T10:05:00Z,SPEI-REF-0002
Sofía Herrera,012180001234567899,27750.00,returned,,ACCOUNT_CLOSED
`;
const key = keyFromSeed(new Uint8Array(32).fill(5));
const other = keyFromSeed(new Uint8Array(32).fill(6));
const meta = {
  network: "testnet" as const,
  registry: "registry.example.testnet",
  issuer: "payroll.example.testnet",
  receipt_id: "2026-11-contractors",
  rail: "SPEI",
  currency: "MXN",
  salt: new Uint8Array(16).fill(1),
  generated_at: "2026-11-14T12:00:00.000Z",
};

function receipt() {
  const { rows, errors } = parseResultsCsv(CSV, { rail: "SPEI" });
  expect(errors).toEqual([]);
  return signDirectReceipt(buildDirectReceipt(rows, meta), key);
}

describe("payout results CSV", () => {
  it("parses rows and normalises amounts to two decimals", () => {
    const { rows } = parseResultsCsv(CSV, { rail: "SPEI" });
    expect(rows.map((r) => [r.amount, r.status])).toEqual([
      ["37000.00", "Paid"],
      ["37000.50", "Paid"],
      ["27750.00", "Returned"],
    ]);
  });

  it("reports each bad row and accepts none of them", () => {
    const bad = `name,account,amount,status,paid_at,reference
A,002010077777777772,10,paid,2026-11-14T10:00:00Z,R1
B,002010077777777771,abc,paid,2026-11-14T10:00:00Z,R2
C,002010077777777771,10,maybe,,R3
D,002010077777777771,10,paid,yesterday,R4
`;
    const { rows, errors } = parseResultsCsv(bad, { rail: "SPEI" });
    expect(rows).toEqual([]);
    expect(errors.map((e) => [e.row, e.reason])).toEqual([
      [2, "clabe_check_digit"],
      [3, "bad_amount"],
      [4, "bad_status"],
      [5, "bad_paid_at"],
    ]);
  });

  it("checks CLABEs only on the SPEI rail", () => {
    const iban = `name,account,amount,status,paid_at,reference
A,DE89370400440532013000,10,paid,2026-11-14T10:00:00Z,R1
`;
    expect(parseResultsCsv(iban, { rail: "SEPA" }).errors).toEqual([]);
    expect(parseResultsCsv(iban, { rail: "SPEI" }).errors[0].row).toBe(2);
  });

  it("rejects a wrong header", () => {
    expect(parseResultsCsv("name,clabe,amount_mxn\nA,1,2\n", { rail: "SPEI" }).errors).toEqual([
      { row: 1, reason: "bad_header" },
    ]);
  });
});

describe("direct receipt", () => {
  it("names no payee: only a salted hash and the last 4 digits", () => {
    const r = receipt();
    const text = JSON.stringify(r);
    for (const secret of ["Lucía", "002010077777777771", "Mateo"]) expect(text).not.toContain(secret);
    expect(r.payouts[0].account_last4).toBe("7771");
    expect(r.payouts[0].payee_ref).toMatch(/^[0-9a-f]{64}$/);
  });

  it("computes totals that the checker agrees with", () => {
    const r = receipt();
    expect(r.totals).toEqual({ count: 3, paid: "74000.50", not_paid: "27750.00" });
    expect(directTotalsProblems(r)).toEqual([]);
    expect(directTotalsProblems({ ...r, totals: { ...r.totals, paid: "1.00" } })).toEqual(["paid"]);
  });

  it("is recognised by shape, and an escrow receipt is not", () => {
    expect(isDirectReceipt(receipt())).toBe(true);
    expect(isDirectReceipt({ version: "elivo-receipt-1" })).toBe(false);
  });

  it("verifies with the issuer's key and fails when edited or checked with another key", async () => {
    const r = receipt();
    expect(await verifyDirectSignaturesWeb(r, { receipt_pk: key.publicKeyStr })).toEqual({ ok: true });
    const edited = structuredClone(r);
    edited.payouts[1].amount = "1.00";
    expect(await verifyDirectSignaturesWeb(edited, { receipt_pk: key.publicKeyStr })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verifyDirectSignaturesWeb(r, { receipt_pk: other.publicKeyStr })).toEqual({
      ok: false,
      reason: "key_mismatch",
    });
    expect(
      await verifyDirectSignaturesWeb({ ...r, signatures: [] }, { receipt_pk: key.publicKeyStr }),
    ).toEqual({ ok: false, reason: "malformed" });
  });

  it("hashes the whole signed receipt, so the hash changes with any edit", async () => {
    const r = receipt();
    const h = await directHashB58Web(r);
    expect(h).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    expect(await directHashB58Web({ ...r, receipt_id: "other" })).not.toBe(h);
  });
});

describe("direct receipt CSV", async () => {
  const { directReceiptToCsv } = await import("../src/receipt-csv.ts");
  it("has one row per payout with the issuer, id and hash on each", () => {
    const csv = directReceiptToCsv(receipt(), "HASH");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe(
      "issuer,receipt_id,network,registry,receipt_hash,payout_id,status,amount,currency,rail,payee_ref,account_last4,paid_at,reference",
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toContain(
      "payroll.example.testnet,2026-11-contractors,testnet,registry.example.testnet,HASH,2,Returned,27750.00,MXN,SPEI,",
    );
    expect(lines[3].endsWith(",7899,,ACCOUNT_CLOSED")).toBe(true);
  });
});
