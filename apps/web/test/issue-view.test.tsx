import { isPayeeProof, payeeRefMatches, verifyPayeeProofStructure } from "@elivo/shared/direct-receipt-v2";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueView } from "../components/IssueView.tsx";
import { recordAnchoredCheck } from "../lib/check.ts";
import { PENDING_KEY } from "../lib/issue.ts";
import { listIssued } from "../lib/receipt-store.ts";
import { decodeShare } from "../lib/share.ts";
import type { WalletPort } from "../lib/signer.ts";
import type { TxSpec } from "../lib/txs.ts";

const cfg = { network: "testnet" as const, escrow: "escrow.t", registry: "registry.example.testnet" };
const wallets = [{ id: "meteor-wallet", name: "Meteor Wallet" }];

/** A fake chain: the registry remembers what the wallet's transaction published and anchored, and when. */
function fakeChain() {
  let keys: { receipt_pk: string; mldsa65_pk: string | null } | null = null;
  // 2026-11-14 12:00:00 UTC, one minute per anchor
  let clock = 1794657600000000000n;
  const anchors = new Map<string, { hash: string; ns: string }>();
  const sent: TxSpec[] = [];
  const calls: unknown[] = [];
  const anchorNow = (id: string, hash: string) => {
    anchors.set(id, { hash, ns: String(clock) });
    clock += 60_000_000_000n;
  };
  const apply = (tx: TxSpec) => {
    sent.push(tx);
    for (const a of tx.actions) {
      const args = a.params.args as Record<string, string | null>;
      if (a.params.methodName === "set_keys")
        keys = { receipt_pk: args.receipt_pk as string, mldsa65_pk: args.mldsa65_pk };
      if (a.params.methodName === "anchor") anchorNow(args.receipt_id as string, args.receipt_hash as string);
    }
  };
  const view = async <T,>(_c: string, method: string, args?: object): Promise<T> => {
    calls.push({ method, args });
    const a = args as { issuer?: string; receipt_id?: string };
    if (method === "get_keys") return keys as T;
    if (method === "get_receipt") {
      const h = anchors.get(a.receipt_id as string);
      return (
        h
          ? {
              issuer: a.issuer,
              receipt_pk: keys?.receipt_pk ?? "ed25519:none",
              mldsa65_pk: keys?.mldsa65_pk ?? null,
              receipt_hash: h.hash,
              key_version: 1,
              anchored_at_ns: h.ns,
            }
          : null
      ) as T;
    }
    throw new Error(method);
  };
  return { apply, view, sent, calls, anchorNow };
}

const NAMES = ["Lucía Fernández", "Mateo Ríos", "Sofía Herrera", "Diego Navarro", "Valentina Cruz"];
const ACCOUNTS = ["002010077777777771", "032180000118359719", "012180001234567899"];

function port(account: string | null, apply: (tx: TxSpec) => void): WalletPort {
  return { accountId: () => account, signIn: async () => {}, send: async (tx) => apply(tx) };
}

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe("IssueView", () => {
  it("asks for a wallet before it can sign", () => {
    const c = fakeChain();
    render(<IssueView cfg={cfg} wallet={{ port: port(null, c.apply), wallets }} view={c.view} retryMs={1} />);
    expect(screen.getByRole("button", { name: "Connect Meteor Wallet" })).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "Sign and anchor the receipt" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("signs in the browser, sends one transaction, and verifies the anchored receipt", async () => {
    const c = fakeChain();
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
      />,
    );
    expect(screen.getByText("Signed in as alice.testnet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    expect(await screen.findByText("Anchored and verified against the chain")).toBeTruthy();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].actions.map((a) => a.params.methodName)).toEqual(["set_keys", "anchor"]);
    expect(screen.getByText(/Signed twice/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download receipt (auditor copy)" })).toBeTruthy();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    // Names and account numbers never reach the chain or any request.
    for (const secret of [...NAMES, ...ACCOUNTS]) {
      expect(JSON.stringify(c.sent)).not.toContain(secret);
      expect(JSON.stringify(c.calls)).not.toContain(secret);
    }
  });

  it("issues a v2 receipt and lists a payee link for each payout, named only in this browser", async () => {
    const c = fakeChain();
    const copied: string[] = [];
    const saved: Array<{ name: string; text: string }> = [];
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
        save={(name, text) => saved.push({ name, text })}
        copy={async (s) => {
          copied.push(s);
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Receipt id"), { target: { value: "nov-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    await screen.findByText("Anchored and verified against the chain");
    const table = screen.getByRole("table", { name: "Payee links" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(6);
    expect(within(rows[1]).getByText("1")).toBeTruthy();
    expect(within(rows[1]).getByText("Lucía Fernández")).toBeTruthy();
    expect(within(rows[3]).getByText("Returned")).toBeTruthy();
    expect(screen.getByText("Each link proves one payout. It shows nobody else's pay.")).toBeTruthy();
    expect(screen.getByText(/work only in this browser/)).toBeTruthy();

    fireEvent.click(within(rows[5]).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(copied[0]).toMatch(/\/payee#p=[\w-]+$/);
    const proof = JSON.parse((await decodeShare(copied[0].split("#p=")[1])) as string);
    expect(isPayeeProof(proof)).toBe(true);
    expect(verifyPayeeProofStructure(proof)).toEqual([]);
    expect(proof.payout.id).toBe(4);
    expect(payeeRefMatches(proof, "646180005555555554")).toBe(true);
    expect(copied[0]).not.toContain("Valentina");

    // The auditor copy has every row but no name; the salt is a separate, secret download.
    fireEvent.click(screen.getByRole("button", { name: "Download receipt (auditor copy)" }));
    fireEvent.click(screen.getByRole("button", { name: "Download salt (keep it secret)" }));
    expect(saved.map((f) => f.name)).toEqual(["nov-v2.json", "nov-v2-salt.json"]);
    const receipt = JSON.parse(saved[0].text);
    expect(receipt.version).toBe("elivo-direct-receipt-2");
    expect(receipt.payouts).toHaveLength(5);
    expect(saved[0].text).not.toContain("Lucía");
    const salt = JSON.parse(saved[1].text);
    expect(salt.receipt_salt).toMatch(/^[0-9a-f]{32}$/);
    expect(saved[0].text).not.toContain(salt.receipt_salt);

    // Kept in this browser's localStorage, for the payout search and later links.
    const stored = listIssued("alice.testnet", localStorage);
    expect(stored.map((r) => r.receipt_id)).toEqual(["nov-v2"]);
    expect(stored[0].receiptSaltHex).toBe(salt.receipt_salt);
  });

  it("finds a payout across this browser's issued receipts and copies its link", async () => {
    const c = fakeChain();
    const copied: string[] = [];
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
        copy={async (s) => {
          copied.push(s);
        }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Receipt id"), { target: { value: "nov-v2" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    await screen.findByText("Anchored and verified against the chain");
    fireEvent.change(screen.getByLabelText("Find a payout"), { target: { value: "sofia herrera" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    const found = await screen.findByRole("table", { name: "Payouts found" });
    const rows = within(found).getAllByRole("row");
    expect(rows).toHaveLength(2);
    expect(within(rows[1]).getByText("nov-v2")).toBeTruthy();
    expect(within(rows[1]).getByText("3")).toBeTruthy();
    expect(within(rows[1]).getByText("Sofía Herrera")).toBeTruthy();
    expect(within(rows[1]).getByText("27750.00 MXN")).toBeTruthy();
    fireEvent.click(within(rows[1]).getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(copied).toHaveLength(1));
    const proof = JSON.parse((await decodeShare(copied[0].split("#p=")[1])) as string);
    expect(proof.payout.id).toBe(2);
    fireEvent.change(screen.getByLabelText("Find a payout"), { target: { value: "nobody" } });
    fireEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(await screen.findByText(/No payout for "nobody"/)).toBeTruthy();
  });

  it("links the last check anchored from this browser, and can leave it out", async () => {
    const c = fakeChain();
    c.anchorNow("check-20261114-115900", "CheckHash1");
    recordAnchoredCheck(
      "alice.testnet",
      { report_id: "check-20261114-115900", hash: "CheckHash1", checked_at: "2026-11-14T11:59:00.000Z" },
      localStorage,
    );
    const saved: Array<{ name: string; text: string }> = [];
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
        save={(name, text) => saved.push({ name, text })}
      />,
    );
    expect(
      await screen.findByText("Linked to check check-20261114-115900 anchored at 2026-11-14 12:00:00 UTC"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    await screen.findByText("Anchored and verified against the chain");
    expect(screen.getByText(/✓ Checked before payment: check anchored 2026-11-14 12:00:00 UTC/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download receipt (auditor copy)" }));
    expect(JSON.parse(saved[0].text).check_ref).toEqual({
      report_id: "check-20261114-115900",
      report_hash: "CheckHash1",
    });
  });

  it("leaves the check out when asked", async () => {
    const c = fakeChain();
    c.anchorNow("check-20261114-115900", "CheckHash1");
    recordAnchoredCheck(
      "alice.testnet",
      { report_id: "check-20261114-115900", hash: "CheckHash1", checked_at: "2026-11-14T11:59:00.000Z" },
      localStorage,
    );
    const saved: Array<{ name: string; text: string }> = [];
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
        save={(name, text) => saved.push({ name, text })}
      />,
    );
    fireEvent.click(await screen.findByLabelText("Don't link a check"));
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    await screen.findByText("Anchored and verified against the chain");
    expect(screen.queryByText(/Checked before payment/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Download receipt (auditor copy)" }));
    expect(JSON.parse(saved[0].text).check_ref).toBeNull();
  });

  it("says when there is no anchored check to link", async () => {
    const c = fakeChain();
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
      />,
    );
    expect(await screen.findByText(/No check anchored from this browser/)).toBeTruthy();
    expect(screen.queryByLabelText("Don't link a check")).toBeNull();
  });

  it("carries the testnet label", () => {
    const c = fakeChain();
    render(<IssueView cfg={cfg} wallet={{ port: port(null, c.apply), wallets }} view={c.view} retryMs={1} />);
    expect(
      screen.getByText(/Testnet prototype\. Payout firms and SPEI receipts are simulated\./),
    ).toBeTruthy();
  });

  it("shows bad rows instead of sending anything", async () => {
    const c = fakeChain();
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
      />,
    );
    fireEvent.change(screen.getByLabelText("Payout results CSV"), {
      target: {
        value:
          "name,account,amount,status,paid_at,reference\nA,002010077777777772,1,paid,2026-11-14T10:00:00Z,R\n",
      },
    });
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    expect(await screen.findByText("Row 2: clabe_check_digit")).toBeTruthy();
    expect(c.sent).toHaveLength(0);
  });

  it("picks up a receipt left pending by a wallet that reloaded the page", async () => {
    const c = fakeChain();
    // First visit: sign and send, but pretend the page reloads before the check runs.
    const first = render(
      <IssueView
        cfg={cfg}
        wallet={{
          port: {
            ...port("alice.testnet", c.apply),
            send: async (tx) => {
              c.apply(tx);
              throw new Error("page reloaded");
            },
          },
          wallets,
        }}
        view={c.view}
        retryMs={1}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sign and anchor the receipt" }));
    await screen.findByText("page reloaded");
    expect(sessionStorage.getItem(PENDING_KEY)).not.toBeNull();
    first.unmount();
    // Back from the wallet: the page finds the pending receipt and checks it against the chain.
    render(
      <IssueView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
      />,
    );
    expect(await screen.findByText("Anchored and verified against the chain")).toBeTruthy();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
    // The salt and names came back from sessionStorage: payee links still work after the reload.
    expect(screen.getByRole("table", { name: "Payee links" })).toBeTruthy();
    expect(listIssued("alice.testnet", localStorage)).toHaveLength(1);
  });
});
