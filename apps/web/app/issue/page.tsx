"use client";
import { useEffect, useState } from "react";
import { IssueView } from "../../components/IssueView.tsx";
import { Eyebrow } from "../../components/ui.tsx";
import { fetchConfig, type WebConfig } from "../../lib/config.ts";

export default function IssuePage() {
  const [cfg, setCfg] = useState<WebConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchConfig().then(setCfg, (e) => setError((e as Error).message));
  }, []);
  return (
    <div className="stack">
      <div>
        <Eyebrow>Receipts · for payouts you made on any rail</Eyebrow>
        <h1 className="page-title">Issue your own receipt</h1>
        <p className="lede">
          Paid people through your bank, payroll tool or provider? Turn the results into a signed receipt
          anchored on NEAR, so a donor, auditor or payee can check it without trusting you. Your browser signs
          it, with an optional post-quantum signature, and your testnet wallet anchors it. No escrow involved.
        </p>
      </div>
      {error && <p className="bad">Could not load: {error}</p>}
      {cfg ? <IssueView cfg={cfg} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}
