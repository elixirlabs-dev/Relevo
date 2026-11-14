import { describe, expect, it } from "vitest";
import { buildVectors, OTHER_KEY, SIGNING_KEY } from "../../../scripts/lib/receipt-vectors.ts";
import { verifyAgainstChain } from "../lib/verify.ts";

const { files, manifest } = buildVectors();
const VALID = files["valid.json"];
const HASH = manifest[0].receipt_hash as string;
const app = { escrow: "escrow.example.testnet", network: "testnet" };

/** A chain where batch 7 exists with the given receipt key and anchored hash. */
function chain(
  batch: { receipt_pk: string; receipt_hash: string | null } | null = {
    receipt_pk: SIGNING_KEY.publicKeyStr,
    receipt_hash: HASH,
  },
) {
  const calls: Array<{ contract: string; method: string; args?: object }> = [];
  const view = async <T>(contract: string, method: string, args?: object): Promise<T> => {
    calls.push({ contract, method, args });
    if (method === "get_batch") return batch as T;
    throw new Error(method);
  };
  return { view, calls };
}
const byId = (r: Awaited<ReturnType<typeof verifyAgainstChain>>) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c]));

describe("verifyAgainstChain", () => {
  it("passes all four checks for a genuine, anchored receipt, reading the key from the chain", async () => {
    const c = chain();
    const r = await verifyAgainstChain(VALID, app, c.view);
    expect(r.ok).toBe(true);
    expect(r.checks.map((x) => [x.id, x.ok])).toEqual([
      ["escrow", true],
      ["signature", true],
      ["anchor", true],
      ["totals", true],
    ]);
    expect(r.hash).toBe(HASH);
    expect(c.calls).toEqual([{ contract: app.escrow, method: "get_batch", args: { batch_id: "7" } }]);
  });

  it("fails the signature for a receipt edited after signing", async () => {
    const r = await verifyAgainstChain(files["edited-amount.json"], app, chain().view);
    expect(r.ok).toBe(false);
    expect(byId(r).signature).toMatchObject({
      ok: false,
      detail: "The signature does not match the contents: the file was changed after signing",
    });
  });

  it("fails the escrow check for a receipt from another escrow, without reading the chain", async () => {
    const c = chain();
    const r = await verifyAgainstChain(VALID, { escrow: "escrow.other.testnet", network: "testnet" }, c.view);
    expect(r.ok).toBe(false);
    expect(byId(r).escrow).toMatchObject({
      ok: false,
      detail:
        "This receipt is for escrow.example.testnet on testnet; this app checks escrow.other.testnet on testnet",
    });
    expect(c.calls).toHaveLength(0);
  });

  it("fails the signature when the file's key is not the batch's on-chain receipt key", async () => {
    const r = await verifyAgainstChain(
      VALID,
      app,
      chain({ receipt_pk: OTHER_KEY.publicKeyStr, receipt_hash: HASH }).view,
    );
    expect(byId(r).signature).toMatchObject({
      ok: false,
      detail: `Signed by ${SIGNING_KEY.publicKeyStr}, but the batch's receipt key on-chain is ${OTHER_KEY.publicKeyStr}`,
    });
  });

  it("reports a file that is not a receipt as one failing check, without reading the chain", async () => {
    for (const input of ["not json", "{}", JSON.stringify({ ...JSON.parse(VALID), batch_id: "abc" })]) {
      const c = chain();
      const r = await verifyAgainstChain(input, app, c.view);
      expect(r).toMatchObject({ ok: false, receipt: null, hash: null });
      expect(r.checks).toEqual([
        {
          id: "format",
          ok: false,
          detail: "Not an elivo-receipt-1, elivo-direct-receipt-1 or elivo-check-report-1 file",
        },
      ]);
      expect(c.calls).toHaveLength(0);
    }
  });

  it("reports an unsigned file as not a receipt, without reading the chain", async () => {
    const c = chain();
    const r = await verifyAgainstChain(files["unsigned.json"], app, c.view);
    expect(r.checks).toEqual([
      {
        id: "format",
        ok: false,
        detail: "Not an elivo-receipt-1, elivo-direct-receipt-1 or elivo-check-report-1 file",
      },
    ]);
    expect(c.calls).toHaveLength(0);
  });

  it("fails a network-only mismatch (same escrow name, other network) before reading the chain", async () => {
    const c = chain();
    const r = await verifyAgainstChain(VALID, { ...app, network: "sandbox" }, c.view);
    expect(byId(r).escrow.ok).toBe(false);
    expect(c.calls).toHaveLength(0);
  });

  it("fails the anchor while the escrow has no receipt hash yet", async () => {
    const r = await verifyAgainstChain(
      VALID,
      app,
      chain({ receipt_pk: SIGNING_KEY.publicKeyStr, receipt_hash: null }).view,
    );
    expect(byId(r).signature.ok).toBe(true);
    expect(byId(r).anchor).toMatchObject({
      ok: false,
      detail: "Not anchored yet: the escrow has no receipt hash for batch 7",
    });
    expect(r.ok).toBe(false);
  });

  it("fails the anchor for a batch the escrow does not have", async () => {
    const r = await verifyAgainstChain(VALID, app, chain(null).view);
    expect(byId(r).anchor).toMatchObject({ ok: false, detail: "No batch 7 on escrow.example.testnet" });
    expect(r.ok).toBe(false);
  });

  it("fails the totals when one was edited (signature aside)", async () => {
    const edited = JSON.parse(VALID);
    edited.totals.penalties = "0";
    const r = await verifyAgainstChain(JSON.stringify(edited), app, chain().view);
    expect(byId(r).totals).toMatchObject({
      ok: false,
      detail: "These totals don't add up from the rows: penalties",
    });
  });
});

describe("verifyAgainstChain with a direct receipt (payouts made outside the escrow)", async () => {
  const { buildDirectReceipt, parseResultsCsv, signDirectReceipt, directHashB58 } = await import(
    "@elivo/shared/direct-issue"
  );
  const { keyFromSeed } = await import("@elivo/shared/keys");
  const key = keyFromSeed(new Uint8Array(32).fill(9));
  const CSV = `name,account,amount,status,paid_at,reference
A,002010077777777771,100,paid,2026-11-14T10:00:00Z,R1
B,012180001234567899,50,returned,,ACCOUNT_CLOSED
`;
  const registry = "registry.example.testnet";
  const direct = signDirectReceipt(
    buildDirectReceipt(parseResultsCsv(CSV, { rail: "SPEI" }).rows, {
      network: "testnet",
      registry,
      issuer: "payroll.example.testnet",
      receipt_id: "nov",
      rail: "SPEI",
      currency: "MXN",
      salt: new Uint8Array(16),
      generated_at: "2026-11-14T12:00:00.000Z",
    }),
    key,
  );
  const HASH_D = directHashB58(direct);
  const dapp = { ...app, registry };
  const regChain = (
    anchor: object | null = {
      receipt_hash: HASH_D,
      receipt_pk: key.publicKeyStr,
      mldsa65_pk: null,
      key_version: 1,
    },
  ) => {
    const calls: Array<{ contract: string; method: string; args?: object }> = [];
    const view = async <T>(contract: string, method: string, args?: object): Promise<T> => {
      calls.push({ contract, method, args });
      if (method === "get_receipt") return anchor as T;
      throw new Error(method);
    };
    return { view, calls };
  };

  it("passes all four checks, reading the issuer's key and hash from the registry", async () => {
    const c = regChain();
    const r = await verifyAgainstChain(JSON.stringify(direct), dapp, c.view);
    expect(r.checks.map((x) => [x.id, x.ok])).toEqual([
      ["registry", true],
      ["signature", true],
      ["anchor", true],
      ["totals", true],
    ]);
    expect(r.ok).toBe(true);
    expect(r.direct?.receipt_id).toBe("nov");
    expect(r.receipt).toBeNull();
    expect(r.hash).toBe(HASH_D);
    expect(c.calls).toEqual([
      {
        contract: registry,
        method: "get_receipt",
        args: { issuer: "payroll.example.testnet", receipt_id: "nov" },
      },
    ]);
  });

  it("fails the signature when an amount is edited", async () => {
    const edited = structuredClone(direct);
    edited.payouts[0].amount = "1000.00";
    const r = await verifyAgainstChain(JSON.stringify(edited), dapp, regChain().view);
    expect(r.ok).toBe(false);
    expect(byId(r).signature.ok).toBe(false);
  });

  it("never reads the registry named in the file", async () => {
    const c = regChain();
    const r = await verifyAgainstChain(JSON.stringify({ ...direct, registry: "evil.testnet" }), dapp, c.view);
    expect(byId(r).registry.ok).toBe(false);
    expect(c.calls).toEqual([]);
  });

  it("fails when the issuer anchored nothing under that id", async () => {
    const r = await verifyAgainstChain(JSON.stringify(direct), dapp, regChain(null).view);
    expect(byId(r).anchor).toMatchObject({ ok: false });
    expect(r.ok).toBe(false);
  });

  it("fails on a site with no registry configured", async () => {
    const r = await verifyAgainstChain(JSON.stringify(direct), app, regChain().view);
    expect(byId(r).registry).toMatchObject({
      ok: false,
      detail: "This app has no receipt registry configured",
    });
  });
});

describe("verifyAgainstChain with a post-quantum direct receipt", async () => {
  const { buildDirectReceipt, parseResultsCsv, signDirectReceipt, directHashB58 } = await import(
    "@elivo/shared/direct-issue"
  );
  const { keyFromSeed } = await import("@elivo/shared/keys");
  const { mldsaFromSeed } = await import("@elivo/shared/pq-keys");
  const ed = keyFromSeed(new Uint8Array(32).fill(4));
  const pq = mldsaFromSeed(new Uint8Array(32).fill(4));
  const registry = "registry.example.testnet";
  const r = signDirectReceipt(
    buildDirectReceipt(
      parseResultsCsv(
        "name,account,amount,status,paid_at,reference\nA,002010077777777771,100,paid,2026-11-14T10:00:00Z,R1\n",
        { rail: "SPEI" },
      ).rows,
      {
        network: "testnet",
        registry,
        issuer: "payroll.example.testnet",
        receipt_id: "pq",
        rail: "SPEI",
        currency: "MXN",
        salt: new Uint8Array(16),
      },
    ),
    ed,
    pq,
  );
  const view = async <T>(): Promise<T> =>
    ({
      receipt_hash: directHashB58(r),
      receipt_pk: ed.publicKeyStr,
      mldsa65_pk: pq.publicKeyB64,
      key_version: 2,
    }) as T;

  it("says both signatures were checked, the second one post-quantum", async () => {
    const out = await verifyAgainstChain(JSON.stringify(r), { ...app, registry }, view);
    expect(out.ok).toBe(true);
    expect(byId(out).signature.detail).toContain("ML-DSA-65 (FIPS 204, post-quantum)");
  });
});

describe("verifyAgainstChain with a check report (made before paying)", async () => {
  const { buildCheckReport, signCheckReport, checkReportHashB58 } = await import(
    "@elivo/shared/check-report"
  );
  const { checkBatch, parsePlannedCsv } = await import("@elivo/shared/payout-check");
  const { ed25519PublicKeyStr } = await import("@elivo/shared/direct-build");
  const seed = new Uint8Array(32).fill(11);
  const registry = "registry.example.testnet";
  const { rows } = parsePlannedCsv(
    "name,account,amount\nA,002010077777777771,100\nB,012180001234567899,50\nB,032180000118359719,50\n",
  );
  const report = signCheckReport(
    buildCheckReport(checkBatch(rows, { rail: "SPEI" }), rows, {
      network: "testnet",
      registry,
      issuer: "payroll.example.testnet",
      report_id: "check-20261114-120000",
      salt: new Uint8Array(16),
      checked_at: "2026-11-14T12:00:00.000Z",
    }),
    seed,
  );
  const HASH_C = checkReportHashB58(report);
  const capp = { ...app, registry };
  const regChain = (
    anchor: object | null = {
      receipt_hash: HASH_C,
      receipt_pk: ed25519PublicKeyStr(seed),
      mldsa65_pk: null,
      key_version: 1,
    },
  ) => {
    const calls: Array<{ contract: string; method: string; args?: object }> = [];
    const view = async <T>(contract: string, method: string, args?: object): Promise<T> => {
      calls.push({ contract, method, args });
      if (method === "get_receipt") return anchor as T;
      throw new Error(method);
    };
    return { view, calls };
  };

  it("passes the registry, signature, anchor and totals checks, keyed by the report id", async () => {
    const c = regChain();
    const r = await verifyAgainstChain(JSON.stringify(report), capp, c.view);
    expect(r.checks.map((x) => [x.id, x.ok])).toEqual([
      ["registry", true],
      ["signature", true],
      ["anchor", true],
      ["totals", true],
    ]);
    expect(r.ok).toBe(true);
    expect(r.check?.report_id).toBe("check-20261114-120000");
    expect(r.direct).toBeNull();
    expect(r.receipt).toBeNull();
    expect(r.hash).toBe(HASH_C);
    expect(byId(r).totals.detail).toBe("The summary adds up from the 3 rows' findings");
    expect(c.calls).toEqual([
      {
        contract: registry,
        method: "get_receipt",
        args: { issuer: "payroll.example.testnet", receipt_id: "check-20261114-120000" },
      },
    ]);
  });

  it("fails the signature when a finding is removed", async () => {
    const edited = structuredClone(report);
    edited.rows[1].findings = [];
    const r = await verifyAgainstChain(JSON.stringify(edited), capp, regChain().view);
    expect(byId(r).signature.ok).toBe(false);
    expect(byId(r).totals.ok).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("never reads the registry named in the file", async () => {
    const c = regChain();
    const r = await verifyAgainstChain(JSON.stringify({ ...report, registry: "evil.testnet" }), capp, c.view);
    expect(byId(r).registry).toMatchObject({
      ok: false,
      detail: `This check report is for evil.testnet on testnet; this app checks ${registry} on testnet`,
    });
    expect(c.calls).toEqual([]);
  });

  it("fails when the issuer anchored nothing under that id", async () => {
    const r = await verifyAgainstChain(JSON.stringify(report), capp, regChain(null).view);
    expect(byId(r).anchor).toMatchObject({
      ok: false,
      detail: `payroll.example.testnet has anchored no check report "check-20261114-120000" on ${registry}`,
    });
  });
});
