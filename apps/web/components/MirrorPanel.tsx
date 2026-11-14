"use client";
import {
  type MirrorEntry,
  type MirrorTx,
  type MirrorVerdict,
  sepoliaRpc,
  sepoliaTxUrl,
  TESTNET_MPC_ROOT,
  verifyMirrorTx,
} from "@elivo/shared/evm-mirror";
import { useEffect, useRef, useState } from "react";
import { viewCall } from "../lib/rpc.ts";
import { Chip, Eyebrow, Sticker } from "./ui.tsx";

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;

export interface MirrorPanelProps {
  /** The receipt registry from this app's config (never from the file). */
  registry: string;
  issuer: string;
  receiptId: string;
  /** Injectable for tests: NEAR view calls (the anchored hash comes from get_receipt). */
  view?: View;
  /** Injectable for tests: the mirrors list (default: the static /receipts/mirrors.json). */
  loadMirrors?: () => Promise<MirrorEntry[]>;
  /** Injectable for tests: eth_getTransactionByHash on Sepolia (default: the public RPCs, browser-direct). */
  getTx?: (hash: string) => Promise<MirrorTx | null>;
}

const defaultLoad = async (): Promise<MirrorEntry[]> => {
  const res = await fetch("/receipts/mirrors.json", { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as MirrorEntry[];
};
const defaultGetTx = (hash: string) => sepoliaRpc<MirrorTx | null>("eth_getTransactionByHash", [hash]);

type State =
  | { kind: "loading" }
  | { kind: "none" }
  | { kind: "missing"; entry: MirrorEntry }
  | { kind: "error"; message: string }
  | { kind: "checked"; entry: MirrorEntry; tx: MirrorTx; verdict: MirrorVerdict };

/**
 * "Mirrored on Ethereum": for a receipt the issuer also mirrored on Ethereum Sepolia with NEAR Chain
 * Signatures, checks in this browser that the Sepolia transaction was sent by the address NEAR's MPC
 * network derives for the issuer and carries the hash anchored on NEAR.
 */
export function MirrorPanel({
  registry,
  issuer,
  receiptId,
  view = viewCall,
  loadMirrors = defaultLoad,
  getTx = defaultGetTx,
}: MirrorPanelProps) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let entry: MirrorEntry | undefined;
      try {
        entry = (await loadMirrors()).find((m) => m.issuer === issuer && m.receipt_id === receiptId);
      } catch {
        entry = undefined; // no list to read: nothing is mirrored
      }
      if (!entry) return setState({ kind: "none" });
      try {
        const anchor = await view<{ receipt_hash: string } | null>(registry, "get_receipt", {
          issuer,
          receipt_id: receiptId,
        });
        if (!anchor) return setState({ kind: "error", message: `${issuer} has no anchor for ${receiptId}` });
        const tx = await getTx(entry.tx_hash);
        if (!tx) return setState({ kind: "missing", entry });
        const verdict = verifyMirrorTx(tx, {
          issuer,
          receipt_id: receiptId,
          receipt_hash: anchor.receipt_hash,
          rootKey: TESTNET_MPC_ROOT,
        });
        setState({ kind: "checked", entry, tx, verdict });
      } catch (e) {
        setState({ kind: "error", message: (e as Error).message });
      }
    })();
  }, []);

  if (state.kind === "loading") return null;
  if (state.kind === "none") return <p className="muted small">Not mirrored to another chain</p>;

  const link = (hash: string) => (
    <p className="small" style={{ marginTop: 10, wordBreak: "break-word" }}>
      <a href={sepoliaTxUrl(hash)} target="_blank" rel="noreferrer">
        View the transaction on Sepolia Etherscan
      </a>
    </p>
  );

  return (
    <Sticker tone="paper">
      <Eyebrow>Mirrored on Ethereum</Eyebrow>
      {state.kind === "error" && (
        <p className="bad">{`Could not check the Ethereum mirror: ${state.message}`}</p>
      )}
      {state.kind === "missing" && (
        <>
          <p className="bad">{`✗ Transaction ${state.entry.tx_hash} was not found on Ethereum Sepolia`}</p>
          {link(state.entry.tx_hash)}
        </>
      )}
      {state.kind === "checked" && <Checked {...state} issuer={issuer} />}
      {state.kind === "checked" && link(state.entry.tx_hash)}
      <p className="muted small" style={{ marginTop: 8 }}>
        The issuer's NEAR account signed this Ethereum transaction through NEAR's MPC network (Chain
        Signatures). The hash is compared with the one anchored on NEAR, and the address is worked out in this
        browser from the MPC network's public key.
      </p>
    </Sticker>
  );
}

function Checked({ tx, verdict, issuer }: { tx: MirrorTx; verdict: MirrorVerdict; issuer: string }) {
  const { checks, expectedFrom } = verdict;
  const derived = `the Ethereum address NEAR's MPC network derives for ${issuer}`;
  const lines = [
    {
      ok: checks.from,
      text: checks.from
        ? `Sent from ${expectedFrom} — ${derived}`
        : `Sent from ${tx.from.toLowerCase()}, not ${expectedFrom} — ${derived}`,
    },
    {
      ok: checks.payload,
      text: checks.payload
        ? "Carries the same receipt hash"
        : `Does not carry the same receipt hash: ${verdict.problems.find((p) => p.startsWith("Carries") || p.startsWith("The transaction data")) ?? ""}`,
    },
    {
      ok: checks.selfSend && checks.chain,
      text:
        checks.selfSend && checks.chain
          ? "A 0-value transaction to itself on Ethereum Sepolia"
          : `Not a transaction to itself on Ethereum Sepolia: ${verdict.problems.filter((p) => p.startsWith("Sent to") || p.startsWith("On chain") || p.startsWith("The transaction names")).join("; ")}`,
    },
  ];
  return (
    <>
      <div className="row" style={{ margin: "8px 0" }}>
        {verdict.ok ? <Chip tone="mint">Checks out</Chip> : <Chip tone="rose">Does not check out</Chip>}
      </div>
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0, gap: 6 }}>
        {lines.map((l) => (
          <li key={l.text} className={l.ok ? "" : "bad"} style={{ wordBreak: "break-word" }}>
            {`${l.ok ? "✓" : "✗"} ${l.text}`}
          </li>
        ))}
      </ul>
    </>
  );
}
