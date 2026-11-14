import { describe, expect, it } from "vitest";
import { clabeCheckDigit } from "../src/clabe.ts";
import { checkBatch, normaliseName, type PlannedRow, parsePlannedCsv } from "../src/payout-check.ts";
import { bankForClabe } from "../src/spei-banks.ts";

const clabe = (first17: string) => `${first17}${clabeCheckDigit(first17)}`;
const GOOD = clabe("00201000000000001");
const OTHER = clabe("01201000000000002");
const SHARED = clabe("07201000000000003");
const UNKNOWN_BANK = clabe("99901000000000004");
const BAD_DIGIT = `${GOOD.slice(0, 17)}${(Number(GOOD[17]) + 1) % 10}`;

const SAMPLE_RESULTS_CSV = `name,account,amount,status,paid_at,reference
Lucía Fernández,002010077777777771,37000.00,paid,2026-11-14T15:02:11Z,SIM-SPEI-20261114-0001
Mateo Ríos,032180000118359719,37000.00,paid,2026-11-14T15:02:40Z,SIM-SPEI-20261114-0002
Sofía Herrera,012180001234567899,27750.00,returned,,ACCOUNT_CLOSED
Diego Navarro,072180009876543213,46250.00,paid,2026-11-14T15:03:05Z,SIM-SPEI-20261114-0004
Valentina Cruz,646180005555555554,18500.00,paid,2026-11-14T15:03:31Z,SIM-SPEI-20261114-0005
`;

const row = (n: number, name: string, account: string, amount: string): PlannedRow => ({
  row: n,
  name,
  account,
  amount,
});
const codes = (r: { findings: { code: string }[] }) => r.findings.map((f) => f.code);

describe("bankForClabe", () => {
  it("maps the first three digits to a bank", () => {
    expect(bankForClabe("002010077777777771")).toBe("BANAMEX");
    expect(bankForClabe("999010000000000000")).toBeNull();
  });
});

describe("checkBatch on SPEI", () => {
  it("applies every rule to every row", () => {
    const rows = [
      row(2, "Ana Prueba", GOOD, "1000.00"),
      row(3, "Beto Prueba", BAD_DIGIT, "1000.00"),
      row(4, "Carla Prueba", UNKNOWN_BANK, "1000.00"),
      row(5, "Dario Prueba", SHARED, "1000.00"),
      row(6, "Elena Prueba", SHARED, "1000.00"),
      row(7, "Fabio Prueba", OTHER, "10000.00"),
    ];
    const res = checkBatch(rows, { rail: "SPEI" });
    expect(res.rows.map(codes)).toEqual([
      [],
      ["clabe_check_digit"],
      ["unknown_bank"],
      ["duplicate_account"],
      ["duplicate_account"],
      ["amount_outlier"],
    ]);
    expect(res.rows[1]?.findings[0]?.level).toBe("block");
    expect(res.rows[0]?.account_last4).toBe(GOOD.slice(-4));
    expect(res.rows[0]?.bank).toBe("BANAMEX");
    expect(res.summary).toEqual({ rows: 6, blocked: 1, warned: 4, clean: 1 });
    expect(res.ok).toBe(false);
    expect(res.rail).toBe("SPEI");
  });

  it("passes the sample results batch with no findings", () => {
    const { rows, errors } = parsePlannedCsv(SAMPLE_RESULTS_CSV);
    expect(errors).toEqual([]);
    expect(rows).toHaveLength(5);
    const res = checkBatch(rows, { rail: "SPEI" });
    expect(res.ok).toBe(true);
    expect(res.rows.flatMap((r) => r.findings)).toEqual([]);
    expect(res.summary).toEqual({ rows: 5, blocked: 0, warned: 0, clean: 5 });
  });

  it("flags a changed account for a known payee", () => {
    const history = { [normaliseName("Lucia Fernandez")]: OTHER };
    const res = checkBatch([row(2, "Lucía  Fernández ", GOOD, "100.00")], { rail: "SPEI", history });
    expect(codes(res.rows[0] as { findings: { code: string }[] })).toEqual(["account_changed"]);
    expect(res.rows[0]?.findings[0]?.message).toMatch(/diversion/i);
    expect(res.ok).toBe(true);
    const same = checkBatch([row(2, "Lucia Fernandez", OTHER, "100.00")], { rail: "SPEI", history });
    expect(same.rows[0]?.findings).toEqual([]);
  });

  it("doesn't read the history's inherited properties as a payee seen before", () => {
    for (const name of ["constructor", "toString", "hasOwnProperty", "__proto__"]) {
      const res = checkBatch([row(2, name, GOOD, "100.00")], { rail: "SPEI", history: {} });
      expect(codes(res.rows[0] as { findings: { code: string }[] }), name).toEqual([]);
    }
  });

  it("warns when one name has several accounts", () => {
    const res = checkBatch([row(2, "Ana Prueba", GOOD, "10.00"), row(3, "ana  prueba", OTHER, "10.00")], {
      rail: "SPEI",
    });
    expect(res.rows.map(codes)).toEqual([["name_multiple_accounts"], ["name_multiple_accounts"]]);
  });

  it("blocks a missing name and a bad amount, and collects all findings", () => {
    const res = checkBatch(
      [row(2, "", GOOD, "0.00"), row(3, "Ana", "123", "1.234"), row(4, "Beto", `${GOOD.slice(0, 17)}x`, "5")],
      { rail: "SPEI" },
    );
    expect(codes(res.rows[0] as { findings: { code: string }[] })).toEqual(["missing_name", "bad_amount"]);
    expect(codes(res.rows[1] as { findings: { code: string }[] })).toEqual(["bad_amount", "clabe_length"]);
    expect(codes(res.rows[2] as { findings: { code: string }[] })).toEqual(["clabe_non_digit"]);
  });
});

describe("checkBatch on other rails", () => {
  it("accepts an IBAN-like account and blocks a short one", () => {
    const res = checkBatch([row(2, "Ana", "DE89370400440532013000", "10.00"), row(3, "Beto", "x", "10.00")], {
      rail: "SEPA",
    });
    expect(res.rows.map(codes)).toEqual([[], ["bad_account"]]);
    expect(res.rows[0]?.bank).toBeNull();
    expect(res.ok).toBe(false);
  });
});

describe("parsePlannedCsv", () => {
  it("accepts the planned header", () => {
    const out = parsePlannedCsv(`name,account,amount\nAna,${GOOD},10\nBeto,${OTHER},20.5\n`);
    expect(out.errors).toEqual([]);
    expect(out.rows).toEqual([
      { row: 2, name: "Ana", account: GOOD, amount: "10.00" },
      { row: 3, name: "Beto", account: OTHER, amount: "20.50" },
    ]);
  });

  it("rejects a bad header", () => {
    expect(parsePlannedCsv("who,what\nAna,1\n")).toEqual({
      rows: [],
      errors: [{ row: 1, reason: "bad_header" }],
    });
  });

  it("keeps a row with an empty name", () => {
    const out = parsePlannedCsv(`name,account,amount\n,${GOOD},10.00\n`);
    expect(out.rows).toHaveLength(1);
    expect(codes(checkBatch(out.rows, { rail: "SPEI" }).rows[0] as { findings: { code: string }[] })).toEqual(
      ["missing_name"],
    );
  });

  it("caps rows at 500", () => {
    const body = Array.from({ length: 501 }, (_, i) => `N${i},${GOOD},1.00`).join("\n");
    expect(parsePlannedCsv(`name,account,amount\n${body}`).errors).toEqual([
      { row: 0, reason: "too_many_rows" },
    ]);
  });
});
