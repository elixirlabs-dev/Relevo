"use client";
import { isPayeeProof, type PayeeProof, payeeRefMatches } from "@elivo/shared/direct-receipt-v2";
import { useEffect, useRef, useState } from "react";
import {
  formatAmount,
  formatWhen,
  initialLang,
  type Lang,
  PAYEE_TEXT,
  type PayeeText,
  readLang,
  saveLang,
} from "../lib/i18n-payee.ts";
import { decodePayeeLink, type PayeeCheck, type PayeeOutcome, verifyPayeeProof } from "../lib/payee.ts";
import { Button, Chip, Eyebrow, Sticker, Window } from "./ui.tsx";

const SAMPLE_PATH = "/receipts/testnet-payee-proof-v2.json";

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;
type Confirm = "match" | "no_match" | "length" | null;

const local = (): Storage | null => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

function checkLine(c: PayeeCheck, p: PayeeProof, o: PayeeOutcome, t: PayeeText, lang: Lang): string {
  const words =
    c.id === "registry"
      ? c.ok
        ? t.registryOk
        : t.registryBad
      : c.id === "signature"
        ? (c.ok ? t.signatureOk : t.signatureBad)(p.header.issuer)
        : c.id === "anchor"
          ? c.ok
            ? t.anchorOk(o.anchoredAt ? formatWhen(o.anchoredAt, lang) : "—")
            : t.anchorBad
          : c.ok
            ? t.merkleOk(p.header.payout_count)
            : t.merkleBad;
  return `${c.ok ? "✓" : "✗"} ${words}`;
}

export interface PayeeViewProps {
  /** Registry and network from this app's config: what a payee proof must belong to. */
  app: { network: string; registry?: string | null };
  /** Injectable for tests; by default the app's RPC proxy. */
  view?: View;
  /** A `#p=` fragment to open (default: this page's own URL fragment, and any later change to it). */
  fragment?: string;
}

export function PayeeView({ app, view, fragment }: PayeeViewProps) {
  const [lang, setLang] = useState<Lang>("en");
  const [proof, setProof] = useState<PayeeProof | null>(null);
  const [isSample, setIsSample] = useState(false);
  const [outcome, setOutcome] = useState<PayeeOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clabe, setClabe] = useState("");
  const [confirm, setConfirm] = useState<Confirm>(null);
  /** Bumped by every proof opened: a verdict only shows if its run is still the latest. */
  const runId = useRef(0);
  const t = PAYEE_TEXT[lang];
  const canSample = app.network === "testnet" && !!app.registry;

  const show = async (p: PayeeProof, sample: boolean) => {
    const id = ++runId.current;
    setProof(p);
    setIsSample(sample);
    setOutcome(null);
    setError(null);
    setClabe("");
    setConfirm(null);
    setBusy(true);
    try {
      const o = await verifyPayeeProof(p, app, view);
      if (id === runId.current) setOutcome(o);
    } catch (e) {
      if (id === runId.current) setError((e as Error).message);
    } finally {
      if (id === runId.current) setBusy(false);
    }
  };

  const open = async (f: string) => {
    if (!f.startsWith("#p=")) return;
    const p = await decodePayeeLink(f);
    if (p) await show(p, false);
    else {
      runId.current++;
      setProof(null);
      setOutcome(null);
      setError("broken");
    }
  };

  const sample = async () => {
    try {
      const r = await fetch(SAMPLE_PATH);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const p: unknown = await r.json();
      if (!isPayeeProof(p)) throw new Error("not a payee proof");
      await show(p, true);
    } catch (e) {
      setError(`sample:${(e as Error).message}`);
    }
  };

  const pickLang = (l: Lang) => {
    setLang(l);
    saveLang(local, l);
  };

  const started = useRef(false);
  useEffect(() => {
    if (!started.current) {
      started.current = true;
      setLang(initialLang(readLang(local), navigator.language));
      open(fragment ?? window.location.hash);
    }
    if (fragment !== undefined) return;
    const onHash = () => open(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const check = () => {
    if (!proof) return;
    const digits = clabe.replace(/[\s-]/g, "");
    if (!/^\d{18}$/.test(digits)) setConfirm("length");
    else setConfirm(payeeRefMatches(proof, digits) ? "match" : "no_match");
  };

  const pay = proof?.payout;
  const status = !outcome ? "idle" : outcome.ok ? "done" : "offline";
  const shownChecks = outcome?.checks.filter((c) => c.id !== "registry" || !c.ok) ?? [];
  return (
    <div className="stack" lang={lang}>
      <div>
        <div className="row" role="group" aria-label={t.langLabel} style={{ marginBottom: 12 }}>
          {(["en", "es"] as const).map((l) => (
            <button
              key={l}
              type="button"
              className={`btn ${lang === l ? "btn-dark" : "btn-secondary"}`}
              aria-pressed={lang === l}
              onClick={() => pickLang(l)}
            >
              {l.toUpperCase()}
            </button>
          ))}
        </div>
        <Eyebrow>{t.eyebrow}</Eyebrow>
        <h1 className="page-title">{t.title}</h1>
        <p className="lede">{t.lede}</p>
        <p className="small">
          <strong>{t.privacy}</strong>
        </p>
      </div>

      {!app.registry && <p className="bad">{t.noRegistry}</p>}

      {!proof && (
        <Sticker tone={error === "broken" ? "rose" : "paper"}>
          <p style={{ marginTop: 0 }}>{error === "broken" ? t.broken : t.empty}</p>
          {canSample && <Button onClick={sample}>{t.sample}</Button>}
        </Sticker>
      )}

      {error?.startsWith("sample:") && <p className="bad">{t.sampleError(error.slice(7))}</p>}
      {error && error !== "broken" && !error.startsWith("sample:") && <p className="bad">{error}</p>}

      {proof && pay && (
        <Window title="~/payee" status={status}>
          <div className="stack">
            <div className="row">
              {busy && <Chip>{t.checking}</Chip>}
              {outcome && (
                <Chip tone={outcome.ok ? "mint" : "rose"}>{outcome.ok ? t.verified : t.notVerified}</Chip>
              )}
              {isSample && <Chip tone="peach">{t.sampleNote}</Chip>}
            </div>
            <div>
              <span className="eyebrow">{t.amount}</span>
              <div className="payee-amount">{`${formatAmount(pay.amount)} ${proof.header.currency}`}</div>
            </div>
            <dl className="facts">
              <dt>{t.status}</dt>
              <dd className={pay.status === "Paid" ? "ok" : "bad"}>
                {`${pay.status === "Paid" ? "✓" : "✗"} ${t.statusWord[pay.status as keyof PayeeText["statusWord"]] ?? pay.status}`}
              </dd>
              <dt>{t.paidAt}</dt>
              <dd>{pay.paid_at ? formatWhen(pay.paid_at, lang) : "—"}</dd>
              <dt>{t.reference}</dt>
              <dd>{pay.reference ?? "—"}</dd>
              <dt>{t.account}</dt>
              <dd>{t.accountEnding(pay.account_last4)}</dd>
              <dt>{t.issuer}</dt>
              <dd>{proof.header.issuer}</dd>
              <dt>{t.receipt}</dt>
              <dd>
                <span>{proof.header.receipt_id}</span>
                {" · "}
                <span>{t.position(proof.proof.index + 1, proof.header.payout_count)}</span>
              </dd>
            </dl>

            {outcome && (
              <div>
                <h2 className="small" style={{ margin: "0 0 8px" }}>
                  {t.checksTitle}
                </h2>
                <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
                  {shownChecks.map((c) => (
                    <li key={c.id} className={c.ok ? "" : "bad"} style={{ wordBreak: "break-word" }}>
                      {checkLine(c, proof, outcome, t, lang)}
                    </li>
                  ))}
                </ul>
                <details style={{ marginTop: 8 }}>
                  <summary className="small muted">{t.details}</summary>
                  <ul className="small muted" lang="en" style={{ wordBreak: "break-word" }}>
                    {outcome.checks.map((c) => (
                      <li key={c.id}>{`${c.ok ? "✓" : "✗"} ${c.detail}`}</li>
                    ))}
                  </ul>
                </details>
              </div>
            )}
            {app.registry && <p className="muted small">{t.footnote(app.registry, app.network)}</p>}
          </div>
        </Window>
      )}

      {proof && pay && (
        <Sticker tone="lavender">
          <h2 className="small" style={{ marginTop: 0 }}>
            {t.confirmTitle}
          </h2>
          <p className="small">{t.confirmHelp}</p>
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault();
              check();
            }}
          >
            <label className="tag">
              {t.clabeLabel}{" "}
              <input
                value={clabe}
                inputMode="numeric"
                autoComplete="off"
                spellCheck={false}
                maxLength={24}
                onChange={(e) => {
                  setClabe(e.target.value);
                  setConfirm(null);
                }}
              />
            </label>
            <Button variant="dark" onClick={check} disabled={!clabe.trim()}>
              {t.confirmButton}
            </Button>
          </form>
          {confirm === "match" && (
            <p className="ok" role="status">
              {t.match}
            </p>
          )}
          {confirm === "no_match" && (
            <p className="bad" role="status">
              {t.noMatch(pay.account_last4)}
            </p>
          )}
          {confirm === "length" && (
            <p className="bad" role="status">
              {`✗ ${t.clabeLength}`}
            </p>
          )}
        </Sticker>
      )}
    </div>
  );
}
