"use client";
import { LABEL } from "@elivo/shared/label";
import { formatUsdc } from "@elivo/shared/money";
import { directReceiptToCsv, receiptToCsv } from "@elivo/shared/receipt-csv";
import { useEffect, useRef, useState } from "react";
import { decodeShare } from "../lib/share.ts";
import { type CheckId, type VerifyOutcome, verifyAgainstChain } from "../lib/verify.ts";
import { Attestations, type AttestationsProps } from "./Attestations.tsx";
import { CheckReportSheet } from "./CheckReport.tsx";
import { DeliveryReport } from "./DeliveryReport.tsx";
import { DirectReport } from "./DirectReport.tsx";
import { MirrorPanel, type MirrorPanelProps } from "./MirrorPanel.tsx";
import { ShareLink } from "./ShareLink.tsx";
import { Button, Chip, Eyebrow, Sticker, Ticket, Window } from "./ui.tsx";

const CHECK_NAME: Record<CheckId, string> = {
  format: "File",
  escrow: "Escrow",
  registry: "Registry",
  signature: "Signature",
  anchor: "Anchored on-chain",
  totals: "Totals",
  checked_before: "Checked before payment",
};

/** Hands the browser a file to save (a Blob link, clicked once). */
function saveFile(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export interface VerifyViewProps {
  /** Escrow, registry and network from this app's config: what a receipt must belong to. The DAO labels attesters. */
  app: { escrow: string; network: "sandbox" | "testnet"; registry?: string | null; dao?: string | null };
  /** Injectable for tests. */
  verify?: (input: string) => Promise<VerifyOutcome>;
  save?: (name: string, text: string) => void;
  print?: () => void;
  /** A `#r=` share fragment to check on load (default: this page's own URL fragment). */
  fragment?: string;
  copy?: (s: string) => Promise<void>;
  /** Injectable for tests: the attestations panel's chain reads, wallet and retry delay. */
  attest?: Pick<AttestationsProps, "view" | "wallet" | "retryMs">;
  /** Injectable for tests: the Ethereum mirror panel's reads. */
  mirror?: Pick<MirrorPanelProps, "view" | "loadMirrors" | "getTx">;
}

export function VerifyView({
  app,
  verify,
  save = saveFile,
  print,
  fragment,
  copy,
  attest,
  mirror,
}: VerifyViewProps) {
  const [text, setText] = useState("");
  const [outcome, setOutcome] = useState<VerifyOutcome | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const check = verify ?? ((input: string) => verifyAgainstChain(input, app));
  /** Bumped by every new check and every edit: a result only shows if its run is still the latest. */
  const runId = useRef(0);

  /** A verdict belongs to the exact text it checked; any change drops it (and any check in flight). */
  const edit = (input: string) => {
    runId.current++;
    setText(input);
    setOutcome(null);
    setError(null);
    setBusy(false);
  };

  const run = async (input: string) => {
    edit(input);
    const id = runId.current;
    setBusy(true);
    try {
      const o = await check(input);
      if (id === runId.current) setOutcome(o);
    } catch (e) {
      if (id === runId.current) setError((e as Error).message);
    } finally {
      if (id === runId.current) setBusy(false);
    }
  };

  const sample = async (path: string) => {
    try {
      const r = await fetch(path);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await run(await r.text());
    } catch (e) {
      setError(`Could not load the sample receipt: ${(e as Error).message}`);
    }
  };

  // Opened from a share link: check the receipt it carries straight away.
  const shared = useRef(false);
  useEffect(() => {
    if (shared.current) return;
    shared.current = true;
    const f = fragment ?? window.location.hash;
    if (!f.startsWith("#r=")) return;
    decodeShare(f).then((t) =>
      t ? run(t) : setError("This share link is broken or incomplete: ask for the link again."),
    );
  }, []);

  const r = outcome?.receipt;
  const d = outcome?.direct ?? outcome?.directV2;
  const c = outcome?.check;
  const status = !outcome ? "idle" : outcome.ok ? "done" : "offline";
  /** A registry-anchored document that verified can be attested (escrow batch receipts are not in the registry). */
  const anchored = d
    ? { issuer: d.issuer, id: d.receipt_id }
    : c
      ? { issuer: c.issuer, id: c.report_id }
      : null;
  return (
    <div className="stack">
      <Window title="~/verify" status={status}>
        <div className="row" style={{ marginBottom: 14 }}>
          {app.network === "testnet" && (
            <Button onClick={() => sample("/receipts/testnet-batch-5.json")} disabled={busy}>
              Use the testnet reference receipt (batch 5)
            </Button>
          )}
          {app.network === "testnet" && app.registry && (
            <Button onClick={() => sample("/receipts/testnet-direct-payroll-pq.json")} disabled={busy}>
              Use a payroll receipt made outside the escrow (post-quantum signed)
            </Button>
          )}
          {app.network === "testnet" && app.registry && (
            <Button onClick={() => sample("/receipts/testnet-direct-payroll-v2.json")} disabled={busy}>
              Use the payroll receipt v2 (per-payee proofs)
            </Button>
          )}
          <label className="tag">
            Upload receipt{" "}
            <input
              type="file"
              accept=".json,application/json"
              disabled={busy}
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (f) await run(await f.text());
              }}
            />
          </label>
        </div>
        <textarea
          aria-label="Receipt JSON"
          value={text}
          onChange={(e) => edit(e.target.value)}
          placeholder="or paste the receipt JSON here"
        />
        <div style={{ marginTop: 12 }}>
          <Button variant="dark" disabled={busy || !text.trim()} onClick={() => run(text)}>
            Verify
          </Button>
        </div>
        <p className="muted small" style={{ marginTop: 12 }}>
          {`Checked against ${app.escrow}${app.registry ? ` and the receipt registry ${app.registry}` : ""} on ${app.network}: the receipt key and anchored hash come from the chain, never from the file. ${LABEL}`}
        </p>
      </Window>

      {error && <p className="bad">{error}</p>}

      {outcome && (
        <Sticker tone={outcome.ok ? "mint" : "rose"}>
          <Eyebrow>Result</Eyebrow>
          <div className="row" style={{ marginBottom: 10 }}>
            {outcome.ok ? (
              <Chip tone="mint">Verified against the chain</Chip>
            ) : (
              <Chip tone="rose">
                {c ? "Not verified" : "Not verified: the CSV export needs every check to pass"}
              </Chip>
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

      {outcome?.ok && r && outcome.hash && (
        <div className="stack">
          <div className="tickets">
            <Ticket label="Payouts" value={String(r.payouts.length)} />
            <Ticket label="Paid to firms" value={formatUsdc(BigInt(r.totals.paid_to_firms))} unit="USDC" />
            <Ticket
              label="Returned to funder"
              value={formatUsdc(BigInt(r.totals.returned_to_funder))}
              unit="USDC"
            />
            <Ticket
              label="Penalties to funder"
              value={formatUsdc(BigInt(r.totals.penalties))}
              unit="USDC"
              tone="peach"
            />
          </div>
          <div>
            <Button
              onClick={() => save(`elivo-batch-${r.batch_id}.csv`, receiptToCsv(r, outcome.hash as string))}
            >
              Download CSV
            </Button>
          </div>
          <ShareLink text={text} copy={copy} />
          <DeliveryReport receipt={r} hash={outcome.hash} print={print} />
        </div>
      )}

      {outcome?.ok && d && outcome.hash && (
        <div className="stack">
          <div className="tickets">
            <Ticket label="Payouts" value={String(d.payouts.length)} />
            <Ticket label="Paid" value={d.totals.paid} unit={d.currency} />
            <Ticket label="Not paid" value={d.totals.not_paid} unit={d.currency} tone="peach" />
          </div>
          <div>
            <Button
              onClick={() =>
                save(`elivo-${d.issuer}-${d.receipt_id}.csv`, directReceiptToCsv(d, outcome.hash as string))
              }
            >
              Download CSV
            </Button>
          </div>
          <ShareLink text={text} copy={copy} />
          <DirectReport receipt={d} hash={outcome.hash} print={print} />
        </div>
      )}

      {outcome?.ok && c && outcome.hash && (
        <div className="stack">
          <div className="tickets">
            <Ticket label="Rows" value={String(c.summary.rows)} />
            <Ticket label="Blocked" value={String(c.summary.blocked)} tone="rose" />
            <Ticket label="Warnings" value={String(c.summary.warned)} tone="peach" />
            <Ticket label="Clean" value={String(c.summary.clean)} tone="mint" />
          </div>
          <ShareLink text={text} copy={copy} />
          <CheckReportSheet report={c} hash={outcome.hash} print={print} />
        </div>
      )}

      {outcome?.ok && outcome.hash && anchored && app.registry && (
        <Attestations
          key={`${anchored.issuer}/${anchored.id}/${outcome.hash}`}
          registry={app.registry}
          dao={app.dao ?? null}
          issuer={anchored.issuer}
          receiptId={anchored.id}
          hash={outcome.hash}
          network={app.network}
          {...attest}
        />
      )}
      {outcome?.ok && outcome.hash && anchored && app.registry && app.network === "testnet" && (
        <MirrorPanel
          key={`mirror/${anchored.issuer}/${anchored.id}/${outcome.hash}`}
          registry={app.registry}
          issuer={anchored.issuer}
          receiptId={anchored.id}
          {...mirror}
        />
      )}
    </div>
  );
}
