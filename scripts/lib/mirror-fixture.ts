/**
 * Test support: real signed EIP-1559 mirror transactions, shaped like eth_getTransactionByHash answers.
 *
 * A test MPC root key stands in for the signer contract's: the child key for (account, path) is
 * root + epsilon, so a transaction signed with it recovers to the address deriveEvmAddress gives.
 * Signing and serialisation use viem, an implementation independent of evm-mirror.ts's own RLP.
 */
import { keccak256, numberToHex, parseTransaction, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { b58encode } from "../../packages/shared/src/base58.ts";
import {
  MIRROR_PATH,
  type MirrorTx,
  mirrorCalldata,
  mpcEpsilon,
  SEPOLIA_CHAIN_ID,
} from "../../packages/shared/src/evm-mirror.ts";

const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
const skHex = (k: bigint) => numberToHex(k, { size: 32 });

/** A test root private key (never a real one). */
export const TEST_ROOT_SK = 0x1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988n;

/** The test root's public key in the signer contract's format: secp256k1:<base58 of x || y>. */
export function testRootKey(rootSk = TEST_ROOT_SK): string {
  const pub = privateKeyToAccount(skHex(rootSk)).publicKey; // 0x04 || x || y
  const xy = Uint8Array.from(Buffer.from(pub.slice(4), "hex"));
  return `secp256k1:${b58encode(xy)}`;
}

/** The child private key the MPC network would sign with for this account and path. */
export function childSk(accountId: string, path = MIRROR_PATH, rootSk = TEST_ROOT_SK): bigint {
  return (rootSk + mpcEpsilon(accountId, path)) % N;
}

export interface FixtureOpts {
  issuer: string;
  receiptId: string;
  receiptHash: string;
  /** Who signs (default: the child key derived for the issuer from the test root). */
  signerSk?: bigint;
  /** Recipient (default: the signer itself). */
  to?: string | null;
  data?: string;
  chainId?: number;
  /** null for a pending transaction (default: mined in block 0x10). */
  blockNumber?: string | null;
}

/** A signed type-2 mirror transaction, as eth_getTransactionByHash returns it. */
export async function signedMirrorTx(o: FixtureOpts): Promise<MirrorTx & { hash: string }> {
  const acct = privateKeyToAccount(skHex(o.signerSk ?? childSk(o.issuer)));
  const from = acct.address.toLowerCase();
  const to = o.to === undefined ? from : o.to;
  const raw = await acct.signTransaction({
    type: "eip1559",
    chainId: o.chainId ?? SEPOLIA_CHAIN_ID,
    nonce: 7,
    to: (to ?? undefined) as `0x${string}` | undefined,
    value: 0n,
    data: (o.data ?? mirrorCalldata(o.issuer, o.receiptId, o.receiptHash)) as `0x${string}`,
    gas: 30_000n,
    maxFeePerGas: 3_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
  });
  const p = parseTransaction(raw);
  return {
    hash: keccak256(raw),
    type: "0x2",
    chainId: toHex(p.chainId ?? 0),
    nonce: toHex(p.nonce ?? 0),
    maxPriorityFeePerGas: toHex(p.maxPriorityFeePerGas ?? 0n),
    maxFeePerGas: toHex(p.maxFeePerGas ?? 0n),
    gas: toHex(p.gas ?? 0n),
    to: p.to ? p.to.toLowerCase() : null,
    value: toHex(p.value ?? 0n),
    input: p.data ?? "0x",
    accessList: [],
    r: p.r as string,
    s: p.s as string,
    yParity: toHex(p.yParity ?? 0),
    v: toHex(p.yParity ?? 0),
    from,
    blockNumber: o.blockNumber === undefined ? "0x10" : o.blockNumber,
  };
}
