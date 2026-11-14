import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseResultsCsv } from "../../packages/shared/src/direct-build.ts";
import {
  buildDirectReceiptV2,
  directV2HashB58,
  isDirectReceiptV2,
  isPayeeProof,
  payeeRefMatches,
  signDirectReceiptV2,
  verifyDirectV2Structure,
  verifyPayeeProofStructure,
} from "../../packages/shared/src/direct-receipt-v2.ts";
import { keyFromSeed } from "../../packages/shared/src/keys.ts";
import { writeDirectV2Files } from "../lib/direct-v2-files.ts";

describe("issue-receipt --v2 output (no network)", () => {
  it("writes the receipt, one proof per payee next to it, and the salt as a private file", () => {
    const csv = readFileSync(new URL("../../samples/payroll-results.csv", import.meta.url), "utf8");
    const { rows } = parseResultsCsv(csv, { rail: "SPEI" });
    const salt = new Uint8Array(16).fill(9);
    const r = signDirectReceiptV2(
      buildDirectReceiptV2(rows, {
        network: "testnet",
        registry: "registry.example.testnet",
        issuer: "payroll.example.testnet",
        receipt_id: "nov-v2",
        rail: "SPEI",
        currency: "MXN",
        salt,
      }),
      keyFromSeed(new Uint8Array(32).fill(4)).seed,
    );
    const dir = mkdtempSync(join(tmpdir(), "elivo-issue-v2-"));
    const files = writeDirectV2Files(dir, "direct-payroll.example.testnet-nov-v2", r, salt);

    const written = JSON.parse(readFileSync(files.receipt, "utf8"));
    expect(isDirectReceiptV2(written)).toBe(true);
    expect(verifyDirectV2Structure(written)).toEqual([]);
    expect(files.proofs.map((f) => f.slice(dir.length + 1))).toEqual(
      [0, 1, 2, 3, 4].map((i) => `direct-payroll.example.testnet-nov-v2.payee-${i}.json`),
    );
    files.proofs.forEach((f, i) => {
      const p = JSON.parse(readFileSync(f, "utf8"));
      expect(isPayeeProof(p)).toBe(true);
      expect(verifyPayeeProofStructure(p)).toEqual([]);
      expect(directV2HashB58(p.header)).toBe(directV2HashB58(written));
      expect(payeeRefMatches(p, rows[i].account)).toBe(true);
    });
    expect(readFileSync(files.salt, "utf8")).toBe(`${"09".repeat(16)}\n`);
    expect(statSync(files.salt).mode & 0o777).toBe(0o600);
  });
});
