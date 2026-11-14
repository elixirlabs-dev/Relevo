/**
 * Mirroring a receipt anchor onto Ethereum Sepolia with NEAR Chain Signatures (browser-safe).
 *
 * The issuer's NEAR account asks NEAR's MPC network (the signer contract) to sign an Ethereum
 * transaction. The MPC network signs with a key derived from its root key, the issuer's account id and
 * a path, so anyone can work out which Ethereum address belongs to which NEAR account from public data:
 *
 *   epsilon = sha3_256("near-mpc-recovery v0.1.0 epsilon derivation:" + accountId + "," + path)
 *   child   = root + epsilon·G
 *   address = keccak256(child x || y)[12:]
 *
 * The mirror transaction is a 0-value self-send whose data is utf8 `elivo-mirror-1:<issuer>/<id>:<hash>`.
 */
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256, sha3_256 } from "@noble/hashes/sha3.js";
import { bytesToHex, concatBytes, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { b58decode } from "./base58.ts";

export const MIRROR_PATH = "elivo-receipt-mirror";
/** The testnet signer contract (v1.signer-prod.testnet) root key, as its `public_key` view returns it. */
export const TESTNET_MPC_ROOT =
  "secp256k1:4NfTiv3UsGahebgTaHyD9vF8KYKMBnfd6kh94mK6xv8fGBiJB8TBtFMP5WWXz6B89Ac1fbpzPwAvoyQebemHFwx3";
export const TESTNET_MPC_SIGNER = "v1.signer-prod.testnet";
export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_RPCS = [
  "https://ethereum-sepolia-rpc.publicnode.com",
  "https://sepolia.gateway.tenderly.co",
] as const;
export const sepoliaTxUrl = (hash: string) => `https://sepolia.etherscan.io/tx/${hash}`;

const EPSILON_PREFIX = "near-mpc-recovery v0.1.0 epsilon derivation:";
const MIRROR_PREFIX = "elivo-mirror-1:";

/** The child public key (uncompressed, 65 bytes) the MPC network signs with for this account and path. */
export function derivePublicKey(rootKey: string, accountId: string, path: string): Uint8Array {
  const [curve, b58] = rootKey.split(":");
  if (curve !== "secp256k1" || !b58) throw new Error(`not a secp256k1 root key: ${rootKey}`);
  const xy = b58decode(b58);
  if (xy.length !== 64) throw new Error(`a secp256k1 root key is 64 bytes, got ${xy.length}`);
  const root = secp256k1.Point.fromBytes(concatBytes(new Uint8Array([4]), xy));
  return root.add(secp256k1.Point.BASE.multiply(mpcEpsilon(accountId, path))).toBytes(false);
}

/** The tweak the MPC network adds to its root key for this account and path. */
export function mpcEpsilon(accountId: string, path: string): bigint {
  return BigInt(`0x${bytesToHex(sha3_256(utf8ToBytes(`${EPSILON_PREFIX}${accountId},${path}`)))}`);
}

/** The Ethereum address of an uncompressed secp256k1 public key (0x04 || x || y), lower case. */
export function evmAddressOf(uncompressed: Uint8Array): string {
  return `0x${bytesToHex(keccak_256(uncompressed.slice(1)).slice(12))}`;
}

export function deriveEvmAddress(rootKey: string, accountId: string, path: string): string {
  return evmAddressOf(derivePublicKey(rootKey, accountId, path));
}

export interface MirrorRecord {
  issuer: string;
  receipt_id: string;
  receipt_hash: string;
}

export function mirrorCalldata(issuer: string, receiptId: string, receiptHashB58: string): string {
  return `0x${bytesToHex(utf8ToBytes(`${MIRROR_PREFIX}${issuer}/${receiptId}:${receiptHashB58}`))}`;
}

/** The record a mirror transaction's data carries, or null if it is not one. */
export function parseMirrorCalldata(hex: string): MirrorRecord | null {
  let text: string;
  try {
    const h = hex.startsWith("0x") ? hex.slice(2) : hex;
    text = new TextDecoder("utf-8", { fatal: true }).decode(hexToBytes(h));
  } catch {
    return null;
  }
  if (!text.startsWith(MIRROR_PREFIX)) return null;
  const rest = text.slice(MIRROR_PREFIX.length);
  // Account ids have no "/" and base58 has no ":": issuer up to the first "/", hash after the last ":".
  const slash = rest.indexOf("/");
  const colon = rest.lastIndexOf(":");
  if (slash <= 0 || colon <= slash + 1 || colon === rest.length - 1) return null;
  return {
    issuer: rest.slice(0, slash),
    receipt_id: rest.slice(slash + 1, colon),
    receipt_hash: rest.slice(colon + 1),
  };
}

/**
 * A transaction as eth_getTransactionByHash returns it (hex quantities). `from` is what the RPC claims
 * and is never trusted: the sender is recovered from the signature over the other fields.
 */
export interface MirrorTx {
  type?: string;
  chainId?: string;
  nonce: string;
  maxPriorityFeePerGas?: string;
  maxFeePerGas?: string;
  gas: string;
  to: string | null;
  value: string;
  input: string;
  accessList?: ReadonlyArray<{ address: string; storageKeys: readonly string[] }>;
  r: string;
  s: string;
  yParity?: string;
  /** For type-2 transactions the same as yParity. */
  v?: string;
  /** As the RPC reports it; not used for any check. */
  from?: string;
  /** null while the transaction is pending. */
  blockNumber?: string | null;
}

type Rlp = Uint8Array | Rlp[];

const lengthPrefix = (len: number, offset: number): Uint8Array => {
  if (len < 56) return new Uint8Array([offset + len]);
  const be = qtyBytes(BigInt(len));
  return concatBytes(new Uint8Array([offset + 55 + be.length]), be);
};

/** Recursive Length Prefix encoding (Ethereum yellow paper, appendix B). */
export function rlpEncode(x: Rlp): Uint8Array {
  if (x instanceof Uint8Array)
    return x.length === 1 && x[0] < 0x80 ? x : concatBytes(lengthPrefix(x.length, 0x80), x);
  const body = concatBytes(...x.map(rlpEncode));
  return concatBytes(lengthPrefix(body.length, 0xc0), body);
}

/** A quantity as minimal big-endian bytes (zero is empty). */
function qtyBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array();
  let h = n.toString(16);
  if (h.length % 2) h = `0${h}`;
  return hexToBytes(h);
}
const qty = (hex: string | undefined, name: string): Uint8Array => {
  if (hex === undefined || hex === null) throw new Error(`the transaction has no ${name}`);
  return qtyBytes(BigInt(hex));
};
const data = (hex: string): Uint8Array => {
  const h = hex.startsWith("0x") ? hex.slice(2) : hex;
  return hexToBytes(h.length % 2 ? `0${h}` : h);
};

const isType2 = (tx: MirrorTx) => tx.type !== undefined && tx.type !== null && BigInt(tx.type) === 2n;

/** 0x02 || rlp([chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gas, to, value, data, accessList]). */
export function unsignedType2Payload(tx: MirrorTx): Uint8Array {
  if (!isType2(tx)) throw new Error("not an EIP-1559 (type 2) transaction");
  const fields: Rlp = [
    qty(tx.chainId, "chainId"),
    qty(tx.nonce, "nonce"),
    qty(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    qty(tx.maxFeePerGas, "maxFeePerGas"),
    qty(tx.gas, "gas"),
    tx.to ? data(tx.to) : new Uint8Array(),
    qty(tx.value, "value"),
    data(tx.input),
    (tx.accessList ?? []).map((a) => [data(a.address), a.storageKeys.map(data)]),
  ];
  return concatBytes(new Uint8Array([2]), rlpEncode(fields));
}

/**
 * The address that signed a type-2 transaction, recovered from r, s and yParity over the rebuilt
 * unsigned payload. Throws for any other transaction type.
 */
export function recoverMirrorSender(tx: MirrorTx): string {
  if (!isType2(tx)) throw new Error("not an EIP-1559 (type 2) transaction");
  const hash = keccak_256(unsignedType2Payload(tx));
  const parity = Number(BigInt(tx.yParity ?? tx.v ?? "0x"));
  if (parity !== 0 && parity !== 1) throw new Error(`bad yParity ${tx.yParity ?? tx.v}`);
  const sig = new secp256k1.Signature(BigInt(tx.r), BigInt(tx.s), parity);
  return evmAddressOf(sig.recoverPublicKey(hash).toBytes(false));
}

export interface MirrorVerdict {
  ok: boolean;
  problems: string[];
  /** The Ethereum address NEAR's MPC network derives for the issuer. */
  expectedFrom: string;
  /** The sender recovered from the signature, or null if it couldn't be. */
  recoveredFrom: string | null;
  checks: {
    type2: boolean;
    from: boolean;
    selfSend: boolean;
    payload: boolean;
    chain: boolean;
    included: boolean;
  };
}

/**
 * Checks a Sepolia transaction mirrors the expected anchor: a type-2 transaction whose signature
 * recovers to the issuer's derived address, sent to itself, on Sepolia, included in a block, carrying
 * exactly this issuer, receipt id and hash. `receipt_hash` must come from the chain anchor, not from the
 * receipt file. Nothing the RPC says about the sender is trusted.
 */
export function verifyMirrorTx(tx: MirrorTx, expected: MirrorRecord & { rootKey: string }): MirrorVerdict {
  const problems: string[] = [];
  const expectedFrom = deriveEvmAddress(expected.rootKey, expected.issuer, MIRROR_PATH);
  const type2 = isType2(tx);
  let from: string | null = null;
  if (!type2) problems.push("Not an EIP-1559 (type 2) transaction, so its sender can't be checked");
  else
    try {
      from = recoverMirrorSender(tx);
    } catch (e) {
      problems.push(`The signature does not recover to a sender: ${(e as Error).message}`);
    }
  const fromOk = from === expectedFrom;
  if (from && !fromOk)
    problems.push(`Signed by ${from}, not ${expectedFrom}, the address derived for ${expected.issuer}`);

  const to = tx.to?.toLowerCase() ?? null;
  const selfSend = to !== null && to === from;
  if (!selfSend) problems.push(`Sent to ${to ?? "no address"}, not back to itself`);

  const rec = parseMirrorCalldata(tx.input);
  const want = `${expected.issuer}/${expected.receipt_id}:${expected.receipt_hash}`;
  const payload =
    !!rec &&
    rec.issuer === expected.issuer &&
    rec.receipt_id === expected.receipt_id &&
    rec.receipt_hash === expected.receipt_hash;
  if (!rec) problems.push("The transaction data is not an elivo-mirror-1 record");
  else if (!payload)
    problems.push(`Carries ${rec.issuer}/${rec.receipt_id}:${rec.receipt_hash}, not ${want}`);

  let chain = false;
  if (tx.chainId === undefined || tx.chainId === null)
    problems.push("The transaction names no chain id, so it is not bound to Ethereum Sepolia");
  else {
    const id = Number(BigInt(tx.chainId));
    chain = id === SEPOLIA_CHAIN_ID;
    if (!chain) problems.push(`On chain ${id}, not Ethereum Sepolia (${SEPOLIA_CHAIN_ID})`);
  }

  const included = tx.blockNumber !== undefined && tx.blockNumber !== null;
  if (!included) problems.push("Not yet included in a block");

  return {
    ok: problems.length === 0,
    problems,
    expectedFrom,
    recoveredFrom: from,
    checks: { type2, from: fromOk, selfSend, payload, chain, included },
  };
}

/**
 * One Ethereum JSON-RPC call to Sepolia, trying each RPC in turn (both allow any origin, so the browser
 * calls them directly). Throws the last error when none answers.
 */
export async function sepoliaRpc<T = unknown>(
  method: string,
  params: unknown[],
  opts: { fetch?: typeof fetch; urls?: readonly string[] } = {},
): Promise<T> {
  const f = opts.fetch ?? fetch;
  let last: Error = new Error(`${method}: no Sepolia RPC`);
  for (const url of opts.urls ?? SEPOLIA_RPCS) {
    try {
      const res = await f(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      const body = (await res.json().catch(() => null)) as {
        result?: T;
        error?: { message?: string };
      } | null;
      if (!body) throw new Error(`HTTP ${res.status}`);
      if (body.error) throw new Error(body.error.message ?? JSON.stringify(body.error));
      return body.result as T;
    } catch (e) {
      last = new Error(`${method}: ${(e as Error).message}`);
    }
  }
  throw last;
}

/** One entry of apps/web/public/receipts/mirrors.json. */
export interface MirrorEntry extends MirrorRecord {
  chain: "sepolia";
  tx_hash: string;
  from: string;
}

/** Adds or replaces the entry for this issuer/receipt id; sorted by issuer, then receipt id. */
export function upsertMirror(list: MirrorEntry[], entry: MirrorEntry): MirrorEntry[] {
  const rest = list.filter((m) => !(m.issuer === entry.issuer && m.receipt_id === entry.receipt_id));
  return [...rest, entry].sort((a, b) =>
    a.issuer === b.issuer ? (a.receipt_id < b.receipt_id ? -1 : 1) : a.issuer < b.issuer ? -1 : 1,
  );
}
