import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CheckView } from "../components/CheckView.tsx";
import { lastAnchoredCheck, PENDING_CHECK_KEY } from "../lib/check.ts";
import type { WalletPort } from "../lib/signer.ts";
import type { TxSpec } from "../lib/txs.ts";

const cfg = {
  network: "testnet" as const,
  escrow: "escrow.t",
  registry: "registry.example.testnet",
  explorer: "https://testnet.nearblocks.io",
};
const wallets = [{ id: "meteor-wallet", name: "Meteor Wallet" }];

/** A fake chain: the registry remembers what the wallet's transaction published and anchored. */
function fakeChain() {
  let keys: { receipt_pk: string; mldsa65_pk: string | null } | null = null;
  const anchors = new Map<string, string>();
  const sent: TxSpec[] = [];
  const apply = (tx: TxSpec) => {
    sent.push(tx);
    for (const a of tx.actions) {
      const args = a.params.args as Record<string, string | null>;
      if (a.params.methodName === "set_keys")
        keys = { receipt_pk: args.receipt_pk as string, mldsa65_pk: args.mldsa65_pk };
      if (a.params.methodName === "anchor")
        anchors.set(args.receipt_id as string, args.receipt_hash as string);
    }
  };
  const view = async <T,>(_c: string, method: string, args?: object): Promise<T> => {
    const a = args as { receipt_id?: string };
    if (method === "get_keys") return keys as T;
    if (method === "get_receipt") {
      const h = anchors.get(a.receipt_id as string);
      return (h && keys ? { ...keys, receipt_hash: h, key_version: 1 } : null) as T;
    }
    throw new Error(method);
  };
  return { apply, view, sent };
}

function port(account: string | null, apply: (tx: TxSpec) => void): WalletPort {
  return { accountId: () => account, signIn: async () => {}, send: async (tx) => apply(tx) };
}

const anchorButton = () =>
  screen.getByRole("button", { name: "Anchor this check on NEAR" }) as HTMLButtonElement;

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
});
afterEach(cleanup);

describe("CheckView", () => {
  it("shows block and warning chips for the sample with problems, and won't anchor it", async () => {
    const c = fakeChain();
    render(
      <CheckView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Use a sample batch with problems" }));
    fireEvent.click(screen.getByRole("button", { name: "Check batch" }));
    expect((await screen.findAllByText(/^Block · /)).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/^Warning · /).length).toBeGreaterThan(0);
    expect(screen.getByText("Warning · account changed")).toBeTruthy();
    expect(anchorButton().disabled).toBe(true);
    expect(screen.getByText(/1 row is blocked/)).toBeTruthy();
    expect(
      screen.getByText(
        /Name-to-account matching needs a licensed account-validation provider; not checked in this prototype\./,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(/Testnet prototype\. Payout firms and SPEI receipts are simulated\./),
    ).toBeTruthy();
    expect(c.sent).toHaveLength(0);
  });

  it("anchors a clean batch's check report, then points to /issue", async () => {
    const c = fakeChain();
    const saved: string[] = [];
    render(
      <CheckView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
        save={(name) => saved.push(name)}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Check batch" }));
    expect(await screen.findByText(/No blocking problems/)).toBeTruthy();
    expect(screen.queryAllByText(/^Block · /)).toHaveLength(0);
    expect(anchorButton().disabled).toBe(false);
    fireEvent.click(anchorButton());
    expect(await screen.findByText("Anchored and verified against the chain")).toBeTruthy();
    expect(c.sent).toHaveLength(1);
    expect(c.sent[0].actions.map((a) => a.params.methodName)).toEqual(["set_keys", "anchor"]);
    const last = lastAnchoredCheck("alice.testnet", localStorage);
    expect(last?.report_id).toMatch(/^check-\d{8}-\d{6}$/);
    expect(screen.getByText(last?.report_id as string)).toBeTruthy();
    expect(
      screen.getByRole("link", { name: "Next: issue the receipt after paying →" }).getAttribute("href"),
    ).toBe("/issue");
    fireEvent.click(screen.getByRole("button", { name: "Download check report (JSON)" }));
    expect(saved).toEqual([`${last?.report_id}.json`]);
    expect(sessionStorage.getItem(PENDING_CHECK_KEY)).toBeNull();
  });

  it("asks for a wallet before it can anchor", async () => {
    const c = fakeChain();
    render(<CheckView cfg={cfg} wallet={{ port: port(null, c.apply), wallets }} view={c.view} retryMs={1} />);
    fireEvent.click(screen.getByRole("button", { name: "Check batch" }));
    await screen.findByText(/No blocking problems/);
    expect(screen.getByRole("button", { name: "Connect Meteor Wallet" })).toBeTruthy();
    expect(anchorButton().disabled).toBe(true);
  });

  it("picks up a check report left pending by a wallet that reloaded the page", async () => {
    const c = fakeChain();
    const first = render(
      <CheckView
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
    fireEvent.click(screen.getByRole("button", { name: "Check batch" }));
    await screen.findByText(/No blocking problems/);
    fireEvent.click(anchorButton());
    await screen.findByText("page reloaded");
    expect(sessionStorage.getItem(PENDING_CHECK_KEY)).not.toBeNull();
    first.unmount();
    render(
      <CheckView
        cfg={cfg}
        wallet={{ port: port("alice.testnet", c.apply), wallets }}
        view={c.view}
        retryMs={1}
      />,
    );
    expect(await screen.findByText("Anchored and verified against the chain")).toBeTruthy();
    expect(sessionStorage.getItem(PENDING_CHECK_KEY)).toBeNull();
    expect(lastAnchoredCheck("alice.testnet", localStorage)).not.toBeNull();
  });
});
