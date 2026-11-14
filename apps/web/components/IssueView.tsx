"use client";
import type { DirectReceipt } from "@elivo/shared/direct-receipt";
import { LABEL } from "@elivo/shared/label";
import { useEffect, useRef, useState } from "react";
import type { WebConfig } from "../lib/config.ts";
import { PENDING_KEY, prepareIssue, readPending, SAMPLE_RESULTS_CSV } from "../lib/issue.ts";
import { viewCall } from "../lib/rpc.ts";
import type { WalletPort } from "../lib/signer.ts";
import { type CheckId, type VerifyOutcome, verifyAgainstChain } from "../lib/verify.ts";
import { DirectReport } from "./DirectReport.tsx";
import { ShareLink } from "./ShareLink.tsx";
import { Button, Chip, Eyebrow, Sticker, Window } from "./ui.tsx";

const RAILS = [
  { rail: "SPEI", currency: "MXN", label: "SPEI (Mexico, MXN)" },
  { rail: "SEPA", currency: "EUR", label: "SEPA (euro area, EUR)" },
  { rail: "ACH", currency: "USD", label: "ACH (US, USD)" },
  { rail: "PIX", currency: "BRL", label: "Pix (Brazil, BRL)" },
] as const;

const CHECK_NAME: Record<CheckId, string> = {
  format: "File",
  escrow: "Escrow",
  registry: "Registry",
  signature: "Signature",
  anchor: "Anchored on-chain",
  totals: "Totals",
};

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;
type Wallets = ReadonlyArray<{ id: string; name: string }>;

const session = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};
const local = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

function saveJson(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

const defaultId = () =>
  `receipt-${new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-")}`;

export interface IssueViewProps {
  cfg: Pick<WebConfig, "network" | "escrow" | "registry">;
  /** Injectable for tests; by default the Wallet Selector port from lib/wallet.ts. */
  wallet?: { port: WalletPort; wallets: Wallets };
  view?: View;
  /** Delay between anchor checks after the wallet returns (the chain may lag a block or two). */
  retryMs?: number;
  save?: (name: string, text: string) => void;
}

export function IssueView({
  cfg,
  wallet,
  view = viewCall,
  retryMs = 2_000,
  save = saveJson,
}: IssueViewProps) {
  const [port, setPort] = useState<WalletPort | null>(wallet?.port ?? null);
  const [wallets, setWallets] = useState<Wallets>(wallet?.wallets ?? []);
  const [account, setAccount] = useState<string | null>(wallet?.port.accountId() ?? null);
  const [csv, setCsv] = useState(SAMPLE_RESULTS_CSV);
  const [railIdx, setRailIdx] = useState(0);
  const [receiptId, setReceiptId] = useState(defaultId);
  const [postQuantum, setPostQuantum] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [pending, setPending] = useState<DirectReceipt | null>(null);
  const started = useRef(false);

  const check = async (r: DirectReceipt, attempts = 5) => {
    setBusy("Checking your receipt against the registry…");
    let o: VerifyOutcome | null = null;
    for (let i = 0; i < attempts; i++) {
      o = await verifyAgainstChain(JSON.stringify(r), cfg, view);
      if (o.ok || !o.checks.some((c) => c.id === "anchor" && c.detail.includes("anchored no receipt"))) break;
      await new Promise((res) => setTimeout(res, retryMs));
    }
    setBusy(null);
    setOutcome(o);
    if (o?.ok) {
      try {
        session()?.removeItem(PENDING_KEY);
      } catch {}
      setPending(null);
    } else setPending(r);
  };

  // Load the wallet, then pick up a receipt left pending by a wallet that reloaded the page.
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let p = wallet?.port ?? null;
      if (!p) {
        try {
          const w = await import("../lib/wallet.ts");
          p = await w.walletPort();
          setWallets(w.WALLETS);
          setPort(p);
        } catch (e) {
          setErrors([`Wallet: ${(e as Error).message}`]);
          return;
        }
      }
      const acct = p.accountId();
      setAccount(acct);
      const left = readPending(session());
      if (!left) return;
      const cancelled = new URLSearchParams(window.location.search).has("errorCode");
      if (cancelled || left.issuer !== acct) {
        session()?.removeItem(PENDING_KEY);
        if (cancelled) setErrors(["The wallet transaction was cancelled; nothing was anchored."]);
        return;
      }
      await check(left);
    })();
  }, []);

  if (cfg.network !== "testnet" || !cfg.registry)
    return <p className="muted">Issuing receipts needs the testnet deployment with a receipt registry.</p>;
  const registry = cfg.registry;

  const connect = async (id: string, name: string) => {
    if (!port) return;
    setErrors([]);
    try {
      await port.signIn(id);
      setAccount(port.accountId());
    } catch (e) {
      setErrors([`${name}: ${(e as Error).message || "could not connect"}`]);
    }
  };

  const issue = async () => {
    if (!port || !account) return;
    setErrors([]);
    setOutcome(null);
    setBusy("Signing in your browser…");
    try {
      const currentKeys = await view<{ receipt_pk: string; mldsa65_pk: string | null } | null>(
        registry,
        "get_keys",
        { issuer: account },
      );
      const { rail, currency } = RAILS[railIdx];
      const prepared = prepareIssue(
        { csv, rail, currency, receiptId, account, registry, network: cfg.network, postQuantum, currentKeys },
        local(),
      );
      if (!prepared.ok) {
        setErrors(prepared.errors);
        setBusy(null);
        return;
      }
      try {
        session()?.setItem(PENDING_KEY, JSON.stringify(prepared.receipt));
      } catch {}
      setBusy("Approve the transaction in your wallet…");
      await port.send(prepared.tx);
      await check(prepared.receipt);
    } catch (e) {
      setBusy(null);
      setErrors([(e as Error).message || "The transaction did not go through"]);
    }
  };

  const d = outcome?.direct;
  return (
    <div className="stack">
      <Window title="~/issue" status={busy ? "live" : outcome?.ok ? "done" : "idle"}>
        <div className="stack">
          <div>
            <Eyebrow>1 · Your wallet (NEAR testnet)</Eyebrow>
            {account ? (
              <p>
                <Chip tone="mint">{`Signed in as ${account}`}</Chip>
              </p>
            ) : (
              <div className="row">
                {wallets.map((w) => (
                  <Button key={w.id} variant="secondary" onClick={() => connect(w.id, w.name)}>
                    {`Connect ${w.name}`}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div>
            <Eyebrow>2 · The payouts you made</Eyebrow>
            <p className="muted small">
              Columns: name, account, amount, status (paid, returned or failed), paid_at, reference. The
              sample is invented. Names and full account numbers stay in your browser: the receipt keeps a
              salted hash and the last 4 digits.
            </p>
            <textarea aria-label="Payout results CSV" value={csv} onChange={(e) => setCsv(e.target.value)} />
            <div className="row" style={{ marginTop: 10 }}>
              <label className="tag">
                {"Rail "}
                <select
                  aria-label="Rail"
                  value={railIdx}
                  onChange={(e) => setRailIdx(Number(e.target.value))}
                >
                  {RAILS.map((r, i) => (
                    <option key={r.rail} value={i}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tag">
                {"Receipt id "}
                <input
                  aria-label="Receipt id"
                  value={receiptId}
                  onChange={(e) => setReceiptId(e.target.value)}
                />
              </label>
              <label className="tag">
                <input
                  type="checkbox"
                  checked={postQuantum}
                  onChange={(e) => setPostQuantum(e.target.checked)}
                />
                {" Add a post-quantum signature (ML-DSA-65)"}
              </label>
            </div>
          </div>

          <div>
            <Eyebrow>3 · Sign and anchor</Eyebrow>
            <Button variant="dark" disabled={!account || !!busy} onClick={issue}>
              Sign and anchor the receipt
            </Button>
            <p className="muted small" style={{ marginTop: 8 }}>
              {`Your browser signs the receipt with keys kept in this browser. Your wallet then sends one transaction to ${registry}: it publishes your receipt keys if they are new, and anchors the receipt's hash. You attach up to 0.06 testnet NEAR for storage; the registry refunds what it doesn't use. ${LABEL}`}
            </p>
          </div>
        </div>
      </Window>

      {busy && <p className="muted">{busy}</p>}
      {errors.length > 0 && (
        <ul className="bad">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}

      {pending && !busy && !outcome?.ok && (
        <p className="row">
          <span className="muted">Your receipt is signed but not anchored yet.</span>
          <Button variant="secondary" onClick={() => check(pending)}>
            Check again
          </Button>
        </p>
      )}

      {outcome && (
        <Sticker tone={outcome.ok ? "mint" : "rose"}>
          <Eyebrow>Result</Eyebrow>
          <div className="row" style={{ marginBottom: 10 }}>
            {outcome.ok ? (
              <Chip tone="mint">Anchored and verified against the chain</Chip>
            ) : (
              <Chip tone="rose">Not verified yet</Chip>
            )}
          </div>
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {outcome.checks.map((c) => (
              <li key={c.id} className={c.ok ? "" : "bad"} style={{ wordBreak: "break-word" }}>
                {`${c.ok ? "✓" : "✗"} ${CHECK_NAME[c.id]}: ${c.detail}`}
              </li>
            ))}
          </ul>
        </Sticker>
      )}

      {outcome?.ok && d && outcome.hash && (
        <div className="stack">
          <div className="row">
            <Button onClick={() => save(`${d.receipt_id}.json`, `${JSON.stringify(d, null, 2)}\n`)}>
              Download the receipt
            </Button>
            <Button variant="secondary" href="/verify">
              Verify it again on /verify
            </Button>
          </div>
          <ShareLink text={JSON.stringify(d, null, 2)} />
          <DirectReport receipt={d} hash={outcome.hash} />
        </div>
      )}
    </div>
  );
}
