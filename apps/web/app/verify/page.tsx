"use client";
import { useEffect, useState } from "react";
import { Eyebrow } from "../../components/ui.tsx";
import { VerifyView } from "../../components/VerifyView.tsx";
import { fetchConfig, type WebConfig } from "../../lib/config.ts";

export default function VerifyPage() {
  const [cfg, setCfg] = useState<WebConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchConfig().then(setCfg, (e) => setError((e as Error).message));
  }, []);
  return (
    <div className="stack">
      <div>
        <Eyebrow>Receipts · check without trusting the operator</Eyebrow>
        <h1 className="page-title">Verify a receipt</h1>
        <p className="lede">
          Your browser checks the signature against the receipt key on-chain, checks the anchored hash, and
          adds up the totals. It accepts batch receipts from the escrow and receipts an issuer made for
          payouts on any rail, outside the escrow, anchored in the receipt registry, and the check reports
          anchored on /check before paying. Once every check passes you can export the payouts as CSV for your
          accounting tools. The format is published in <code>docs/receipts</code>.
        </p>
      </div>
      {error && <p className="bad">Could not load: {error}</p>}
      {cfg ? <VerifyView app={cfg} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}
