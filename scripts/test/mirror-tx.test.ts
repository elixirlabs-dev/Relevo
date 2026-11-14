import { bytesToHex, hexToBytes, parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { mirrorCalldata, parseMirrorCalldata } from "../../packages/shared/src/evm-mirror.ts";
import {
  assembleSignedTx,
  buildMirrorTx,
  mirrorGasLimit,
  mirrorSigningHash,
  recoverSigner,
  signatureFromMpc,
} from "../lib/mirror-tx.ts";

// A local key stands in for the MPC network: it signs the same 32-byte hash the signer contract would.
const SK = "0x4c0883a69102937d6231471b5dbb6204fe5129617082792ae468d01a3f362318";
const FROM = privateKeyToAccount(SK).address.toLowerCase();
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const DATA = mirrorCalldata("payroll.example.testnet", "payroll-2026-11-v2", "HV2");

/** The signer contract's response shape: big_r as a compressed point, s as a scalar, a recovery id. */
async function mpcSign(hashHex: string, shape: "nested" | "flat" = "nested", highS = false) {
  const sig = await sign({ hash: hashHex as `0x${string}`, privateKey: SK });
  let s = BigInt(sig.s);
  let rec = sig.yParity ?? 0;
  if (highS) {
    s = N - s;
    rec ^= 1;
  }
  const bigR = `${rec ? "03" : "02"}${sig.r.slice(2)}`;
  const sHex = s.toString(16).padStart(64, "0");
  return shape === "nested"
    ? {
        scheme: "Secp256k1",
        big_r: { affine_point: bigR.toUpperCase() },
        s: { scalar: sHex },
        recovery_id: rec,
      }
    : { big_r: bigR, s: sHex, recovery_id: rec };
}

const tx = () =>
  buildMirrorTx({
    from: FROM,
    data: DATA,
    nonce: 3,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });

describe("mirror transaction", () => {
  it("is a 0-value EIP-1559 self-send on Sepolia carrying the calldata", () => {
    const t = tx();
    expect(t).toMatchObject({
      type: "eip1559",
      chainId: 11155111,
      to: FROM,
      value: 0n,
      data: DATA,
      nonce: 3,
    });
  });

  it("sets the gas limit above the calldata floor (EIP-7623) with a margin", () => {
    const bytes = hexToBytes(DATA as `0x${string}`);
    const nz = bytes.filter((b) => b !== 0).length;
    const z = bytes.length - nz;
    const floor = 21_000 + 10 * (z + 4 * nz);
    const standard = 21_000 + 16 * nz + 4 * z;
    const g = mirrorGasLimit(DATA);
    expect(g).toBeGreaterThan(BigInt(Math.max(floor, standard)));
    expect(g).toBeLessThan(BigInt(Math.max(floor, standard)) * 2n);
    expect(tx().gas).toBe(g);
  });

  for (const shape of ["nested", "flat"] as const)
    it(`assembles a ${shape} MPC signature into a tx whose sender is the signing key`, async () => {
      const t = tx();
      const hash = mirrorSigningHash(t);
      const sig = signatureFromMpc(await mpcSign(hash, shape));
      expect(await recoverSigner(hash, sig)).toBe(FROM);
      const raw = assembleSignedTx(t, sig);
      expect(
        (await recoverTransactionAddress({ serializedTransaction: raw as `0x02${string}` })).toLowerCase(),
      ).toBe(FROM);
      const parsed = parseTransaction(raw as `0x02${string}`);
      expect(parsed).toMatchObject({ chainId: 11155111, to: FROM, nonce: 3 });
      expect(parsed.value ?? 0n).toBe(0n);
      expect(parseMirrorCalldata(parsed.data ?? "0x")).toEqual({
        issuer: "payroll.example.testnet",
        receipt_id: "payroll-2026-11-v2",
        receipt_hash: "HV2",
      });
    });

  it("normalises a high-s signature to low s (EIP-2) and still recovers the sender", async () => {
    const t = tx();
    const hash = mirrorSigningHash(t);
    const sig = signatureFromMpc(await mpcSign(hash, "nested", true));
    expect(BigInt(sig.s) <= N / 2n).toBe(true);
    expect(await recoverSigner(hash, sig)).toBe(FROM);
  });

  it("rejects a response it cannot read", () => {
    expect(() => signatureFromMpc({ nope: 1 })).toThrow(/MPC signature/);
    expect(() => signatureFromMpc({ big_r: "02ab", s: "01", recovery_id: 0 })).toThrow(/big_r/);
  });

  it("signs a hash as 32 bytes of hex", () => {
    expect(mirrorSigningHash(tx())).toMatch(/^0x[0-9a-f]{64}$/);
    expect(bytesToHex(hexToBytes(mirrorSigningHash(tx())))).toHaveLength(66);
  });
});
