import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IssueView } from "../components/IssueView.tsx";
import { PENDING_KEY } from "../lib/issue.ts";
import type { WalletPort } from "../lib/signer.ts";
import type { TxSpec } from "../lib/txs.ts";

const cfg = { network: "testnet" as const, escrow: "escrow.t", registry: "registry.example.testnet" };
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
    expect(screen.getByRole("button", { name: "Download the receipt" })).toBeTruthy();
    expect(sessionStorage.getItem(PENDING_KEY)).toBeNull();
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
  });
});
