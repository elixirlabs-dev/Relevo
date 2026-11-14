import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { b58encode } from "../src/base58.ts";
import { type MpcAccount, requestMpcSignature } from "../src/mpc-sign.ts";

const SIG = {
  big_r: { affine_point: `02${"ab".repeat(32)}` },
  s: { scalar: "01".repeat(32) },
  recovery_id: 0,
};
const ok = (v: unknown) => ({ status: { SuccessValue: Buffer.from(JSON.stringify(v)).toString("base64") } });
const TX_BYTES = new Uint8Array([1, 2, 3]);
const TX_HASH = b58encode(new Uint8Array(createHash("sha256").update(TX_BYTES).digest()));

/** A fake issuer account: `send` and `status` script the RPC's answers in order. */
function fake(send: Array<() => unknown>, status: Array<() => unknown>) {
  const built: Array<{ receiverId: string; actions: unknown[] }> = [];
  const polled: Array<{ txHash: unknown; accountId: string; waitUntil?: string }> = [];
  const account: MpcAccount = {
    accountId: "payroll.example.testnet",
    createSignedTransaction: async (a) => {
      built.push(a as never);
      return { transaction: { encode: () => TX_BYTES } } as never;
    },
    provider: {
      sendTransactionUntil: async () => {
        const next = send.shift();
        if (!next) throw new Error("unexpected send");
        return next() as never;
      },
      viewTransactionStatus: async (p) => {
        polled.push(p as never);
        const next = status.shift();
        if (!next) throw new Error("unexpected poll");
        return next() as never;
      },
    },
  };
  return { account, built, polled };
}

const req = { signerId: "v1.signer-prod.testnet", payloadHex: "cd".repeat(32), path: "elivo-receipt-mirror" };

describe("requestMpcSignature", () => {
  it("calls sign with payload_v2, the path, domain 0, 1 yoctoNEAR and 300 Tgas", async () => {
    const f = fake([() => ({ status: "Started" })], [() => ok(SIG)]);
    const r = await requestMpcSignature(f.account, { ...req, pollMs: 1 });
    expect(r).toEqual({ value: SIG, txHash: TX_HASH });
    const fc = (
      f.built[0].actions[0] as {
        functionCall: { methodName: string; args: Uint8Array; gas: bigint; deposit: bigint };
      }
    ).functionCall;
    expect(f.built[0].receiverId).toBe("v1.signer-prod.testnet");
    expect(fc.methodName).toBe("sign");
    expect(JSON.parse(Buffer.from(fc.args).toString("utf8"))).toEqual({
      request: { payload_v2: { Ecdsa: "cd".repeat(32) }, path: "elivo-receipt-mirror", domain_id: 0 },
    });
    expect(fc.gas).toBe(300_000_000_000_000n);
    expect(fc.deposit).toBe(1n);
    expect(f.polled[0]).toMatchObject({ txHash: TX_HASH, accountId: "payroll.example.testnet" });
  });

  it("keeps polling through RPC timeouts and unfinished statuses", async () => {
    const f = fake(
      [
        () => {
          throw new Error("TIMEOUT_ERROR: timeout");
        },
      ],
      [
        () => {
          throw new Error("UNKNOWN_TRANSACTION");
        },
        () => ({ status: "Started" }),
        () => ok(SIG),
      ],
    );
    expect((await requestMpcSignature(f.account, { ...req, pollMs: 1 })).value).toEqual(SIG);
    expect(f.polled).toHaveLength(3);
  });

  it("throws the contract's failure", async () => {
    const f = fake([() => ({})], [() => ({ status: { Failure: { ActionError: { kind: "Timeout" } } } })]);
    await expect(requestMpcSignature(f.account, { ...req, pollMs: 1 })).rejects.toThrow(
      /sign failed.*Timeout/,
    );
  });

  it("gives up after the deadline with the NEAR tx hash", async () => {
    const f = fake(
      [() => ({})],
      Array.from({ length: 100 }, () => () => ({ status: "Started" })),
    );
    await expect(requestMpcSignature(f.account, { ...req, pollMs: 1, timeoutMs: 20 })).rejects.toThrow(
      new RegExp(`no signature after 20 ms.*${TX_HASH}`),
    );
  });

  it("does not poll when the send is rejected outright", async () => {
    const f = fake(
      [
        () => {
          throw new Error("InvalidTxError: NotEnoughBalance");
        },
      ],
      [],
    );
    await expect(requestMpcSignature(f.account, { ...req, pollMs: 1 })).rejects.toThrow(/NotEnoughBalance/);
    expect(f.polled).toHaveLength(0);
  });
});
