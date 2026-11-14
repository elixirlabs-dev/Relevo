"use client";
import { useEffect, useState } from "react";
import { PayeeView } from "../../components/PayeeView.tsx";
import { fetchConfig, type WebConfig } from "../../lib/config.ts";

/** Reached from a payee link (`/payee#p=…`), not from the nav. The headings are in PayeeView (EN/ES). */
export default function PayeePage() {
  const [cfg, setCfg] = useState<WebConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchConfig().then(setCfg, (e) => setError((e as Error).message));
  }, []);
  if (cfg) return <PayeeView app={cfg} />;
  return (
    <div className="stack">
      {error ? (
        <p className="bad">Could not load / No se pudo cargar: {error}</p>
      ) : (
        <p className="muted">Loading… / Cargando…</p>
      )}
    </div>
  );
}
