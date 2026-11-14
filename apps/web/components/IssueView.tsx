"use client";
import { LABEL } from "@elivo/shared/label";
import { useEffect, useRef, useState } from "react";
import { lastAnchoredCheck } from "../lib/check.ts";
import type { WebConfig } from "../lib/config.ts";
import {
  PENDING_KEY,
  type PendingIssue,
  prepareIssue,
  readPending,
  SAMPLE_RESULTS_CSV,
} from "../lib/issue.ts";
import { payeeLink } from "../lib/payee-link.ts";
import {
  findPayout,
  type IssuedReceipt,
  listIssued,
  type PayoutMatch,
  payeeProofFor,
  saveIssued,
} from "../lib/receipt-store.ts";
import { viewCall } from "../lib/rpc.ts";
import type { WalletPort } from "../lib/signer.ts";
import { type CheckId, nsToUtc, type VerifyOutcome, verifyAgainstChain } from "../lib/verify.ts";
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
  checked_before: "Checked before payment",
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

type LastCheck = { report_id: string; hash: string; checked_at: string };
/** Where a copied payee link came from, so it shows under the right table. */
type CopiedLink = { where: "links" | "find"; position: number; url: string; copied: boolean };

export interface IssueViewProps {
  cfg: Pick<WebConfig, "network" | "escrow" | "registry">;
  /** Injectable for tests; by default the Wallet Selector port from lib/wallet.ts. */
  wallet?: { port: WalletPort; wallets: Wallets };
  view?: View;
  /** Delay between anchor checks after the wallet returns (the chain may lag a block or two). */
  retryMs?: number;
  save?: (name: string, text: string) => void;
  copy?: (s: string) => Promise<void>;
  /** The site's origin for payee links (default: this page's). */
  origin?: string;
}

export function IssueView({
  cfg,
  wallet,
  view = viewCall,
  retryMs = 2_000,
  save = saveJson,
  copy = (s: string) => navigator.clipboard.writeText(s),
  origin,
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
  const [pending, setPending] = useState<PendingIssue | null>(null);
  const [issued, setIssued] = useState<IssuedReceipt | null>(null);
  const [linked, setLinked] = useState<LastCheck | null>(null);
  /** When the linked check was anchored (from the registry), "missing" if it isn't, null while reading. */
  const [linkedAt, setLinkedAt] = useState<string | null>(null);
  const [unlink, setUnlink] = useState(false);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ query: string; matches: PayoutMatch[] } | null>(null);
  const [link, setLink] = useState<CopiedLink | null>(null);
  /** This browser's issued receipts for the account (read once per account and after each save). */
  const [mine, setMine] = useState<IssuedReceipt[]>([]);
  const started = useRef(false);

  const check = async (p: PendingIssue, attempts = 5) => {
    setBusy("Checking your receipt against the registry…");
    let o: VerifyOutcome | null = null;
    for (let i = 0; i < attempts; i++) {
      o = await verifyAgainstChain(JSON.stringify(p.receipt), cfg, view);
      if (o.ok || !o.checks.some((c) => c.id === "anchor" && c.detail.includes("anchored no receipt"))) break;
      await new Promise((res) => setTimeout(res, retryMs));
    }
    setBusy(null);
    setOutcome(o);
    // Anchored: the receipt is on-chain whatever the other checks say, so keep it (and its salt) here.
    if (o?.hash && o.checks.some((c) => c.id === "anchor" && c.ok)) {
      const rec: IssuedReceipt = { receipt_id: p.receipt.receipt_id, hash: o.hash, ...p };
      saveIssued(p.receipt.issuer, rec, local());
      setMine(listIssued(p.receipt.issuer, local()));
      setIssued(rec);
      try {
        session()?.removeItem(PENDING_KEY);
      } catch {}
      setPending(null);
    } else setPending(p);
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
      if (cancelled || left.receipt.issuer !== acct) {
        session()?.removeItem(PENDING_KEY);
        if (cancelled) setErrors(["The wallet transaction was cancelled; nothing was anchored."]);
        return;
      }
      await check(left);
    })();
  }, []);

  // The check this receipt will point at: the last one anchored from this browser for the account.
  useEffect(() => {
    setLinked(null);
    setLinkedAt(null);
    setMine(account ? listIssued(account, local()) : []);
    if (!account) return;
    const last = lastAnchoredCheck(account, local());
    setLinked(last);
    if (!last || !cfg.registry) return;
    let live = true;
    view<{ anchored_at_ns?: string } | null>(cfg.registry, "get_receipt", {
      issuer: account,
      receipt_id: last.report_id,
    }).then(
      (a) => live && setLinkedAt(a?.anchored_at_ns ? nsToUtc(a.anchored_at_ns) : "missing"),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [account]);

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
      const checkRef = linked && !unlink ? { report_id: linked.report_id, report_hash: linked.hash } : null;
      const prepared = prepareIssue(
        {
          csv,
          rail,
          currency,
          receiptId,
          account,
          registry,
          network: cfg.network,
          postQuantum,
          currentKeys,
          checkRef,
        },
        local(),
      );
      if (!prepared.ok) {
        setErrors(prepared.errors);
        setBusy(null);
        return;
      }
      try {
        session()?.setItem(PENDING_KEY, JSON.stringify(prepared.pending));
      } catch {}
      setIssued(null);
      setLink(null);
      setBusy("Approve the transaction in your wallet…");
      await port.send(prepared.tx);
      await check(prepared.pending);
    } catch (e) {
      setBusy(null);
      setErrors([(e as Error).message || "The transaction did not go through"]);
    }
  };

  const copyLink = async (rec: IssuedReceipt, index: number, where: CopiedLink["where"]) => {
    const url = await payeeLink(origin ?? window.location.origin, payeeProofFor(rec, index));
    let copied = false;
    try {
      await copy(url);
      copied = true;
    } catch {}
    setLink({ where, position: index + 1, url, copied });
  };

  const find = () => {
    if (!account) return;
    setLink(null);
    setFound({ query: query.trim(), matches: findPayout(account, query, local()) });
    setMine(listIssued(account, local()));
  };

  const copiedLine = (where: CopiedLink["where"]) =>
    link?.where === where && (
      <div className="stack" style={{ gap: 6 }}>
        <span className="muted small">
          {link.copied
            ? `Link for payout ${link.position} copied.`
            : `Copy the link for payout ${link.position} below.`}
        </span>
        <input aria-label="Payee link" readOnly value={link.url} onFocus={(e) => e.currentTarget.select()} />
      </div>
    );

  const receiptText = issued ? `${JSON.stringify(issued.receipt, null, 2)}\n` : "";
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
            <Eyebrow>3 · The check you made before paying</Eyebrow>
            {!account ? (
              <p className="muted small">Connect your wallet to link the check you anchored on /check.</p>
            ) : linked ? (
              <>
                <p>
                  {linkedAt && linkedAt !== "missing"
                    ? `Linked to check ${linked.report_id} anchored at ${linkedAt}`
                    : linkedAt === "missing"
                      ? `Linked to check ${linked.report_id}, but the registry has no anchor for it: /verify will not count it as checked before payment`
                      : `Linked to check ${linked.report_id} (checked at ${linked.checked_at})`}
                </p>
                <label className="tag">
                  <input type="checkbox" checked={unlink} onChange={(e) => setUnlink(e.target.checked)} />
                  {" Don't link a check"}
                </label>
                <p className="muted small" style={{ marginTop: 8 }}>
                  The receipt names this check, and /verify shows whether it was anchored before the receipt.
                </p>
              </>
            ) : (
              <p className="muted small">
                {`No check anchored from this browser for ${account} yet. `}
                <a href="/check">Check the batch on /check before paying</a>
                {" and the next receipt will point to that check."}
              </p>
            )}
          </div>

          <div>
            <Eyebrow>4 · Sign and anchor</Eyebrow>
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

      {issued && (
        <div className="stack">
          <Sticker>
            <Eyebrow>Your anchored receipt</Eyebrow>
            <div className="row">
              <Button onClick={() => save(`${issued.receipt_id}.json`, receiptText)}>
                Download receipt (auditor copy)
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  save(
                    `${issued.receipt_id}-salt.json`,
                    `${JSON.stringify(
                      {
                        receipt_id: issued.receipt_id,
                        issuer: issued.receipt.issuer,
                        receipt_salt: issued.receiptSaltHex,
                        note: "Secret. Keep it with your records and never share it: with your list of accounts, it shows which account each payee_ref is. You need it to make payee links in another browser.",
                      },
                      null,
                      2,
                    )}\n`,
                  )
                }
              >
                Download salt (keep it secret)
              </Button>
              <Button variant="secondary" href="/verify">
                Verify it again on /verify
              </Button>
            </div>
            <p className="muted small" style={{ marginTop: 8 }}>
              The auditor copy has every payout, each identified by a salted hash and the last 4 digits of the
              account, never a name. The salt is the secret behind those hashes: keep it with your records and
              don't share it.
            </p>
            <ShareLink text={receiptText.trimEnd()} copy={copy} origin={origin} />
          </Sticker>

          <Sticker>
            <Eyebrow>Payee links</Eyebrow>
            <p>Each link proves one payout. It shows nobody else's pay.</p>
            <p className="muted small">
              Payee links and the payout search work only in this browser: the names, full accounts and the
              receipt's secret salt are kept in this browser's storage and nowhere else. A link you copy opens
              anywhere, and carries no name.
            </p>
            <div className="scroll">
              <table aria-label="Payee links">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Name</th>
                    <th>Amount</th>
                    <th>Status</th>
                    <th>Link</th>
                  </tr>
                </thead>
                <tbody>
                  {issued.receipt.payouts.map((p, i) => (
                    <tr key={p.id}>
                      <td>{i + 1}</td>
                      <td>{issued.names[i]}</td>
                      <td>{`${p.amount} ${issued.receipt.currency}`}</td>
                      <td>{p.status}</td>
                      <td>
                        <Button variant="secondary" onClick={() => copyLink(issued, i, "links")}>
                          Copy link
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {copiedLine("links")}
          </Sticker>

          <DirectReport receipt={issued.receipt} hash={issued.hash} />
        </div>
      )}

      {account && (
        <Sticker>
          <Eyebrow>Find a payout · where is my money?</Eyebrow>
          <p className="muted small">
            {`When a payee asks, search by their name or full account number. This searches the ${mine.length === 1 ? "1 receipt" : `${mine.length} receipts`} issued from this browser for ${account}; the search runs here and nothing is sent.`}
          </p>
          <div className="row">
            <input
              aria-label="Find a payout"
              placeholder="Payee name or full account"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") find();
              }}
            />
            <Button variant="secondary" disabled={!query.trim()} onClick={find}>
              Find
            </Button>
          </div>
          {found &&
            (found.matches.length === 0 ? (
              <p className="muted small">{`No payout for "${found.query}" in the receipts issued from this browser.`}</p>
            ) : (
              <div className="scroll" style={{ marginTop: 10 }}>
                <table aria-label="Payouts found">
                  <thead>
                    <tr>
                      <th>Receipt</th>
                      <th>#</th>
                      <th>Name</th>
                      <th>Amount</th>
                      <th>Status</th>
                      <th>Link</th>
                    </tr>
                  </thead>
                  <tbody>
                    {found.matches.map((m) => {
                      const rec = mine.find((r) => r.receipt_id === m.receipt_id);
                      return (
                        <tr key={`${m.receipt_id}:${m.index}`}>
                          <td>{m.receipt_id}</td>
                          <td>{m.index + 1}</td>
                          <td>{m.name}</td>
                          <td>{`${m.amount} ${rec?.receipt.currency ?? ""}`.trim()}</td>
                          <td>{m.status}</td>
                          <td>
                            {rec && (
                              <Button variant="secondary" onClick={() => copyLink(rec, m.index, "find")}>
                                Copy link
                              </Button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ))}
          {copiedLine("find")}
        </Sticker>
      )}
    </div>
  );
}
