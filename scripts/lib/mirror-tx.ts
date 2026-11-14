/**
 * The Sepolia side of `pnpm mirror-receipt`: build the 0-value self-send, hash it for the MPC network,
 * turn the signer contract's answer into an Ethereum signature, and assemble the signed transaction.
 */
import {
  hexToBytes,
  keccak256,
  recoverAddress,
  serializeTransaction,
  type TransactionSerializableEIP1559,
} from "viem";
import { SEPOLIA_CHAIN_ID, sepoliaTxUrl } from "../../packages/shared/src/evm-mirror.ts";

type Hex = `0x${string}`;
const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

/**
 * Intrinsic gas for a plain transfer carrying `data`, with a 10% margin. Since EIP-7623 (Pectra) a
 * calldata-heavy transaction pays at least 21000 + 10 per calldata token (zero byte 1 token, other 4).
 */
export function mirrorGasLimit(data: string): bigint {
  const bytes = hexToBytes(data as Hex);
  const nz = bytes.filter((b) => b !== 0).length;
  const z = bytes.length - nz;
  const standard = 21_000 + 16 * nz + 4 * z;
  const floor = 21_000 + 10 * (z + 4 * nz);
  return BigInt(Math.ceil(Math.max(standard, floor) * 1.1));
}

export function buildMirrorTx(p: {
  from: string;
  data: string;
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}): TransactionSerializableEIP1559 {
  return {
    type: "eip1559",
    chainId: SEPOLIA_CHAIN_ID,
    to: p.from as Hex,
    value: 0n,
    data: p.data as Hex,
    nonce: p.nonce,
    gas: mirrorGasLimit(p.data),
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
  };
}

/** The 32-byte hash the MPC network signs: keccak256 of the unsigned EIP-1559 serialisation. */
export function mirrorSigningHash(tx: TransactionSerializableEIP1559): Hex {
  return keccak256(serializeTransaction(tx));
}

export interface EvmSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
}

const str = (v: unknown, key: string): string | null =>
  typeof v === "string"
    ? v
    : v && typeof v === "object" && typeof (v as Record<string, unknown>)[key] === "string"
      ? ((v as Record<string, unknown>)[key] as string)
      : null;

/**
 * Reads the signer contract's `sign` result: `{ big_r: { affine_point } | string, s: { scalar } | string,
 * recovery_id }`. r is big_r's x coordinate; s is normalised to low s (EIP-2), flipping the parity.
 */
export function signatureFromMpc(resp: unknown): EvmSignature {
  const o = (resp ?? {}) as Record<string, unknown>;
  const bigR = str(o.big_r, "affine_point");
  const sHex = str(o.s, "scalar");
  const rec = o.recovery_id;
  if (!bigR || !sHex || (rec !== 0 && rec !== 1))
    throw new Error(`unreadable MPC signature: ${JSON.stringify(resp)}`);
  const R = bigR.replace(/^0x/i, "").toLowerCase();
  if (!/^0[23][0-9a-f]{64}$/.test(R)) throw new Error(`MPC big_r is not a compressed point: ${bigR}`);
  let s = BigInt(`0x${sHex.replace(/^0x/i, "")}`);
  let yParity = rec as 0 | 1;
  if (s > N / 2n) {
    s = N - s;
    yParity = (yParity ^ 1) as 0 | 1;
  }
  return { r: `0x${R.slice(2)}`, s: `0x${s.toString(16).padStart(64, "0")}`, yParity };
}

/** The address that signed `hash`, lower case. */
export async function recoverSigner(hash: Hex, sig: EvmSignature): Promise<string> {
  return (await recoverAddress({ hash, signature: sig })).toLowerCase();
}

export function assembleSignedTx(tx: TransactionSerializableEIP1559, sig: EvmSignature): Hex {
  return serializeTransaction(tx, sig);
}

type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;
/** The node already has this exact transaction, or its nonce is used (by it, if it was sent before). */
const ALREADY_SENT = /already known|known transaction|nonce too low/i;
/** The reply may have been lost after the node accepted the transaction. */
const MAYBE_SENT = /timeout|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|\bHTTP 50[234]\b|\b429\b/i;

/**
 * Broadcasts a signed transaction and waits for it to be mined. The hash is computed locally
 * (keccak256 of the raw bytes), so a lost reply, "already known" or "nonce too low" still lead to
 * polling for this exact transaction; any other send error throws before polling.
 */
export async function broadcastMirror(
  raw: Hex,
  rpc: Rpc,
  opts: { pollMs?: number; attempts?: number } = {},
): Promise<{ txHash: Hex; receipt: { status: string; blockNumber: string } }> {
  const txHash = keccak256(raw);
  try {
    const reply = await rpc<string>("eth_sendRawTransaction", [raw]);
    if (typeof reply === "string" && reply.toLowerCase() !== txHash)
      throw new Error(`the RPC answered ${reply}, not the local hash ${txHash}`);
  } catch (e) {
    const msg = (e as Error).message;
    if (/not the local hash/.test(msg) || !(ALREADY_SENT.test(msg) || MAYBE_SENT.test(msg))) throw e;
    console.log(`Send answered "${msg}": looking for ${txHash} on Sepolia`);
  }
  const attempts = opts.attempts ?? 40;
  for (let i = 0; i < attempts; i++) {
    await new Promise((r) => setTimeout(r, opts.pollMs ?? 3_000));
    const receipt = await rpc<{ status: string; blockNumber: string } | null>("eth_getTransactionReceipt", [
      txHash,
    ]).catch(() => null);
    if (receipt) return { txHash, receipt };
  }
  throw new Error(
    `${txHash} is not mined after ${attempts} checks (if the send said "nonce too low", another transaction may have used the nonce): ${sepoliaTxUrl(txHash)}`,
  );
}
