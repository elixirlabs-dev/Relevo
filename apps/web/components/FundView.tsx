"use client";
import { useEffect, useRef, useState } from "react";
import {
  type ActiveDeposit,
  clearActive,
  describeStatus,
  FUND_ORIGINS,
  fromUsdcUnits,
  fundingStatus,
  fundingSteps,
  isTerminal,
  loadActive,
  nearTxUrl,
  type Origin,
  originTxUrl,
  pollingEndsAt,
  type QuoteResponse,
  quoteFunding,
  type StatusResponse,
  type StepState,
  saveActive,
  submitDeposit,
  txHashes,
  usdcExact,
} from "../lib/oneclick.ts";
import { Button, Eyebrow, Window } from "./ui.tsx";

export const FUND_MAINNET_WARNING =
  "Mainnet. Real money. This is separate from the testnet demo: USDC arrives in a NEAR mainnet account you choose, not in the testnet escrow.";

export const DEADLINE_PASSED =
  "Deadline passed. Do not send to this address; funds sent now may be lost. Start over for a new address.";

const local = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

/** "2026-11-14T21:22:10.507Z" → "2026-11-14 21:22 UTC". */
const utc = (iso: string) => `${new Date(iso).toISOString().slice(0, 16).replace("T", " ")} UTC`;
const short = (h: string) => (h.length > 14 ? `${h.slice(0, 10)}…` : h);

/** The mark and the word for each step state, so progress never depends on colour. */
const STEP_MARK: Record<StepState, { mark: string; word: string }> = {
  done: { mark: "✓", word: "Done" },
  current: { mark: "→", word: "In progress" },
  todo: { mark: "○", word: "Not yet" },
  stopped: { mark: "✗", word: "Stopped" },
};

export interface FundViewProps {
  /** Injectable for tests; defaults to the browser's fetch. */
  fetchImpl?: typeof fetch;
  /** Where the active deposit is kept (default: localStorage, when the browser allows it). */
  storage?: Storage | null;
  now?: () => number;
  /** How often to ask 1Click for the status (default 5 s). */
  pollMs?: number;
  copy?: (s: string) => Promise<void>;
}

export function FundView({
  fetchImpl,
  storage,
  now = Date.now,
  pollMs = 5_000,
  copy = (s: string) => navigator.clipboard.writeText(s),
}: FundViewProps) {
  const f: typeof fetch = fetchImpl ?? ((...a) => fetch(...a));
  const store = useRef<Storage | null>(null);
  const [origin, setOrigin] = useState<Origin>("base");
  const [amount, setAmount] = useState("1.50");
  const [recipient, setRecipient] = useState("");
  const [refundTo, setRefundTo] = useState("");
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState<"price" | "deposit" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [price, setPrice] = useState<QuoteResponse | null>(null);
  const [active, setActive] = useState<ActiveDeposit | null>(null);
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [stopped, setStopped] = useState(false);
  const [copied, setCopied] = useState<boolean | null>(null);
  const [txHash, setTxHash] = useState("");
  const [txNote, setTxNote] = useState<{ ok: boolean; text: string } | null>(null);
  const chain = FUND_ORIGINS[origin].chain;

  // A reload picks the active deposit back up and resumes polling.
  useEffect(() => {
    store.current = storage === undefined ? local() : storage;
    const saved = loadActive(store.current);
    if (saved) setActive(saved);
  }, []);

  // Poll every pollMs until a final status, or until ten minutes after the deadline (one last look then).
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const end = pollingEndsAt(active.deadline);
    const tick = async () => {
      const last = now() > end;
      const r = await fundingStatus(active.depositAddress, f, active.depositMemo);
      if (!live) return;
      if (r.ok) {
        setStatus(r.data);
        setStatusError(null);
        if (isTerminal(r.data.status)) return;
      } else setStatusError(r.message);
      if (last) setStopped(true);
      else timer = setTimeout(tick, pollMs);
    };
    setStopped(false);
    tick();
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active]);

  /** A shown price belongs to the exact inputs it was for: any change drops it. */
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPrice(null);
    };

  const request = (dry: boolean) => ({ origin, amountUsdc: amount, recipient, refundTo, dry });

  const getPrice = async () => {
    setBusy("price");
    setError(null);
    setPrice(null);
    const r = await quoteFunding(request(true), f, now);
    setBusy(null);
    if (r.ok) setPrice(r.data);
    else setError(r.message);
  };

  const getDeposit = async () => {
    setBusy("deposit");
    setError(null);
    const r = await quoteFunding(request(false), f, now);
    setBusy(null);
    if (!r.ok) return setError(r.message);
    const q = r.data.quote;
    const a: ActiveDeposit = {
      depositAddress: q.depositAddress as string,
      ...(q.depositMemo ? { depositMemo: q.depositMemo } : {}),
      origin,
      amountIn: q.amountIn,
      amountOutFormatted: q.amountOutFormatted,
      deadline: q.deadline as string,
      recipient: recipient.trim(),
      refundTo: refundTo.trim(),
    };
    saveActive(store.current, a);
    setPrice(null);
    setStatus(null);
    setActive(a);
  };

  const startOver = () => {
    clearActive(store.current);
    setAck(false);
    setActive(null);
    setStatus(null);
    setStatusError(null);
    setStopped(false);
    setCopied(null);
    setTxHash("");
    setTxNote(null);
  };

  const copyAddress = async (addr: string) => {
    try {
      await copy(addr);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const sendTx = async (addr: string) => {
    const r = await submitDeposit(txHash, addr, f);
    setTxNote(
      r.ok
        ? { ok: true, text: "1Click has your tx hash. It may pick the deposit up sooner." }
        : { ok: false, text: r.message },
    );
  };

  return (
    <div className="stack">
      <div className="mainnet-warning" role="note">
        <strong>{FUND_MAINNET_WARNING}</strong>
        <span>
          This page never holds keys and never sends funds. It asks NEAR Intents 1Click for a one-time deposit
          address; you send the USDC yourself, from your own wallet.
        </span>
      </div>

      {active ? (
        <Deposit
          active={active}
          status={status}
          statusError={statusError}
          stopped={stopped}
          copied={copied}
          onCopy={copyAddress}
          txHash={txHash}
          setTxHash={setTxHash}
          txNote={txNote}
          onSendTx={sendTx}
          onStartOver={startOver}
          now={now}
        />
      ) : (
        <Window title="~/fund" status="idle">
          <div className="stack">
            <div className="fund-fields">
              <label>
                <span>Origin chain</span>
                <select value={origin} onChange={(e) => edit(setOrigin)(e.target.value as Origin)}>
                  <option value="base">USDC on Base</option>
                  <option value="arbitrum">USDC on Arbitrum</option>
                </select>
              </label>
              <label>
                <span>Amount of USDC to send</span>
                <input inputMode="decimal" value={amount} onChange={(e) => edit(setAmount)(e.target.value)} />
              </label>
              <label>
                <span>NEAR mainnet account that receives the USDC</span>
                <input
                  value={recipient}
                  placeholder="your-treasury.near"
                  spellCheck={false}
                  onChange={(e) => edit(setRecipient)(e.target.value)}
                />
              </label>
              <label>
                <span>{`Refund address on ${chain}`}</span>
                <input
                  value={refundTo}
                  placeholder="0x…"
                  spellCheck={false}
                  onChange={(e) => edit(setRefundTo)(e.target.value)}
                />
              </label>
            </div>
            <p className="muted small">
              From 1 to 100 USDC. If a deposit made before the deadline is not swapped, 1Click refunds it to
              the refund address, so use an address you control on {chain}. Anything sent after the deadline
              may be lost.
            </p>
            <div className="row">
              <Button variant="secondary" onClick={getPrice} disabled={busy !== null}>
                Get a price
              </Button>
              {busy === "price" && <span className="muted small">Asking 1Click for a price…</span>}
            </div>
            {price && <Price quote={price} chain={chain} />}
            <label className="row small">
              <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                I understand this uses real money on mainnet, and that I send the USDC myself from my own
                wallet.
              </span>
            </label>
            <div className="row">
              <Button onClick={getDeposit} disabled={!ack || busy !== null}>
                Get a deposit address
              </Button>
              {busy === "deposit" && (
                <span className="muted small">Asking 1Click for a deposit address…</span>
              )}
            </div>
            {error && <p className="bad">{error}</p>}
          </div>
        </Window>
      )}
    </div>
  );
}

function Price({ quote: q, chain }: { quote: QuoteResponse; chain: string }) {
  const cost = BigInt(q.quote.amountIn) - BigInt(q.quote.amountOut);
  return (
    <div role="group" aria-label="Price" className="stack" style={{ gap: 8 }}>
      <Eyebrow>Price · nothing reserved yet</Eyebrow>
      <dl className="facts">
        <dt>You send</dt>
        <dd>{`${usdcExact(q.quote.amountIn)} USDC on ${chain}`}</dd>
        <dt>You receive about</dt>
        <dd>{`${q.quote.amountOutFormatted} USDC on NEAR`}</dd>
        <dt>Fees and price difference</dt>
        <dd>{`${fromUsdcUnits(cost)} USDC`}</dd>
        <dt>Least that arrives</dt>
        <dd>{`${fromUsdcUnits(q.quote.minAmountOut)} USDC (1% slippage limit; below that it is refunded)`}</dd>
        <dt>Time</dt>
        <dd>{`about ${q.quote.timeEstimate} s after your deposit confirms`}</dd>
      </dl>
      <p className="muted small">This is a price only. No deposit address was made.</p>
    </div>
  );
}

function Deposit({
  active: a,
  status,
  statusError,
  stopped,
  copied,
  onCopy,
  txHash,
  setTxHash,
  txNote,
  onSendTx,
  onStartOver,
  now,
}: {
  now: () => number;
  active: ActiveDeposit;
  status: StatusResponse | null;
  statusError: string | null;
  stopped: boolean;
  copied: boolean | null;
  onCopy: (addr: string) => void;
  txHash: string;
  setTxHash: (s: string) => void;
  txNote: { ok: boolean; text: string } | null;
  onSendTx: (addr: string) => void;
  onStartOver: () => void;
}) {
  const chain = FUND_ORIGINS[a.origin].chain;
  const s = status?.status ?? "PENDING_DEPOSIT";
  const final = isTerminal(s);
  const d = status?.swapDetails;
  const originTxs = txHashes(d?.originChainTxHashes);
  const nearTxs = [...new Set([...txHashes(d?.nearTxHashes), ...txHashes(d?.destinationChainTxHashes)])];
  const win = s === "SUCCESS" ? "done" : s === "REFUNDED" || s === "FAILED" ? "offline" : "live";

  // Re-render when the deadline passes, even if no status answer arrives to trigger it.
  const [, setTick] = useState(0);
  useEffect(() => {
    const ms = Date.parse(a.deadline) - now();
    if (ms <= 0) return;
    const t = setTimeout(() => setTick((x) => x + 1), ms + 50);
    return () => clearTimeout(t);
  }, [a.deadline]);
  /** After the deadline the address is inactive and funds sent to it may be lost: never invite a send. */
  const expired = now() > Date.parse(a.deadline);
  const nothingSeen = !status || s === "PENDING_DEPOSIT";
  return (
    <Window title="~/fund/deposit" status={win}>
      <div className="stack">
        <div role="group" aria-label="Deposit" className="stack" style={{ gap: 10 }}>
          {expired && nothingSeen ? (
            <p className="bad" role="alert">
              <strong>{DEADLINE_PASSED}</strong>
            </p>
          ) : (
            <>
              <Eyebrow>{`Deposit address · USDC on ${chain}`}</Eyebrow>
              <div className="row">
                <code className="fund-address">{a.depositAddress}</code>
                {!expired && (
                  <Button variant="secondary" onClick={() => onCopy(a.depositAddress)}>
                    Copy address
                  </Button>
                )}
                {!expired && copied !== null && (
                  <span className="muted small">
                    {copied ? "Copied." : "Select the address and copy it."}
                  </span>
                )}
              </div>
              {expired ? (
                <p className="muted">
                  The deadline has passed. Your deposit was seen and is followed below; do not send anything
                  more to this address.
                </p>
              ) : (
                <p className="fund-amount">{`Send exactly ${usdcExact(a.amountIn)} USDC on ${chain}`}</p>
              )}
            </>
          )}
          <dl className="facts">
            <dt>Token</dt>
            <dd>{`USDC on ${chain}`}</dd>
            {a.depositMemo && (
              <>
                <dt>Memo</dt>
                <dd>{a.depositMemo}</dd>
              </>
            )}
            <dt>Deadline</dt>
            <dd>{utc(a.deadline)}</dd>
            <dt>Arrives in</dt>
            <dd>{`${a.recipient} on NEAR mainnet, about ${a.amountOutFormatted} USDC`}</dd>
            <dt>Refunds</dt>
            <dd>{`Refunds go to ${a.refundTo} on ${chain}`}</dd>
          </dl>
          {!expired && (
            <p className="bad">
              <strong>Warning: </strong>
              {`Send only USDC on ${chain}, exactly this amount, before the deadline. Another token, another chain, a different amount, or anything sent after the deadline may be lost.`}
            </p>
          )}
        </div>

        <ol className="fund-steps" aria-label="Deposit progress">
          {fundingSteps(s).map((step) => (
            <li key={step.label} data-state={step.state}>
              {`${STEP_MARK[step.state].mark} ${step.label} — ${STEP_MARK[step.state].word}`}
            </li>
          ))}
        </ol>
        {!(expired && nothingSeen) && <p role="status">{describeStatus(s)}</p>}
        {s === "REFUNDED" && d?.refundedAmountFormatted && (
          <p>{`Refunded ${d.refundedAmountFormatted} USDC to your refund address on ${chain}.`}</p>
        )}
        {d?.refundReason && <p className="muted small">{`Reason given by 1Click: ${d.refundReason}`}</p>}
        {s === "SUCCESS" && d?.amountOutFormatted && (
          <p>{`${d.amountOutFormatted} USDC delivered to ${a.recipient}.`}</p>
        )}
        {statusError && <p className="bad">{`Could not check the status: ${statusError}`}</p>}
        {stopped && !final && (
          <p className="muted">
            Stopped checking: the deadline passed more than 10 minutes ago. Do not send to this address. If
            you sent USDC before the deadline and it was not swapped, it should be refunded to your refund
            address; anything sent after the deadline may be lost.
          </p>
        )}

        {(originTxs.length > 0 || nearTxs.length > 0) && (
          <dl className="facts">
            {originTxs.map((h) => (
              <Tx key={h} label={`Deposit on ${chain}`} href={originTxUrl(a.origin, h)} hash={h} />
            ))}
            {nearTxs.map((h) => (
              <Tx key={h} label="NEAR transaction" href={nearTxUrl(h)} hash={h} />
            ))}
          </dl>
        )}

        {!final && (
          <div className="stack" style={{ gap: 6 }}>
            <label className="fund-fields">
              <span>I sent it — here is my tx hash</span>
              <input
                value={txHash}
                placeholder="0x…"
                spellCheck={false}
                onChange={(e) => setTxHash(e.target.value)}
              />
            </label>
            <div className="row">
              <Button
                variant="secondary"
                onClick={() => onSendTx(a.depositAddress)}
                disabled={!txHash.trim()}
              >
                Send tx hash
              </Button>
              <span className="muted small">Optional. It helps 1Click pick the deposit up sooner.</span>
            </div>
            {txNote && <p className={txNote.ok ? "ok" : "bad"}>{txNote.text}</p>}
          </div>
        )}

        <div className="row">
          <Button variant="secondary" onClick={onStartOver}>
            Start over
          </Button>
          <span className="muted small">
            {final
              ? "Clears this deposit from the page."
              : "Clears this deposit from the page. It does not cancel a deposit you already sent."}
          </span>
        </div>
      </div>
    </Window>
  );
}

function Tx({ label, href, hash }: { label: string; href: string; hash: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        <a href={href} target="_blank" rel="noreferrer">
          {short(hash)}
        </a>
      </dd>
    </>
  );
}
