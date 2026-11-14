/**
 * Asking NEAR's MPC network (Chain Signatures) to sign a 32-byte hash, as a NEAR account (Node).
 *
 * `sign` on the signer contract yields until the MPC nodes answer, which can take up to about a minute,
 * longer than an RPC node waits on one request. So the transaction is signed locally, its hash computed,
 * sent until included, and then its status polled until it finishes or the deadline passes.
 */
import { createHash } from "node:crypto";
import { type Account, actions, type Provider, type SignedTransaction, teraToGas } from "near-api-js";
import { b58encode } from "./base58.ts";

type RpcTransactionResponse = Awaited<ReturnType<Provider["viewTransactionStatus"]>>;

/** The parts of a near-api-js Account this uses (injectable for tests). */
export interface MpcAccount {
  accountId: string;
  createSignedTransaction: Account["createSignedTransaction"];
  provider: Pick<Provider, "sendTransactionUntil" | "viewTransactionStatus">;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Errors after which the transaction may still land: keep polling its status. */
const MAYBE_SENT =
  /timeout|\b429\b|too many requests|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|\b50[234]\b/i;

export function nearTxHash(signed: SignedTransaction): string {
  return b58encode(new Uint8Array(createHash("sha256").update(signed.transaction.encode()).digest()));
}

/**
 * Calls `sign({ request: { payload_v2: { Ecdsa }, path, domain_id: 0 } })` with 1 yoctoNEAR and 300 Tgas;
 * returns the contract's JSON result (big_r, s, recovery_id) and the NEAR transaction hash.
 */
export async function requestMpcSignature(
  account: MpcAccount,
  opts: { signerId: string; payloadHex: string; path: string; timeoutMs?: number; pollMs?: number },
): Promise<{ value: unknown; txHash: string }> {
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const pollMs = opts.pollMs ?? 3_000;
  const args = { request: { payload_v2: { Ecdsa: opts.payloadHex }, path: opts.path, domain_id: 0 } };
  const signed = await account.createSignedTransaction({
    receiverId: opts.signerId,
    actions: [actions.functionCall("sign", args, teraToGas(300), 1n)],
  });
  const txHash = nearTxHash(signed);
  try {
    await account.provider.sendTransactionUntil(signed, "INCLUDED");
  } catch (e) {
    if (!MAYBE_SENT.test(String((e as Error)?.message ?? e))) throw e;
  }

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let r: RpcTransactionResponse | null = null;
    try {
      r = await account.provider.viewTransactionStatus({
        txHash,
        accountId: account.accountId,
        waitUntil: "EXECUTED_OPTIMISTIC",
      });
    } catch {
      r = null; // not known yet, or the RPC timed out waiting: ask again
    }
    const status = r?.status as { SuccessValue?: string; Failure?: unknown } | string | undefined;
    if (status && typeof status === "object") {
      if ("Failure" in status && status.Failure)
        throw new Error(`sign failed (NEAR tx ${txHash}): ${JSON.stringify(status.Failure)}`);
      if (typeof status.SuccessValue === "string") {
        const text = Buffer.from(status.SuccessValue, "base64").toString("utf8");
        return { value: JSON.parse(text), txHash };
      }
    }
    if (Date.now() >= deadline)
      throw new Error(`no signature after ${timeoutMs} ms; check NEAR tx ${txHash} on the explorer`);
    await wait(pollMs);
  }
}
