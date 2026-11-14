/**
 * "Issue a receipt": everything the /issue page does before and after the wallet signs. The browser
 * parses the payout results, signs the receipt with the visitor's own receipt keys (ed25519, plus
 * ML-DSA-65 if chosen), and builds one transaction to the registry: publish the keys if they changed,
 * then anchor the receipt. Names and account numbers never leave the browser.
 */
import {
  buildDirectReceipt,
  directHashB58Sync,
  ed25519PublicKeyStr,
  parseResultsCsv,
  signDirectReceiptWeb,
} from "@elivo/shared/direct-build";
import {
  ANCHOR_DEPOSIT,
  type DirectReceipt,
  isDirectReceipt,
  KEYS_DEPOSIT,
  RECEIPT_ID,
} from "@elivo/shared/direct-receipt";
import { type MlDsaKey, mldsaFromSeed } from "@elivo/shared/pq-keys";
import type { FunctionCallSpec, TxSpec } from "./txs.ts";

export const SAMPLE_RESULTS_CSV = `name,account,amount,status,paid_at,reference
Lucía Fernández,002010077777777771,37000.00,paid,2026-11-14T15:02:11Z,SIM-SPEI-20261114-0001
Mateo Ríos,032180000118359719,37000.00,paid,2026-11-14T15:02:40Z,SIM-SPEI-20261114-0002
Sofía Herrera,012180001234567899,27750.00,returned,,ACCOUNT_CLOSED
Diego Navarro,072180009876543213,46250.00,paid,2026-11-14T15:03:05Z,SIM-SPEI-20261114-0004
Valentina Cruz,646180005555555554,18500.00,paid,2026-11-14T15:03:31Z,SIM-SPEI-20261114-0005
`;

/** Where the signed receipt waits while the wallet signs (a wallet may reload the page). */
export const PENDING_KEY = "elivo-pending-receipt";
const TGAS = 1_000_000_000_000n;

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
const unhex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (h) => Number.parseInt(h, 16));
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
    saved = { ed: hex(random32()), pq: hex(random32()) };
    try {
      storage?.setItem(id, JSON.stringify(saved));
    } catch {}
  }
  const edSeed = unhex(saved.ed);
  return { edSeed, edPk: ed25519PublicKeyStr(edSeed), pq: mldsaFromSeed(unhex(saved.pq)) };
}

export interface IssueInput {
  csv: string;
  rail: string;
  currency: string;
  receiptId: string;
  account: string;
  registry: string;
  network: string;
  postQuantum: boolean;
  /** The account's current key set in the registry (get_keys), or null if it has none. */
  currentKeys: { receipt_pk: string; mldsa65_pk: string | null } | null;
}

export type Prepared =
  | { ok: true; receipt: DirectReceipt; hash: string; tx: TxSpec }
  | { ok: false; errors: string[] };

function call(methodName: string, args: object, deposit: bigint): FunctionCallSpec {
  return {
    type: "FunctionCall",
    params: { methodName, args, gas: (30n * TGAS).toString(), deposit: deposit.toString() },
  };
}

export function prepareIssue(input: IssueInput, storage: Storage | null): Prepared {
  const errors: string[] = [];
  if (!RECEIPT_ID.test(input.receiptId))
    errors.push("Receipt id: 1 to 64 letters, digits, dots, dashes or underscores");
  if (!/^[A-Z]{3}$/.test(input.currency)) errors.push("Currency: a 3-letter code such as MXN");
  const parsed = parseResultsCsv(input.csv, { rail: input.rail });
  for (const e of parsed.errors) errors.push(e.row ? `Row ${e.row}: ${e.reason}` : e.reason);
  if (!errors.length && parsed.rows.length === 0) errors.push("No payouts in the CSV");
  if (errors.length) return { ok: false, errors };

  const keys = issuerKeys(input.account, storage);
  const pq = input.postQuantum ? keys.pq : undefined;
  const receipt = signDirectReceiptWeb(
    buildDirectReceipt(parsed.rows, {
      network: input.network,
      registry: input.registry,
      issuer: input.account,
      receipt_id: input.receiptId,
      rail: input.rail,
      currency: input.currency,
      salt: crypto.getRandomValues(new Uint8Array(16)),
    }),
    keys.edSeed,
    pq,
  );
  const wantPq = pq?.publicKeyB64 ?? null;
  const cur = input.currentKeys;
  const publish = !cur || cur.receipt_pk !== keys.edPk || (cur.mldsa65_pk ?? null) !== wantPq;
  const hash = directHashB58Sync(receipt);
  const actions = [
    ...(publish ? [call("set_keys", { receipt_pk: keys.edPk, mldsa65_pk: wantPq }, KEYS_DEPOSIT)] : []),
    call("anchor", { receipt_id: input.receiptId, receipt_hash: hash }, ANCHOR_DEPOSIT),
  ];
  return { ok: true, receipt, hash, tx: { receiverId: input.registry, actions } };
}

/** The receipt waiting for its anchor transaction, if any. */
export function readPending(storage: Storage | null): DirectReceipt | null {
  try {
    const raw = storage?.getItem(PENDING_KEY);
    const r = raw ? JSON.parse(raw) : null;
    return isDirectReceipt(r) ? r : null;
  } catch {
    return null;
  }
}
