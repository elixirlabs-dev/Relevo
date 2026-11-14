/**
 * A real NEAR Intents pay-in through the 1Click API, called straight from the browser (1Click allows any
 * origin and needs no key). Mainnet only: 1Click has no testnet. This app never holds keys or moves
 * funds; it asks 1Click for a one-time deposit address and the user sends USDC from their own wallet.
 * Browser-safe: no Node APIs.
 */
export const ONECLICK_BASE = "https://1click.chaindefuser.com";

/** USDC on NEAR mainnet (6 decimals). */
export const USDC_NEAR = "nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1";

export type Origin = "base" | "arbitrum";

export const FUND_ORIGINS: Record<Origin, { chain: string; asset: string; explorer: string }> = {
  base: {
    chain: "Base",
    asset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
    explorer: "https://basescan.org/tx/",
  },
  arbitrum: {
    chain: "Arbitrum",
    asset: "nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near",
    explorer: "https://arbiscan.io/tx/",
  },
};

export const MIN_USDC = 1;
export const MAX_USDC = 100;
/** How long the deposit address stays open. */
export const DEADLINE_MS = 60 * 60_000;
/** 1% slippage limit, in basis points. */
export const SLIPPAGE_BPS = 100;

export interface FundingRequest {
  origin: Origin;
  /** USDC to send, with at most two decimals. */
  amountUsdc: string;
  /** NEAR mainnet account that receives the USDC. */
  recipient: string;
  /** Address on the origin chain that gets the deposit back if the swap does not go through. */
  refundTo: string;
  /** true: a price only, nothing reserved. false: a real quote with a deposit address. */
  dry: boolean;
}

export type FundingField = "origin" | "amountUsdc" | "recipient" | "refundTo";

export interface QuoteRequestBody {
  dry: boolean;
  swapType: "EXACT_INPUT";
  slippageTolerance: number;
  originAsset: string;
  destinationAsset: string;
  amount: string;
  depositType: "ORIGIN_CHAIN";
  refundTo: string;
  refundType: "ORIGIN_CHAIN";
  recipient: string;
  recipientType: "DESTINATION_CHAIN";
  deadline: string;
}

export interface Quote {
  /** Absent on a dry quote. */
  depositAddress?: string;
  depositMemo?: string;
  amountIn: string;
  amountInFormatted: string;
  amountInUsd?: string;
  amountOut: string;
  amountOutFormatted: string;
  amountOutUsd?: string;
  minAmountOut: string;
  /** Absent on a dry quote. */
  deadline?: string;
  /** Absent on a dry quote. */
  timeWhenInactive?: string;
  /** Seconds. */
  timeEstimate: number;
  refundFee?: string;
  withdrawFee?: string;
}

export interface QuoteResponse {
  quote: Quote;
  quoteRequest: Record<string, unknown>;
  signature: string;
  timestamp?: string;
  correlationId: string;
}

export type FundingStatus =
  | "PENDING_DEPOSIT"
  | "KNOWN_DEPOSIT_TX"
  | "PROCESSING"
  | "INCOMPLETE_DEPOSIT"
  | "SUCCESS"
  | "REFUNDED"
  | "FAILED";

/** A tx hash as 1Click lists it: a string, or `{ hash, explorerUrl }`. */
export type TxRef = string | { hash: string; explorerUrl?: string };

export interface SwapDetails {
  intentHashes?: string[];
  nearTxHashes?: TxRef[];
  originChainTxHashes?: TxRef[];
  destinationChainTxHashes?: TxRef[];
  amountIn?: string | null;
  amountInFormatted?: string | null;
  amountOut?: string | null;
  amountOutFormatted?: string | null;
  refundedAmount?: string | null;
  refundedAmountFormatted?: string | null;
  refundReason?: string | null;
}

export interface StatusResponse {
  correlationId?: string;
  status: FundingStatus;
  updatedAt?: string;
  swapDetails?: SwapDetails;
  quoteResponse?: QuoteResponse;
}

export type OneClickResult<T> =
  | { ok: true; data: T }
  | {
      ok: false;
      reason: "invalid" | "http" | "network" | "bad_response";
      message: string;
      field?: FundingField;
      status?: number;
    };

const NAMED_NEAR = /^(?=.{2,64}$)(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*\.near$/;
const IMPLICIT_NEAR = /^[0-9a-f]{64}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_TX = /^0x[0-9a-fA-F]{64}$/;
const AMOUNT = /^\d+(?:\.\d{1,2})?$/;

/** The first problem with a request, in words, or null when it is fine. */
export function validateFunding(r: FundingRequest): { field: FundingField; message: string } | null {
  if (!Object.hasOwn(FUND_ORIGINS, r.origin))
    return { field: "origin", message: "Choose Base or Arbitrum as the chain you send from." };
  const amount = r.amountUsdc.trim();
  if (!AMOUNT.test(amount) || Number(amount) < MIN_USDC || Number(amount) > MAX_USDC)
    return {
      field: "amountUsdc",
      message: `Enter an amount from ${MIN_USDC} to ${MAX_USDC} USDC, with at most two decimals.`,
    };
  const to = r.recipient.trim();
  if (!NAMED_NEAR.test(to) && !IMPLICIT_NEAR.test(to))
    return {
      field: "recipient",
      message:
        "Enter a NEAR mainnet account: a name ending in .near (lowercase), or a 64-character implicit account.",
    };
  if (!EVM_ADDRESS.test(r.refundTo.trim()))
    return {
      field: "refundTo",
      message: `Enter your refund address on ${FUND_ORIGINS[r.origin].chain}: 0x followed by 40 hex characters.`,
    };
  return null;
}

/** "1.50" → "1500000" (USDC has 6 decimals), without floating point. */
export function toUsdcUnits(amount: string): string {
  const [whole, frac = ""] = amount.trim().split(".");
  return (BigInt(whole) * 1_000_000n + BigInt(frac.padEnd(6, "0").slice(0, 6))).toString();
}

/** "3940" → "0.00394": 6-decimal units as a plain decimal, trailing zeros dropped. */
export function fromUsdcUnits(units: string | bigint): string {
  const n = BigInt(units);
  const neg = n < 0n;
  const abs = neg ? -n : n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${abs / 1_000_000n}${frac ? `.${frac}` : ""}`;
}

/** "1500000" → "1.50": the exact amount to send, never fewer than two decimals and never rounded. */
export function usdcExact(units: string | bigint): string {
  const [whole, frac = ""] = fromUsdcUnits(units).split(".");
  return `${whole}.${frac.padEnd(2, "0")}`;
}

/** The exact body 1Click's POST /v0/quote expects: USDC on the origin chain in, USDC on NEAR out. */
export function quoteBody(r: FundingRequest, now: number = Date.now()): QuoteRequestBody {
  return {
    dry: r.dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: SLIPPAGE_BPS,
    originAsset: FUND_ORIGINS[r.origin].asset,
    destinationAsset: USDC_NEAR,
    amount: toUsdcUnits(r.amountUsdc),
    depositType: "ORIGIN_CHAIN",
    refundTo: r.refundTo.trim(),
    refundType: "ORIGIN_CHAIN",
    recipient: r.recipient.trim(),
    recipientType: "DESTINATION_CHAIN",
    deadline: new Date(now + DEADLINE_MS).toISOString(),
  };
}

/** One call to 1Click: network errors, non-200 answers and non-JSON bodies become a reason in words. */
async function call(f: typeof fetch, path: string, init?: RequestInit): Promise<OneClickResult<unknown>> {
  let res: Response;
  try {
    res = await f(`${ONECLICK_BASE}${path}`, init);
  } catch {
    return {
      ok: false,
      reason: "network",
      message: "Could not reach NEAR Intents 1Click. Check your connection and try again.",
    };
  }
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    const said = (body as { message?: unknown } | null)?.message;
    const detail = Array.isArray(said) ? said.join("; ") : typeof said === "string" ? said : "";
    return {
      ok: false,
      reason: "http",
      status: res.status,
      message: `1Click turned the request down (HTTP ${res.status})${detail ? `: ${detail}` : "."}`,
    };
  }
  if (body === null || typeof body !== "object")
    return { ok: false, reason: "bad_response", message: "1Click sent an answer this page cannot read." };
  return { ok: true, data: body };
}

const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;

/**
 * Ask 1Click for a quote. `dry: true` is a price only; `dry: false` opens a one-time deposit address
 * (nothing moves until the user sends USDC to it from their own wallet).
 */
export async function quoteFunding(
  r: FundingRequest,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<OneClickResult<QuoteResponse>> {
  const bad = validateFunding(r);
  if (bad) return { ok: false, reason: "invalid", message: bad.message, field: bad.field };
  const res = await call(fetchImpl, "/v0/quote", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(quoteBody(r, now())),
  });
  if (!res.ok) return res;
  const q = (res.data as Partial<QuoteResponse>).quote;
  const complete =
    !!q && isStr(q.amountIn) && isStr(q.amountOut) && isStr(q.amountOutFormatted) && isStr(q.minAmountOut);
  if (!complete || (!r.dry && !(isStr(q.depositAddress) && isStr(q.deadline))))
    return {
      ok: false,
      reason: "bad_response",
      message: r.dry
        ? "1Click's price was incomplete. Try again."
        : "1Click did not return a deposit address. Nothing was reserved; try again.",
    };
  if (!r.dry) {
    const changed = mismatch(r, q, (res.data as Partial<QuoteResponse>).quoteRequest ?? {});
    if (changed)
      return {
        ok: false,
        reason: "bad_response",
        message: `1Click's quote does not match what you asked for: ${changed}. No deposit address is shown; do not send anything. Try again.`,
      };
  }
  return { ok: true, data: res.data as QuoteResponse };
}

/**
 * A real quote must be for exactly what was asked: the amount in (EXACT_INPUT), the tokens, the NEAR
 * account and the refund address. Returns what differs, in words, or null when everything matches.
 */
function mismatch(r: FundingRequest, q: Quote, echoed: Record<string, unknown>): string | null {
  const want = quoteBody(r);
  if (q.amountIn !== want.amount)
    return `the amount to send is ${q.amountInFormatted || q.amountIn} USDC, not ${usdcExact(want.amount)}`;
  if (echoed.originAsset !== want.originAsset || echoed.destinationAsset !== want.destinationAsset)
    return "the token is different";
  if (echoed.recipient !== want.recipient) return "the NEAR account that receives the USDC is different";
  if (typeof echoed.refundTo !== "string" || echoed.refundTo.toLowerCase() !== want.refundTo.toLowerCase())
    return "the refund address is different";
  return null;
}

export const STATUS_TEXT: Record<FundingStatus, string> = {
  PENDING_DEPOSIT: "Waiting for your deposit. Send the USDC from your own wallet.",
  KNOWN_DEPOSIT_TX: "Your deposit transaction has been seen. Waiting for it to confirm.",
  PROCESSING: "Deposit received. 1Click is swapping it and delivering the USDC to NEAR.",
  INCOMPLETE_DEPOSIT:
    "The deposit is smaller than the quoted amount, so it is not swapped. 1Click should refund it to your refund address.",
  SUCCESS: "Delivered. The USDC is in the NEAR account.",
  REFUNDED: "Refunded. The swap did not go through, and the deposit went back to your refund address.",
  FAILED: "Failed. The swap did not complete. Keep the deposit address: 1Click support can trace it.",
};

export function isFundingStatus(s: unknown): s is FundingStatus {
  return typeof s === "string" && Object.hasOwn(STATUS_TEXT, s);
}

export function describeStatus(s: string): string {
  return isFundingStatus(s) ? STATUS_TEXT[s] : `1Click reports a status this page does not know: ${s}.`;
}

export function isTerminal(s: FundingStatus): boolean {
  return s === "SUCCESS" || s === "REFUNDED" || s === "FAILED";
}

export type StepState = "done" | "current" | "todo" | "stopped";

const STEP_LABELS = [
  "Waiting for your deposit",
  "Deposit seen",
  "Swapping and delivering",
  "Delivered",
] as const;

/** How far each status got along the four steps (4 = all done). */
const REACHED: Record<FundingStatus, number> = {
  PENDING_DEPOSIT: 0,
  KNOWN_DEPOSIT_TX: 1,
  INCOMPLETE_DEPOSIT: 1,
  PROCESSING: 2,
  SUCCESS: 4,
  REFUNDED: 2,
  FAILED: 2,
};

export function fundingSteps(s: FundingStatus): Array<{ label: string; state: StepState }> {
  const at = REACHED[s];
  const stopped = s === "REFUNDED" || s === "FAILED";
  return STEP_LABELS.map((label, i) => ({
    label,
    state: i < at ? "done" : i === at ? (stopped ? "stopped" : "current") : "todo",
  }));
}

/**
 * GET /v0/status for a deposit address (and its memo, when the quote returned one). 1Click answers "not
 * found" until it has seen something for a fresh address, so that reads as still waiting for the deposit.
 */
export async function fundingStatus(
  depositAddress: string,
  fetchImpl: typeof fetch = fetch,
  depositMemo?: string,
): Promise<OneClickResult<StatusResponse>> {
  const memo = depositMemo ? `&depositMemo=${encodeURIComponent(depositMemo)}` : "";
  const res = await call(fetchImpl, `/v0/status?depositAddress=${encodeURIComponent(depositAddress)}${memo}`);
  if (!res.ok && res.reason === "http" && (res.status === 404 || /not found/i.test(res.message)))
    return { ok: true, data: { status: "PENDING_DEPOSIT" } };
  if (!res.ok) return res;
  const status = (res.data as { status?: unknown }).status;
  if (!isFundingStatus(status))
    return {
      ok: false,
      reason: "bad_response",
      message: `1Click reports a status this page does not know: ${String(status)}.`,
    };
  return { ok: true, data: res.data as StatusResponse };
}

/** Optional: tell 1Click the origin-chain tx that paid the deposit address, so it is picked up sooner. */
export async function submitDeposit(
  txHash: string,
  depositAddress: string,
  fetchImpl: typeof fetch = fetch,
): Promise<OneClickResult<unknown>> {
  const tx = txHash.trim();
  if (!EVM_TX.test(tx))
    return { ok: false, reason: "invalid", message: "A tx hash is 0x followed by 64 hex characters." };
  return call(fetchImpl, "/v0/deposit/submit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ txHash: tx, depositAddress }),
  });
}

export function originTxUrl(origin: Origin, hash: string): string {
  return `${FUND_ORIGINS[origin].explorer}${hash}`;
}

export function nearTxUrl(hash: string): string {
  return `https://nearblocks.io/txns/${hash}`;
}

/** The hashes in a 1Click list, whichever form each entry takes; anything else is skipped. */
export function txHashes(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((x) =>
    typeof x === "string" && x
      ? [x]
      : x && typeof x === "object" && isStr((x as { hash?: unknown }).hash)
        ? [(x as { hash: string }).hash]
        : [],
  );
}

/** Polling stops ten minutes after the deposit deadline. */
export function pollingEndsAt(deadline: string): number {
  return Date.parse(deadline) + 10 * 60_000;
}

/** The deposit being watched, kept in localStorage so a reload resumes polling. No keys, nothing secret. */
export interface ActiveDeposit {
  depositAddress: string;
  depositMemo?: string;
  origin: Origin;
  /** 6-decimal units: the exact amount to send, checked against the request. */
  amountIn: string;
  amountOutFormatted: string;
  deadline: string;
  recipient: string;
  /** Origin-chain address that gets the deposit back if the swap does not go through. */
  refundTo: string;
}

export const ACTIVE_KEY = "relevo-fund-active";

export function saveActive(storage: Storage | null, a: ActiveDeposit): void {
  try {
    storage?.setItem(ACTIVE_KEY, JSON.stringify(a));
  } catch {
    // Storage full or blocked: polling still works until the page is closed.
  }
}

export function loadActive(storage: Storage | null): ActiveDeposit | null {
  try {
    const raw = storage?.getItem(ACTIVE_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<ActiveDeposit>;
    const ok =
      isStr(a.depositAddress) &&
      typeof a.origin === "string" &&
      Object.hasOwn(FUND_ORIGINS, a.origin) &&
      typeof a.amountIn === "string" &&
      /^\d+$/.test(a.amountIn) &&
      isStr(a.amountOutFormatted) &&
      isStr(a.deadline) &&
      !Number.isNaN(Date.parse(a.deadline)) &&
      isStr(a.recipient) &&
      isStr(a.refundTo);
    return ok ? (a as ActiveDeposit) : null;
  } catch {
    return null;
  }
}

export function clearActive(storage: Storage | null): void {
  try {
    storage?.removeItem(ACTIVE_KEY);
  } catch {
    // Nothing to do: the entry stays until the browser clears it.
  }
}
