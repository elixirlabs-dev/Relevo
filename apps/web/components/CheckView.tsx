"use client";
import type { CheckReport } from "@elivo/shared/check-report";
import { LABEL } from "@elivo/shared/label";
import { useEffect, useRef, useState } from "react";
import {
  acceptHistory,
  type Checked,
  FINDING_WORDS,
  PENDING_CHECK_KEY,
  prepareCheckAnchor,
  readPendingCheck,
  recordAnchoredCheck,
  runCheck,
  SAMPLE_PLANNED_CSV,
  SAMPLE_PROBLEMS_CSV,
} from "../lib/check.ts";
import type { WebConfig } from "../lib/config.ts";
import { viewCall } from "../lib/rpc.ts";
import type { WalletPort } from "../lib/signer.ts";
import { type CheckId, type VerifyOutcome, verifyAgainstChain } from "../lib/verify.ts";
import { FindingChip } from "./CheckReport.tsx";
import { Button, Chip, Eyebrow, Sticker, Ticket, Window } from "./ui.tsx";

const RAILS = [
  { rail: "SPEI", label: "SPEI (Mexico)" },
  { rail: "SEPA", label: "SEPA (euro area)" },
  { rail: "ACH", label: "ACH (US)" },
  { rail: "PIX", label: "Pix (Brazil)" },
] as const;

const CHECK_NAME: Record<CheckId, string> = {
  format: "File",
  escrow: "Escrow",
  registry: "Registry",
  signature: "Signature",
  anchor: "Anchored on-chain",
  totals: "Summary",
};

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;
type Wallets = ReadonlyArray<{ id: string; name: string }>;
type Pending = { report: CheckReport; accept: Record<string, string> };

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

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export interface CheckViewProps {
  cfg: Pick<WebConfig, "network" | "escrow" | "registry" | "explorer">;
  /** Injectable for tests; by default the Wallet Selector port from lib/wallet.ts. */
  wallet?: { port: WalletPort; wallets: Wallets };
  view?: View;
  /** Delay between anchor checks after the wallet returns (the chain may lag a block or two). */
  retryMs?: number;
  save?: (name: string, text: string) => void;
}

export function CheckView({
  cfg,
  wallet,
  view = viewCall,
  retryMs = 2_000,
  save = saveJson,
}: CheckViewProps) {
  const [port, setPort] = useState<WalletPort | null>(wallet?.port ?? null);
  const [wallets, setWallets] = useState<Wallets>(wallet?.wallets ?? []);
  const [account, setAccount] = useState<string | null>(wallet?.port.accountId() ?? null);
  const [csv, setCsv] = useState(SAMPLE_PLANNED_CSV);
  const [railIdx, setRailIdx] = useState(0);
  const [postQuantum, setPostQuantum] = useState(true);
  const [errors, setErrors] = useState<string[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [checked, setChecked] = useState<Extract<Checked, { ok: true }> | null>(null);
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const started = useRef(false);
  const canAnchor = cfg.network === "testnet" && !!cfg.registry;

  const confirm = async (p: Pending, attempts = 5) => {
    setBusy("Checking your report against the registry…");
    let o: VerifyOutcome | null = null;
    for (let i = 0; i < attempts; i++) {
      o = await verifyAgainstChain(JSON.stringify(p.report), cfg, view);
      if (o.ok || !o.checks.some((c) => c.id === "anchor" && c.detail.includes("anchored no check report")))
        break;
      await new Promise((res) => setTimeout(res, retryMs));
    }
    setBusy(null);
    setOutcome(o);
    if (o?.ok && o.hash) {
      const r = p.report;
      recordAnchoredCheck(
        r.issuer,
        { report_id: r.report_id, hash: o.hash, checked_at: r.checked_at },
        local(),
      );
      acceptHistory(r.issuer, p.accept, local());
      try {
        session()?.removeItem(PENDING_CHECK_KEY);
      } catch {}
      setPending(null);
    } else setPending(p);
  };

  // Load the wallet, then pick up a report left pending by a wallet that reloaded the page.
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
      const left = readPendingCheck(session());
      if (!left) return;
      const cancelled = new URLSearchParams(window.location.search).has("errorCode");
      if (cancelled || left.report.issuer !== acct) {
        session()?.removeItem(PENDING_CHECK_KEY);
        if (cancelled) setErrors(["The wallet transaction was cancelled; nothing was anchored."]);
        return;
      }
      await confirm(left);
    })();
  }, []);

  /** A result belongs to the exact batch it checked: any edit drops it. */
  const edit = (text: string) => {
    setCsv(text);
    setChecked(null);
    setOutcome(null);
    setErrors([]);
  };

  const check = () => {
    setErrors([]);
    setOutcome(null);
    const out = runCheck({ csv, rail: RAILS[railIdx].rail, account }, local());
    if (out.ok) setChecked(out);
    else {
      setChecked(null);
      setErrors(out.errors);
    }
  };

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

  const anchor = async () => {
    if (!port || !account || !checked || !cfg.registry) return;
    const registry = cfg.registry;
    setErrors([]);
    setOutcome(null);
    setBusy("Signing in your browser…");
    try {
      const currentKeys = await view<{ receipt_pk: string; mldsa65_pk: string | null } | null>(
        registry,
        "get_keys",
        { issuer: account },
      );
      const prepared = prepareCheckAnchor(
        {
          result: checked.result,
          rows: checked.rows,
          account,
          registry,
          network: cfg.network,
          postQuantum,
          currentKeys,
          checkedAt: checked.checkedAt,
        },
        local(),
      );
      if (!prepared.ok) {
        setErrors(prepared.errors);
        setBusy(null);
        return;
      }
      const p = { report: prepared.report, accept: checked.accept };
      try {
        session()?.setItem(PENDING_CHECK_KEY, JSON.stringify(p));
      } catch {}
      setBusy("Approve the transaction in your wallet…");
      await port.send(prepared.tx);
      await confirm(p);
    } catch (e) {
      setBusy(null);
      setErrors([(e as Error).message || "The transaction did not go through"]);
    }
  };

  const res = checked?.result;
  const report = outcome?.ok ? outcome.check : null;
  return (
    <div className="stack">
      <Window title="~/check" status={busy ? "live" : report ? "done" : "idle"}>
        <div className="stack">
          <div>
            <Eyebrow>1 · The batch you plan to pay</Eyebrow>
            <p className="muted small">
              Columns: name, account, amount (a payout results CSV works too). Both samples are invented; the
              sample with problems comes with an invented record of the account one payee used last time.
              Everything is checked in your browser: names and full account numbers never leave it.
            </p>
            <div className="row" style={{ marginBottom: 10 }}>
              <Button variant="secondary" onClick={() => edit(SAMPLE_PROBLEMS_CSV)} disabled={!!busy}>
                Use a sample batch with problems
              </Button>
              <Button variant="secondary" onClick={() => edit(SAMPLE_PLANNED_CSV)} disabled={!!busy}>
                Use a clean sample batch
              </Button>
              <label className="tag">
                {"Upload CSV "}
                <input
                  type="file"
                  accept=".csv,text/csv"
                  disabled={!!busy}
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (f) edit(await f.text());
                  }}
                />
              </label>
            </div>
            <textarea aria-label="Planned payouts CSV" value={csv} onChange={(e) => edit(e.target.value)} />
            <div className="row" style={{ marginTop: 10 }}>
              <label className="tag">
                {"Rail "}
                <select
                  aria-label="Rail"
                  value={railIdx}
                  onChange={(e) => {
                    setRailIdx(Number(e.target.value));
                    setChecked(null);
                    setOutcome(null);
                  }}
                >
                  {RAILS.map((r, i) => (
                    <option key={r.rail} value={i}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <Button variant="dark" disabled={!!busy || !csv.trim()} onClick={check}>
                Check batch
              </Button>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              Name-to-account matching needs a licensed account-validation provider; not checked in this
              prototype.
            </p>
          </div>

          {res && checked && (
            <div className="stack">
              <Eyebrow>2 · What the checks found</Eyebrow>
              <div className="tickets">
                <Ticket label="Rows" value={String(res.summary.rows)} />
                <Ticket label="Blocked" value={String(res.summary.blocked)} tone="rose" />
                <Ticket label="Warnings" value={String(res.summary.warned)} tone="peach" />
                <Ticket label="Clean" value={String(res.summary.clean)} tone="mint" />
              </div>
              <p className={res.ok ? "" : "bad"}>
                {res.ok
                  ? `No blocking problems${res.summary.warned ? `, but read the ${plural(res.summary.warned, "warning", "warnings")} before paying` : ""}.`
                  : `${plural(res.summary.blocked, "row is", "rows are")} blocked: fix ${res.summary.blocked === 1 ? "it" : "them"} and check again before paying.`}
              </p>
              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Name</th>
                      <th>Bank</th>
                      <th>Last 4 digits</th>
                      <th>Amount</th>
                      <th>Findings</th>
                    </tr>
                  </thead>
                  <tbody>
                    {res.rows.map((r) => (
                      <tr key={r.row}>
                        <td>{r.row}</td>
                        <td>{r.name || "-"}</td>
                        <td>{r.bank ?? "-"}</td>
                        <td>{r.account_last4 || "-"}</td>
                        <td>{r.amount || "-"}</td>
                        <td>
                          {r.findings.length === 0 ? (
                            "none"
                          ) : (
                            <div className="stack" style={{ gap: 6 }}>
                              {r.findings.map((f) => (
                                <div key={f.code}>
                                  <FindingChip level={f.level} text={FINDING_WORDS[f.code]} />
                                  <div className="small">{f.message}</div>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {res && (
            <div>
              <Eyebrow>3 · Anchor the check on NEAR</Eyebrow>
              {!canAnchor ? (
                <p className="muted small">Anchoring needs the testnet deployment with a receipt registry.</p>
              ) : (
                <>
                  {account ? (
                    <p>
                      <Chip tone="mint">{`Signed in as ${account}`}</Chip>
                    </p>
                  ) : (
                    <div className="row" style={{ marginBottom: 10 }}>
                      {wallets.map((w) => (
                        <Button key={w.id} variant="secondary" onClick={() => connect(w.id, w.name)}>
                          {`Connect ${w.name}`}
                        </Button>
                      ))}
                    </div>
                  )}
                  <div className="row">
                    <Button variant="dark" disabled={!res.ok || !account || !!busy} onClick={anchor}>
                      Anchor this check on NEAR
                    </Button>
                    <label className="tag">
                      <input
                        type="checkbox"
                        checked={postQuantum}
                        onChange={(e) => setPostQuantum(e.target.checked)}
                      />
                      {" Add a post-quantum signature (ML-DSA-65)"}
                    </label>
                  </div>
                  <p className="muted small" style={{ marginTop: 8 }}>
                    {!res.ok
                      ? "Anchoring is off while any row is blocked."
                      : !account
                        ? "Connect a testnet wallet to anchor."
                        : `Your browser signs a check report with the receipt keys kept in this browser (the same keys /issue uses). Your wallet then sends one transaction to ${cfg.registry}: it publishes your receipt keys if they are new, and anchors the report's hash. The report keeps the findings, a salted hash and the last 4 digits of each account, never a name. You attach up to 0.06 testnet NEAR for storage; the registry refunds what it doesn't use.`}
                  </p>
                </>
              )}
            </div>
          )}
          <p className="muted small">{LABEL}</p>
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
          <span className="muted">Your check report is signed but not anchored yet.</span>
          <Button variant="secondary" onClick={() => confirm(pending)}>
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

      {report && outcome?.hash && (
        <Sticker>
          <Eyebrow>Your anchored check</Eyebrow>
          <p>
            {"Report id "}
            <code>{report.report_id}</code>
          </p>
          <p style={{ wordBreak: "break-all" }}>
            {"Hash "}
            <code>{outcome.hash}</code>
          </p>
          {cfg.explorer && (
            <p>
              <a href={`${cfg.explorer}/address/${report.issuer}`} target="_blank" rel="noreferrer">
                {`See ${report.issuer}'s transactions, this anchor included, on the explorer`}
              </a>
            </p>
          )}
          <div className="row">
            <Button
              variant="secondary"
              onClick={() => save(`${report.report_id}.json`, `${JSON.stringify(report, null, 2)}\n`)}
            >
              Download check report (JSON)
            </Button>
            <Button href="/issue">Next: issue the receipt after paying →</Button>
          </div>
        </Sticker>
      )}
    </div>
  );
}
