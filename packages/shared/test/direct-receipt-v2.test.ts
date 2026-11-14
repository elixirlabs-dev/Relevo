import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import canonicalize from "canonicalize";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { b58encode } from "../src/base58.ts";
import { buildDirectReceipt, parseResultsCsv, signDirectReceiptWeb } from "../src/direct-build.ts";
import { isDirectReceipt } from "../src/direct-receipt.ts";
import {
  buildDirectReceiptV2,
  DIRECT_V2,
  type DirectReceiptV2,
  directV2HashB58,
  directV2HashB58Web,
  directV2SigningBytes,
  isDirectReceiptV2,
  isPayeeProof,
  PAYEE_PROOF,
  payeeProof,
  payeeRefMatches,
  payeeSalt,
  signDirectReceiptV2,
  verifyDirectV2SignaturesWeb,
  verifyDirectV2Structure,
  verifyPayeeProofStructure,
} from "../src/direct-receipt-v2.ts";
import { keyFromSeed } from "../src/keys.ts";
import { LABEL } from "../src/label.ts";
import { merkleLeaf, merkleRoot } from "../src/merkle.ts";
import { mldsaFromSeed } from "../src/pq-keys.ts";

const execFileP = promisify(execFile);
const CSV = readFileSync(new URL("../../../samples/payroll-results.csv", import.meta.url), "utf8");
const ACCOUNTS = CSV.trim()
  .split("\n")
  .slice(1)
  .map((l) => l.split(",")[1]);
const key = keyFromSeed(new Uint8Array(32).fill(5));
const other = keyFromSeed(new Uint8Array(32).fill(6));
const pq = mldsaFromSeed(new Uint8Array(32).fill(7));
const receiptSalt = new Uint8Array(16).fill(1);
const meta = {
  network: "testnet",
  registry: "registry.example.testnet",
  issuer: "payroll.example.testnet",
  receipt_id: "2026-11-contractors-v2",
  rail: "SPEI",
  currency: "MXN",
  salt: receiptSalt,
  generated_at: "2026-11-14T12:00:00.000Z",
};
const rows = () => {
  const { rows, errors } = parseResultsCsv(CSV, { rail: "SPEI" });
  expect(errors).toEqual([]);
  return rows;
};
const receipt = (withPq = false): DirectReceiptV2 =>
  signDirectReceiptV2(buildDirectReceiptV2(rows(), meta), key.seed, withPq ? pq : undefined);
const canon = (v: unknown) => new TextEncoder().encode(canonicalize(v) ?? "");
const u32be = (i: number) => Uint8Array.of(i >>> 24, (i >>> 16) & 255, (i >>> 8) & 255, i & 255);

describe("elivo-direct-receipt-2: build", () => {
  it("commits to the payouts with a Merkle root and keeps the v1 fields", () => {
    const { header, payouts } = buildDirectReceiptV2(rows(), meta);
    expect(header.version).toBe(DIRECT_V2);
    expect(DIRECT_V2).toBe("elivo-direct-receipt-2");
    expect(header.label).toBe(LABEL);
    expect(header.payout_count).toBe(5);
    expect(header.payouts_root).toBe(bytesToHex(merkleRoot(payouts.map(merkleLeaf))));
    expect(header.check_ref).toBeNull();
    expect(header.totals).toEqual({ count: 5, paid: "138750.00", not_paid: "27750.00" });
    expect("payouts" in header).toBe(false);
    expect(payouts.map((p) => p.id)).toEqual([0, 1, 2, 3, 4]);
  });

  it("derives one salt per payee: payee_salt_i = sha256(receipt_salt ‖ uint32be(i))", () => {
    const { payouts } = buildDirectReceiptV2(rows(), meta);
    payouts.forEach((p, i) => {
      const salt = sha256(concatBytes(receiptSalt, u32be(i)));
      expect(bytesToHex(payeeSalt(receiptSalt, i))).toBe(bytesToHex(salt));
      expect(p.payee_ref).toBe(bytesToHex(sha256(concatBytes(salt, new TextEncoder().encode(ACCOUNTS[i])))));
      expect(p.account_last4).toBe(ACCOUNTS[i].slice(-4));
    });
    expect(new Set(payouts.map((p) => p.payee_ref)).size).toBe(5);
  });

  it("carries a check_ref when given one", () => {
    const check_ref = { report_id: "check-2026-11", report_hash: "3".repeat(44) };
    expect(buildDirectReceiptV2(rows(), { ...meta, check_ref }).header.check_ref).toEqual(check_ref);
  });

  it("names no payee", () => {
    const text = JSON.stringify(receipt());
    for (const secret of ["Lucía", "Mateo", ...ACCOUNTS]) expect(text).not.toContain(secret);
  });

  it("validates its inputs like v1", () => {
    expect(() => buildDirectReceiptV2([], meta)).toThrow("no payouts");
    expect(() => buildDirectReceiptV2(rows(), { ...meta, receipt_id: "bad id" })).toThrow();
    expect(() => buildDirectReceiptV2(rows(), { ...meta, currency: "mxn" })).toThrow();
  });
});

describe("elivo-direct-receipt-2: sign and hash", () => {
  it("signs the header only: canonical JSON without payouts and signatures", async () => {
    const r = receipt();
    const { payouts: _p, signatures: _s, ...header } = r;
    expect(directV2SigningBytes(header)).toEqual(canon(header));
    expect(await verifyDirectV2SignaturesWeb(r, { receipt_pk: key.publicKeyStr })).toEqual({ ok: true });
    expect(await verifyDirectV2SignaturesWeb(r, { receipt_pk: other.publicKeyStr })).toEqual({
      ok: false,
      reason: "key_mismatch",
    });
    const edited = structuredClone(r);
    edited.payout_count = 4;
    expect(await verifyDirectV2SignaturesWeb(edited, { receipt_pk: key.publicKeyStr })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("signs with ed25519 and ML-DSA-65, both required when the registry has both keys", async () => {
    const r = receipt(true);
    expect(r.signatures.map((s) => s.alg)).toEqual(["ed25519", "ml-dsa-65"]);
    const keys = { receipt_pk: key.publicKeyStr, mldsa65_pk: pq.publicKeyB64 };
    expect(await verifyDirectV2SignaturesWeb(r, keys)).toEqual({ ok: true });
    expect(await verifyDirectV2SignaturesWeb(receipt(), keys)).toEqual({ ok: false, reason: "malformed" });
    const t = structuredClone(r);
    t.payouts_root = "0".repeat(64);
    expect(await verifyDirectV2SignaturesWeb(t, keys)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("anchors base58(sha256(canonical JSON of header + signatures)), without the payouts", async () => {
    const r = receipt();
    const { payouts: _p, ...anchored } = r;
    const want = b58encode(sha256(canon(anchored)));
    expect(directV2HashB58(r)).toBe(want);
    expect(directV2HashB58(anchored)).toBe(want);
    expect(await directV2HashB58Web(r)).toBe(want);
    expect(directV2HashB58({ ...r, receipt_id: "other" })).not.toBe(want);
  });

  it("is deterministic for the same inputs and differs from the v1 receipt of the same rows", () => {
    expect(receipt()).toEqual(receipt());
    const v1 = signDirectReceiptWeb(buildDirectReceipt(rows(), meta), key.seed);
    expect(isDirectReceipt(v1)).toBe(true);
    expect(isDirectReceiptV2(v1)).toBe(false);
    expect(isDirectReceipt(receipt())).toBe(false);
  });
});

describe("elivo-direct-receipt-2: shape and structure", () => {
  it("is recognised strictly by shape", () => {
    const r = receipt();
    expect(isDirectReceiptV2(r)).toBe(true);
    expect(isDirectReceiptV2(receipt(true))).toBe(true);
    const bad = (f: (r: Record<string, unknown> & DirectReceiptV2) => void) => {
      const c = structuredClone(r) as Record<string, unknown> & DirectReceiptV2;
      f(c);
      return isDirectReceiptV2(c);
    };
    expect(bad(() => {})).toBe(true);
    expect(bad((c) => Object.assign(c, { extra: 1 }))).toBe(false);
    expect(bad((c) => Object.assign(c, { payouts_root: "XYZ" }))).toBe(false);
    expect(bad((c) => Object.assign(c, { payout_count: "5" }))).toBe(false);
    expect(bad((c) => Object.assign(c, { check_ref: { report_id: "x" } }))).toBe(false);
    expect(bad((c) => Object.assign(c, { label: 1 }))).toBe(false);
    expect(bad((c) => Object.assign(c.payouts[0], { amount: "12" }))).toBe(false);
    expect(bad((c) => Object.assign(c.payouts[0], { name: "Lucía" }))).toBe(false);
    expect(bad((c) => Object.assign(c.signatures, [null]))).toBe(false);
    expect(bad((c) => Object.assign(c.totals, { extra: "1.00" }))).toBe(false);
    expect(isDirectReceiptV2(null)).toBe(false);
  });

  it("has no structural problems as issued", () => {
    expect(verifyDirectV2Structure(receipt())).toEqual([]);
  });

  it("detects one changed amount through the Merkle root and the totals", () => {
    const r = receipt();
    r.payouts[3].amount = "46250.01";
    expect(verifyDirectV2Structure(r)).toEqual(["payouts_root_mismatch", "totals_mismatch"]);
  });

  it("detects a dropped row, a wrong count and wrong totals", () => {
    const dropped = receipt();
    dropped.payouts.pop();
    expect(verifyDirectV2Structure(dropped)).toContain("payouts_root_mismatch");
    expect(verifyDirectV2Structure(dropped)).toContain("payout_count_mismatch");
    const totals = receipt();
    totals.totals.paid = "1.00";
    expect(verifyDirectV2Structure(totals)).toEqual(["totals_mismatch"]);
    const ids = receipt();
    [ids.payouts[0], ids.payouts[1]] = [ids.payouts[1], ids.payouts[0]];
    expect(verifyDirectV2Structure(ids)).toContain("payout_ids");
  });
});

describe("elivo-payee-proof-1", () => {
  it("verifies for every payee of the 5-row sample, without the other rows", async () => {
    const r = receipt(true);
    const hash = directV2HashB58(r);
    const keys = { receipt_pk: key.publicKeyStr, mldsa65_pk: pq.publicKeyB64 };
    for (let i = 0; i < 5; i++) {
      const p = payeeProof(r, i, receiptSalt);
      expect(p.version).toBe(PAYEE_PROOF);
      expect(PAYEE_PROOF).toBe("elivo-payee-proof-1");
      expect(isPayeeProof(p)).toBe(true);
      expect(verifyPayeeProofStructure(p)).toEqual([]);
      expect(directV2HashB58(p.header)).toBe(hash);
      expect(await verifyDirectV2SignaturesWeb(p.header, keys)).toEqual({ ok: true });
      expect(p.payee_salt).toBe(bytesToHex(payeeSalt(receiptSalt, i)));
      expect(payeeRefMatches(p, ACCOUNTS[i])).toBe(true);
      for (let j = 0; j < 5; j++) if (j !== i) expect(payeeRefMatches(p, ACCOUNTS[j])).toBe(false);
      const text = JSON.stringify(p);
      for (let j = 0; j < 5; j++) if (j !== i) expect(text).not.toContain(r.payouts[j].payee_ref);
      expect("payouts" in p.header).toBe(false);
    }
  });

  it("matches an account on another rail whatever its letter case, as /issue built it in upper case", () => {
    const csv =
      "name,account,amount,status,paid_at,reference\nA,de89370400440532013000,10.00,paid,2026-11-14T10:00:00Z,R1\nB,Gb29Nwbk60161331926819,20.00,paid,2026-11-14T10:00:00Z,R2\n";
    const parsed = parseResultsCsv(csv, { rail: "SEPA" });
    expect(parsed.errors).toEqual([]);
    const sepa = signDirectReceiptV2(
      buildDirectReceiptV2(parsed.rows, { ...meta, rail: "SEPA", currency: "EUR" }),
      key.seed,
    );
    const upper = ["DE89370400440532013000", "GB29NWBK60161331926819"];
    sepa.payouts.forEach((p, i) => {
      expect(p.payee_ref).toBe(
        bytesToHex(sha256(concatBytes(payeeSalt(receiptSalt, i), new TextEncoder().encode(upper[i])))),
      );
    });
    const p = payeeProof(sepa, 1, receiptSalt);
    for (const typed of ["GB29NWBK60161331926819", "gb29nwbk60161331926819", "Gb29Nwbk60161331926819"])
      expect(payeeRefMatches(p, typed), typed).toBe(true);
    expect(payeeRefMatches(p, "DE89370400440532013000")).toBe(false);
  });

  it("fails when tampered with", () => {
    const r = receipt();
    const good = payeeProof(r, 2, receiptSalt);
    const t = (f: (p: typeof good) => void) => {
      const p = structuredClone(good);
      f(p);
      return verifyPayeeProofStructure(p);
    };
    expect(t((p) => Object.assign(p.payout, { amount: "1.00" }))).toEqual(["merkle_path"]);
    expect(t((p) => Object.assign(p.payout, { status: "Paid" }))).toEqual(["merkle_path"]);
    expect(t((p) => Object.assign(p.proof.siblings[0], { hash: "0".repeat(64) }))).toEqual(["merkle_path"]);
    expect(t((p) => p.proof.siblings.reverse())).toContain("merkle_path");
    expect(t((p) => Object.assign(p.header, { payouts_root: "1".repeat(64) }))).toEqual(["merkle_path"]);
    expect(t((p) => Object.assign(p.proof, { index: 3 }))).toContain("index_mismatch");
    expect(t((p) => Object.assign(p.proof, { index: 9 }))).toContain("index_out_of_range");
    expect(t((p) => p.proof.siblings.pop())).toContain("merkle_path");
    // A changed salt still has a valid path but no longer matches the payee's account.
    const salted = structuredClone(good);
    salted.payee_salt = "00".repeat(32);
    expect(verifyPayeeProofStructure(salted)).toEqual([]);
    expect(payeeRefMatches(salted, ACCOUNTS[2])).toBe(false);
  });

  it("is recognised strictly by shape", () => {
    const p = payeeProof(receipt(), 0, receiptSalt);
    expect(isPayeeProof({ ...p, extra: 1 })).toBe(false);
    expect(isPayeeProof({ ...p, payee_salt: "zz" })).toBe(false);
    expect(isPayeeProof({ ...p, header: { ...p.header, payouts: [] } })).toBe(false);
    expect(isPayeeProof({ ...p, version: "elivo-payee-proof-2" })).toBe(false);
    expect(isDirectReceiptV2(p)).toBe(false);
  });

  it("refuses an index outside the receipt", () => {
    expect(() => payeeProof(receipt(), 5, receiptSalt)).toThrow();
  });
});

describe("verify-receipt with v2 receipts and payee proofs", () => {
  const dir = mkdtempSync(join(tmpdir(), "elivo-v2-"));
  const cli = async (...args: string[]) => {
    try {
      const { stdout } = await execFileP("pnpm", [
        "exec",
        "tsx",
        "packages/shared/src/bin/verify-receipt.ts",
        ...args,
      ]);
      return { code: 0, out: stdout.trim() };
    } catch (e) {
      const err = e as { code: number; stdout: string };
      return { code: err.code, out: err.stdout.trim() };
    }
  };
  const write = (name: string, v: unknown) => {
    const f = join(dir, name);
    writeFileSync(f, JSON.stringify(v));
    return f;
  };

  // A fake NEAR RPC that answers get_receipt for the registry, so --chain runs without a network.
  let server: Server;
  let rpc = "";
  let anchored: Record<string, unknown> | null = null;
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const q = JSON.parse(body);
        const args = JSON.parse(Buffer.from(q.params.args_base64, "base64").toString());
        const ok =
          q.params.account_id === meta.registry &&
          q.params.method_name === "get_receipt" &&
          args.issuer === meta.issuer;
        const value = ok && anchored && args.receipt_id === anchored.receipt_id ? anchored.view : null;
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: q.id,
            result: {
              result: [...Buffer.from(JSON.stringify(value))],
              logs: [],
              block_height: 1,
              block_hash: "11111111111111111111111111111111",
            },
          }),
        );
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    rpc = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => {
    server?.close();
  });

  it("verifies a v2 receipt and a payee proof with --pubkey, naming the format", {
    timeout: 60_000,
  }, async () => {
    const r = receipt();
    const rf = write("r.json", r);
    expect(await cli(rf, "--pubkey", key.publicKeyStr)).toEqual({
      code: 0,
      out: "OK (elivo-direct-receipt-2, 5 payouts)",
    });
    const pf = write("p.json", payeeProof(r, 3, receiptSalt));
    expect(await cli(pf, "--pubkey", key.publicKeyStr)).toEqual({
      code: 0,
      out: `OK (elivo-payee-proof-1, payout 4 of 5 in ${meta.issuer}/${meta.receipt_id})`,
    });
    expect((await cli(pf, "--pubkey", key.publicKeyStr, "--account", ACCOUNTS[3])).code).toBe(0);
    expect(await cli(pf, "--pubkey", key.publicKeyStr, "--account", ACCOUNTS[1])).toEqual({
      code: 1,
      out: "FAIL: payee_ref_mismatch",
    });
    const edited = structuredClone(r);
    edited.payouts[0].amount = "1.00";
    expect(await cli(write("e.json", edited), "--pubkey", key.publicKeyStr)).toEqual({
      code: 1,
      out: "FAIL: payouts_root_mismatch",
    });
    const badProof = payeeProof(r, 1, receiptSalt);
    badProof.payout.amount = "1.00";
    expect(await cli(write("bp.json", badProof), "--pubkey", key.publicKeyStr)).toEqual({
      code: 1,
      out: "FAIL: merkle_path",
    });
  });

  it("verifies against the registry with --chain, keys and hash from the chain", {
    timeout: 60_000,
  }, async () => {
    const r = receipt(true);
    const rf = write("pq.json", r);
    const pf = write("pq-proof.json", payeeProof(r, 0, receiptSalt));
    const chainArgs = ["--chain", "--rpc", rpc, "--registry", meta.registry];
    expect(await cli(rf, "--chain", "--rpc", rpc)).toEqual({
      code: 1,
      out: "FAIL: --chain needs --registry (the file's registry is not trusted)",
    });
    expect(await cli(rf, ...chainArgs)).toEqual({ code: 1, out: "FAIL: not_anchored" });
    const view = {
      receipt_hash: directV2HashB58(r),
      receipt_pk: key.publicKeyStr,
      mldsa65_pk: pq.publicKeyB64,
    };
    anchored = { receipt_id: meta.receipt_id, view };
    expect(await cli(rf, ...chainArgs)).toEqual({ code: 0, out: "OK (elivo-direct-receipt-2, 5 payouts)" });
    expect((await cli(pf, ...chainArgs)).out).toBe(
      `OK (elivo-payee-proof-1, payout 1 of 5 in ${meta.issuer}/${meta.receipt_id})`,
    );
    expect(await cli(rf, "--pubkey", key.publicKeyStr)).toEqual({
      code: 1,
      out: "FAIL: post-quantum receipt: use --chain, so the ML-DSA-65 key comes from the registry",
    });
    anchored = { receipt_id: meta.receipt_id, view: { ...view, receipt_hash: "1".repeat(44) } };
    expect(await cli(pf, ...chainArgs)).toEqual({ code: 1, out: "FAIL: hash_mismatch" });
    anchored = { receipt_id: meta.receipt_id, view: { ...view, mldsa65_pk: null } };
    expect(await cli(rf, ...chainArgs)).toEqual({ code: 1, out: "FAIL: malformed" });
    expect(await cli(rf, "--chain", "--rpc", rpc, "--registry", "other.testnet")).toEqual({
      code: 1,
      out: `FAIL: wrong_registry: the receipt is for ${meta.registry}, not other.testnet`,
    });
  });
});

describe("published JSON schemas", () => {
  const schema = (name: string) =>
    new Ajv2020({ allErrors: true, strict: true }).compile(
      JSON.parse(
        readFileSync(new URL(`../../../docs/receipts/${name}.schema.json`, import.meta.url), "utf8"),
      ),
    );
  const v2 = schema("elivo-direct-receipt-2");
  const proof = schema("elivo-payee-proof-1");

  it("accept issued v2 receipts (ed25519 and hybrid) and every payee proof", () => {
    for (const r of [receipt(), receipt(true)]) {
      expect(v2(r), JSON.stringify(v2.errors)).toBe(true);
      for (let i = 0; i < r.payout_count; i++)
        expect(proof(payeeProof(r, i, receiptSalt)), JSON.stringify(proof.errors)).toBe(true);
    }
    const withRef = signDirectReceiptV2(
      buildDirectReceiptV2(rows(), { ...meta, check_ref: { report_id: "check-1", report_hash: "abc" } }),
      key.seed,
    );
    expect(v2(withRef), JSON.stringify(v2.errors)).toBe(true);
  });

  it("reject extra fields, a v1 receipt, and a proof that carries the payouts", () => {
    expect(v2({ ...receipt(), note: "x" })).toBe(false);
    expect(v2(signDirectReceiptWeb(buildDirectReceipt(rows(), meta), key.seed))).toBe(false);
    const p = payeeProof(receipt(), 0, receiptSalt);
    expect(proof({ ...p, header: { ...p.header, payouts: [] } })).toBe(false);
    expect(proof({ ...p, proof: { ...p.proof, siblings: [{ side: "X", hash: "0".repeat(64) }] } })).toBe(
      false,
    );
  });
});
