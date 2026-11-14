"use client";
import { useEffect, useRef, useState } from "react";
import {
  type Attestation,
  attestErrorWords,
  attestTx,
  daoRoles,
  readPendingAttest,
  writePendingAttest,
} from "../lib/attest.ts";
import { viewCall } from "../lib/rpc.ts";
import type { WalletPort } from "../lib/signer.ts";
import { nsToUtc } from "../lib/verify.ts";
import { Button, Chip, Eyebrow, Sticker } from "./ui.tsx";

type View = <T>(contractId: string, method: string, args?: object) => Promise<T>;
type Wallets = ReadonlyArray<{ id: string; name: string }>;

const session = (): Storage | null => {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
};

const wait = (ms: number) => new Promise((res) => setTimeout(res, ms));

export interface AttestationsProps {
  /** The receipt registry from this app's config (never from the file). */
  registry: string;
  /** The DAO from this app's config: an attester in one of its Group roles gets a "DAO <role>" chip. */
  dao: string | null;
  issuer: string;
  receiptId: string;
  /** The hash that just verified against the anchor. */
  hash: string;
  /** Injectable for tests. */
  view?: View;
  /** Injectable for tests; by default the Wallet Selector port from lib/wallet.ts. */
  wallet?: { port: WalletPort; wallets: Wallets };
  /** Delay between reads while the chain catches up after an attest. */
  retryMs?: number;
  /** The wallets are testnet wallets: elsewhere the list shows, but there is no attest button. */
  network?: "sandbox" | "testnet";
}

/** Who has vouched for a verified receipt on the registry, and a button to vouch with your own account. */
export function Attestations({
  registry,
  dao,
  issuer,
  receiptId,
  hash,
  view = viewCall,
  wallet,
  retryMs = 2_000,
  network = "testnet",
}: AttestationsProps) {
  const [atts, setAtts] = useState<Attestation[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  /** The DAO policy, or null when there is none or it couldn't be read (then attesters get no chips). */
  const [policy, setPolicy] = useState<unknown>(null);
  const [port, setPort] = useState<WalletPort | null>(wallet?.port ?? null);
  const [wallets, setWallets] = useState<Wallets>(wallet?.wallets ?? []);
  const [account, setAccount] = useState<string | null>(wallet?.port.accountId() ?? null);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  /**
   * Reads the list; with `until`, re-reads briefly until that account shows up (the chain may lag).
   * False when `until` never showed up.
   */
  const refresh = async (until: string | null, attempts = 6): Promise<boolean> => {
    for (let i = 0; i < attempts; i++) {
      try {
        const list = await view<Attestation[]>(registry, "get_attestations", {
          issuer,
          receipt_id: receiptId,
        });
        setAtts(list);
        setReadError(null);
        if (!until || list.some((a) => a.attester === until)) return true;
      } catch (e) {
        setReadError((e as Error).message);
        if (!until) return true;
      }
      if (i < attempts - 1) await wait(retryMs);
    }
    return false;
  };
  const notYet = "Sent. Your attestation doesn't show on-chain yet: verify the receipt again in a minute.";

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if (dao) view<unknown>(dao, "get_policy").then(setPolicy, () => setPolicy(null));
    if (!wallet && network === "testnet")
      (async () => {
        try {
          const w = await import("../lib/wallet.ts");
          const p = await w.walletPort();
          setWallets(w.WALLETS);
          setPort(p);
          setAccount(p.accountId());
        } catch (e) {
          setError(`Wallet: ${(e as Error).message}`);
        }
      })();
    (async () => {
      // An attest sent from this tab before a wallet reloaded the page: wait for it to show on-chain.
      const left = readPendingAttest(session());
      if (left && left.issuer === issuer && left.receipt_id === receiptId) {
        writePendingAttest(session(), null);
        if (new URLSearchParams(window.location.search).has("errorCode")) {
          setError("The wallet transaction was cancelled; nothing was attested.");
          await refresh(null);
        } else if (!(await refresh(left.account))) setError(notYet);
      } else await refresh(null);
    })();
  }, []);

  const attest = async (p: WalletPort) => {
    const acct = p.accountId();
    if (!acct) return;
    setError(null);
    setChoosing(false);
    setBusy("Approve the transaction in your wallet…");
    writePendingAttest(session(), { issuer, receipt_id: receiptId, account: acct });
    try {
      await p.send(attestTx({ registry, issuer, receiptId, hash }));
      setBusy("Waiting for the chain to record your attestation…");
      if (!(await refresh(acct))) setError(notYet);
    } catch (e) {
      setError(attestErrorWords(e));
      await refresh(null);
    } finally {
      writePendingAttest(session(), null);
      setBusy(null);
    }
  };

  const connect = async (id: string, name: string) => {
    if (!port) return;
    setError(null);
    try {
      await port.signIn(id);
    } catch (e) {
      setError(`${name}: ${(e as Error).message || "could not connect"}`);
      return;
    }
    const acct = port.accountId();
    setAccount(acct);
    if (acct && !atts?.some((a) => a.attester === acct)) await attest(port);
    else setChoosing(false);
  };

  const mine = !!account && !!atts?.some((a) => a.attester === account);
  return (
    <Sticker tone="paper">
      <Eyebrow>Attestations</Eyebrow>
      {atts === null ? (
        readError ? (
          <p className="bad">{`Could not read the attestations: ${readError}`}</p>
        ) : (
          <p className="muted">Reading attestations…</p>
        )
      ) : atts.length === 0 ? (
        <p>No one has attested this receipt yet.</p>
      ) : (
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: "8px 0", gap: 6 }}>
          {atts.map((a) => (
            <li key={a.attester} className="row" style={{ wordBreak: "break-word", gap: 8 }}>
              <span>{`${a.attester} · ${nsToUtc(a.attested_at_ns)}`}</span>
              {daoRoles(policy, a.attester).map((role) => (
                <Chip key={role} tone="lavender">{`DAO ${role}`}</Chip>
              ))}
            </li>
          ))}
        </ul>
      )}

      {mine ? (
        <p>{`You attested this receipt as ${account}.`}</p>
      ) : network !== "testnet" ? (
        <p className="muted small">Attesting from a wallet needs the testnet deployment.</p>
      ) : (
        <div className="stack" style={{ gap: 8, marginTop: 10 }}>
          <p className="muted small">
            Your NEAR account is recorded as having checked this receipt. You're vouching that you ran the
            checks, not that the payments happened.
          </p>
          <div>
            <Button
              variant="dark"
              disabled={!port || !!busy || atts === null}
              onClick={() => (port && account ? attest(port) : setChoosing(true))}
            >
              Attest that you checked this receipt
            </Button>
          </div>
          {choosing && !account && (
            <div className="row">
              {wallets.map((w) => (
                <Button
                  key={w.id}
                  variant="secondary"
                  disabled={!!busy}
                  onClick={() => connect(w.id, w.name)}
                >
                  {`Connect ${w.name}`}
                </Button>
              ))}
            </div>
          )}
          <p className="muted small">{`Sent to ${registry} with 0.01 testnet NEAR for storage; the registry refunds what it doesn't use.`}</p>
        </div>
      )}
      {busy && <p className="muted">{busy}</p>}
      {error && <p className="bad">{error}</p>}
    </Sticker>
  );
}
