/**
 * The visitor's receipt keys (kept in this browser) and the one registry transaction /issue and /check
 * both send: publish the keys if the registry doesn't have exactly this set, then anchor a hash.
 */
import { ed25519PublicKeyStr } from "@elivo/shared/direct-build";
import { ANCHOR_DEPOSIT, KEYS_DEPOSIT } from "@elivo/shared/direct-receipt";
import { type MlDsaKey, mldsaFromSeed } from "@elivo/shared/pq-keys";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { FunctionCallSpec, TxSpec } from "./txs.ts";

const TGAS = 1_000_000_000_000n;
const random32 = () => crypto.getRandomValues(new Uint8Array(32));

export interface IssuerKeys {
  edSeed: Uint8Array;
  edPk: string;
  pq: MlDsaKey;
}

/**
 * The visitor's receipt keys for this account: created on first use and kept in this browser, so later
 * receipts reuse the key set already published. Works (with fresh keys) when storage is blocked.
 */
export function issuerKeys(account: string, storage: Storage | null): IssuerKeys {
  const id = `elivo-issuer-keys:${account}`;
  let saved: { ed: string; pq: string } | null = null;
  try {
    const raw = storage?.getItem(id);
    saved = raw ? JSON.parse(raw) : null;
  } catch {
    saved = null;
  }
  const valid = (s: unknown) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s);
  if (!saved || !valid(saved.ed) || !valid(saved.pq)) {
    saved = { ed: bytesToHex(random32()), pq: bytesToHex(random32()) };
    try {
      storage?.setItem(id, JSON.stringify(saved));
    } catch {}
  }
  const edSeed = hexToBytes(saved.ed);
  return { edSeed, edPk: ed25519PublicKeyStr(edSeed), pq: mldsaFromSeed(hexToBytes(saved.pq)) };
}

function call(methodName: string, args: object, deposit: bigint): FunctionCallSpec {
  return {
    type: "FunctionCall",
    params: { methodName, args, gas: (30n * TGAS).toString(), deposit: deposit.toString() },
  };
}

/**
 * The one transaction /issue and /check send to the registry: publish the visitor's receipt keys if the
 * registry doesn't have exactly this set yet, then anchor the document's hash under its id.
 */
export function publishKeysThenAnchorTx(p: {
  registry: string;
  keys: IssuerKeys;
  postQuantum: boolean;
  currentKeys: { receipt_pk: string; mldsa65_pk: string | null } | null;
  id: string;
  hash: string;
}): TxSpec {
  const wantPq = p.postQuantum ? p.keys.pq.publicKeyB64 : null;
  const cur = p.currentKeys;
  const publish = !cur || cur.receipt_pk !== p.keys.edPk || (cur.mldsa65_pk ?? null) !== wantPq;
  const actions = [
    ...(publish ? [call("set_keys", { receipt_pk: p.keys.edPk, mldsa65_pk: wantPq }, KEYS_DEPOSIT)] : []),
    call("anchor", { receipt_id: p.id, receipt_hash: p.hash }, ANCHOR_DEPOSIT),
  ];
  return { receiverId: p.registry, actions };
}
