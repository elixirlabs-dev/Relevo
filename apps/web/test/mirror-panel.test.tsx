import {
  deriveEvmAddress,
  MIRROR_PATH,
  type MirrorEntry,
  type MirrorTx,
  mirrorCalldata,
  TESTNET_MPC_ROOT,
} from "@elivo/shared/evm-mirror";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MirrorPanel } from "../components/MirrorPanel.tsx";
import { VerifyView } from "../components/VerifyView.tsx";
import type { VerifyOutcome } from "../lib/verify.ts";

const REGISTRY = "registry.example.testnet";
const ISSUER = "payroll.pg-1794403941.testnet";
const RID = "payroll-2026-11-v2";
const ANCHORED = "AnchoredHashOnNear111";
const FROM = deriveEvmAddress(TESTNET_MPC_ROOT, ISSUER, MIRROR_PATH);
const TX_HASH = `0x${"ab".repeat(32)}`;
const OTHER = "0x1111111111111111111111111111111111111111";

const entry: MirrorEntry = {
  issuer: ISSUER,
  receipt_id: RID,
  receipt_hash: ANCHORED,
  chain: "sepolia",
  tx_hash: TX_HASH,
  from: FROM,
};
/** A recorded eth_getTransactionByHash answer for the mirror (only the fields the panel reads). */
const recordedTx = (over: Partial<MirrorTx> = {}): MirrorTx => ({
  from: FROM,
  to: FROM,
  input: mirrorCalldata(ISSUER, RID, ANCHORED),
  chainId: "0xaa36a7",
  ...over,
});

function fakes(tx: MirrorTx | null, mirrors: MirrorEntry[] = [entry], anchored = ANCHORED) {
  const calls: Array<{ contract: string; method: string; args?: object }> = [];
  const txs: string[] = [];
  return {
    calls,
    txs,
    props: {
      registry: REGISTRY,
      issuer: ISSUER,
      receiptId: RID,
      view: async <T,>(contract: string, method: string, args?: object): Promise<T> => {
        calls.push({ contract, method, args });
        if (method === "get_receipt") return { receipt_hash: anchored } as T;
        throw new Error(method);
      },
      loadMirrors: async () => mirrors,
      getTx: async (h: string) => {
        txs.push(h);
        return tx;
      },
    },
  };
}

afterEach(cleanup);

describe("MirrorPanel", () => {
  it("shows ✓ lines and the explorer link for a recorded mirror transaction", async () => {
    const f = fakes(recordedTx());
    render(<MirrorPanel {...f.props} />);
    expect(
      await screen.findByText(
        `✓ Sent from ${FROM} — the Ethereum address NEAR's MPC network derives for ${ISSUER}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText("✓ Carries the same receipt hash")).toBeTruthy();
    expect(screen.getByText("✓ A 0-value transaction to itself on Ethereum Sepolia")).toBeTruthy();
    expect(screen.getByText("Mirrored on Ethereum")).toBeTruthy();
    const link = screen.getByRole("link", { name: "View the transaction on Sepolia Etherscan" });
    expect(link.getAttribute("href")).toBe(`https://sepolia.etherscan.io/tx/${TX_HASH}`);
    expect(f.txs).toEqual([TX_HASH]);
    // The hash compared is the one anchored on NEAR, read from the registry.
    expect(f.calls).toContainEqual({
      contract: REGISTRY,
      method: "get_receipt",
      args: { issuer: ISSUER, receipt_id: RID },
    });
  });

  it("shows ✗ when the transaction was sent from another address", async () => {
    render(<MirrorPanel {...fakes(recordedTx({ from: OTHER, to: OTHER })).props} />);
    expect(
      await screen.findByText(
        `✗ Sent from ${OTHER}, not ${FROM} — the Ethereum address NEAR's MPC network derives for ${ISSUER}`,
      ),
    ).toBeTruthy();
    expect(screen.getByText("✓ Carries the same receipt hash")).toBeTruthy();
    expect(screen.getByText("Does not check out")).toBeTruthy();
  });

  it("shows ✗ when the transaction carries another hash", async () => {
    render(
      <MirrorPanel {...fakes(recordedTx({ input: mirrorCalldata(ISSUER, RID, "SomeOtherHash") })).props} />,
    );
    expect(await screen.findByText(/^✗ Does not carry the same receipt hash/)).toBeTruthy();
    expect(
      screen.getByText(`✓ Sent from ${FROM} — the Ethereum address NEAR's MPC network derives for ${ISSUER}`),
    ).toBeTruthy();
  });

  it("checks against the hash anchored on NEAR, not the one in mirrors.json", async () => {
    // The file claims the tx's hash, but the chain anchor says something else: ✗.
    const f = fakes(recordedTx(), [entry], "TheChainSaysThis");
    render(<MirrorPanel {...f.props} />);
    expect(await screen.findByText(/^✗ Does not carry the same receipt hash/)).toBeTruthy();
  });

  it("says so when the transaction is not on Sepolia", async () => {
    render(<MirrorPanel {...fakes(null).props} />);
    expect(
      await screen.findByText(`✗ Transaction ${TX_HASH} was not found on Ethereum Sepolia`),
    ).toBeTruthy();
  });

  it("shows one muted line when the receipt is not mirrored", async () => {
    const f = fakes(recordedTx(), []);
    render(<MirrorPanel {...f.props} />);
    expect(await screen.findByText("Not mirrored to another chain")).toBeTruthy();
    expect(screen.queryByText("Mirrored on Ethereum")).toBeNull();
    expect(f.txs).toEqual([]);
  });

  it("treats an unreadable mirrors.json as not mirrored", async () => {
    const f = fakes(recordedTx());
    render(
      <MirrorPanel
        {...f.props}
        loadMirrors={async () => {
          throw new Error("404");
        }}
      />,
    );
    expect(await screen.findByText("Not mirrored to another chain")).toBeTruthy();
  });
});

describe("VerifyView's mirror panel", () => {
  it("shows the mirror for a verified registry receipt on testnet", async () => {
    const { readFileSync } = await import("node:fs");
    const v2 = JSON.parse(readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8"));
    const ok: VerifyOutcome = {
      receipt: null,
      direct: null,
      directV2: { ...v2, issuer: ISSUER, receipt_id: RID },
      hash: ANCHORED,
      ok: true,
      checks: [{ id: "anchor", ok: true, detail: "Hash matches" }],
    };
    const f = fakes(recordedTx());
    const view = f.props.view;
    render(
      <VerifyView
        app={{ escrow: "escrow.example.testnet", network: "testnet", registry: REGISTRY, dao: null }}
        verify={async () => ok}
        attest={{
          view: async <T,>() => [] as T,
          retryMs: 1,
          wallet: {
            port: { accountId: () => null, signIn: async () => {}, send: async () => {} },
            wallets: [],
          },
        }}
        mirror={{ view, loadMirrors: f.props.loadMirrors, getTx: f.props.getTx }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Receipt JSON"), { target: { value: "{}" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("✓ Carries the same receipt hash")).toBeTruthy();
    await waitFor(() => expect(f.txs).toEqual([TX_HASH]));
  });
});
