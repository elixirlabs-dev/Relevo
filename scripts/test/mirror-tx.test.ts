import { bytesToHex, hexToBytes, keccak256, parseTransaction, recoverTransactionAddress } from "viem";
import { privateKeyToAccount, sign } from "viem/accounts";
import { describe, expect, it } from "vitest";
import { mirrorCalldata, parseMirrorCalldata } from "../../packages/shared/src/evm-mirror.ts";
import {
  assembleSignedTx,
  broadcastMirror,
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

describe("broadcastMirror", () => {
  const RAW = "0x02f86b0102030405" as const;
  const HASH = keccak256(RAW);
  const MINED = { status: "0x1", blockNumber: "0x10" };

  /** A fake Sepolia RPC: `send` answers eth_sendRawTransaction, receipts answer the polls in order. */
  function rpc(send: () => unknown, receipts: unknown[]) {
    const calls: Array<{ method: string; params: unknown[] }> = [];
    const f = async <T>(method: string, params: unknown[]): Promise<T> => {
      calls.push({ method, params });
      if (method === "eth_sendRawTransaction") return send() as T;
      if (method === "eth_getTransactionReceipt") return (receipts.length ? receipts.shift() : null) as T;
      throw new Error(method);
    };
    return { f, calls };
  }
  const polled = (calls: Array<{ method: string; params: unknown[] }>) =>
    calls.filter((c) => c.method === "eth_getTransactionReceipt").map((c) => c.params[0]);

  it("computes the hash locally and polls by it", async () => {
    const r = rpc(() => HASH, [null, MINED]);
    expect(await broadcastMirror(RAW, r.f, { pollMs: 1 })).toEqual({ txHash: HASH, receipt: MINED });
    expect(polled(r.calls)).toEqual([HASH, HASH]);
  });

  it("treats a lost broadcast reply as possibly sent and polls by the local hash", async () => {
    const r = rpc(() => {
      throw new Error("eth_sendRawTransaction: fetch failed");
    }, [MINED]);
    expect((await broadcastMirror(RAW, r.f, { pollMs: 1 })).txHash).toBe(HASH);
    expect(polled(r.calls)).toEqual([HASH]);
  });

  for (const msg of ["already known", "nonce too low"])
    it(`treats "${msg}" as sent`, async () => {
      const r = rpc(() => {
        throw new Error(`eth_sendRawTransaction: ${msg}`);
      }, [MINED]);
      expect((await broadcastMirror(RAW, r.f, { pollMs: 1 })).txHash).toBe(HASH);
    });

  it("throws other send errors without polling", async () => {
    const r = rpc(() => {
      throw new Error("eth_sendRawTransaction: insufficient funds for gas * price + value");
    }, [MINED]);
    await expect(broadcastMirror(RAW, r.f, { pollMs: 1 })).rejects.toThrow(/insufficient funds/);
    expect(polled(r.calls)).toEqual([]);
  });

  it("refuses a reply naming another hash", async () => {
    const r = rpc(() => `0x${"00".repeat(32)}`, [MINED]);
    await expect(broadcastMirror(RAW, r.f, { pollMs: 1 })).rejects.toThrow(/not the local hash/);
  });

  it("fails with the explorer link when the hash never shows up", async () => {
    const r = rpc(() => HASH, []);
    await expect(broadcastMirror(RAW, r.f, { pollMs: 1, attempts: 3 })).rejects.toThrow(
      new RegExp(`${HASH} is not mined.*sepolia.etherscan.io/tx/${HASH}`),
    );
    expect(polled(r.calls)).toHaveLength(3);
  });

  it("keeps polling through RPC errors while waiting", async () => {
    let n = 0;
    const f = async <T>(method: string): Promise<T> => {
      if (method === "eth_sendRawTransaction") return HASH as T;
      if (++n === 1) throw new Error("eth_getTransactionReceipt: HTTP 503");
      return MINED as T;
    };
    expect((await broadcastMirror(RAW, f, { pollMs: 1 })).receipt).toEqual(MINED);
  });
});
