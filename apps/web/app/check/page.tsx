"use client";
import { useEffect, useState } from "react";
import { CheckView } from "../../components/CheckView.tsx";
import { Eyebrow } from "../../components/ui.tsx";
import { fetchConfig, type WebConfig } from "../../lib/config.ts";

export default function CheckPage() {
  const [cfg, setCfg] = useState<WebConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchConfig().then(setCfg, (e) => setError((e as Error).message));
  }, []);
  return (
    <div className="stack">
      <div>
        <Eyebrow>Before paying · on any rail</Eyebrow>
        <h1 className="page-title">Check a batch before you pay</h1>
        <p className="lede">
          Catch the mistakes that cost money before it moves: CLABE typos, bank codes outside the list,
          duplicate accounts, unusual amounts, and a payee whose account changed since last time, the classic
          sign of payroll diversion. Your browser runs the checks. Then anchor a signed check report on NEAR,
          so you can show later that the batch was checked, and when.
        </p>
      </div>
      {error && <p className="bad">Could not load: {error}</p>}
      {cfg ? <CheckView cfg={cfg} /> : !error && <p className="muted">Loading…</p>}
    </div>
  );
}
