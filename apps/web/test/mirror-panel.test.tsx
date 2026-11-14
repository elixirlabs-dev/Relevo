import {
  deriveEvmAddress,
  MIRROR_PATH,
  type MirrorEntry,
  type MirrorTx,
  mirrorCalldata,
  TESTNET_MPC_SIGNER,
} from "@elivo/shared/evm-mirror";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { privateKeyToAccount } from "viem/accounts";
import { afterEach, describe, expect, it } from "vitest";
import { type FixtureOpts, signedMirrorTx, testRootKey } from "../../../scripts/lib/mirror-fixture.ts";
import { MirrorPanel } from "../components/MirrorPanel.tsx";
import { VerifyView } from "../components/VerifyView.tsx";
import type { VerifyOutcome } from "../lib/verify.ts";

const REGISTRY = "registry.example.testnet";
const ISSUER = "payroll.pg-1794403941.testnet";
const RID = "payroll-2026-11-v2";
const ANCHORED = "AnchoredHashOnNear111";
// The signer contract's root key is read from the chain; here it is a test root we hold the key for,
// so the fixtures are real type-2 transactions signed by the derived child key.
const ROOT = testRootKey();
const FROM = deriveEvmAddress(ROOT, ISSUER, MIRROR_PATH);
const OTHER_SK = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
const OTHER = privateKeyToAccount(`0x${OTHER_SK.toString(16).padStart(64, "0")}`).address.toLowerCase();
const TX_HASH = `0x${"ab".repeat(32)}`;
const DERIVES = `the Ethereum address NEAR's MPC network derives for ${ISSUER}`;

const entry: MirrorEntry = {
  issuer: ISSUER,
  receipt_id: RID,
  receipt_hash: ANCHORED,
  chain: "sepolia",
  tx_hash: TX_HASH,
  from: FROM,
};
/** A real signed eth_getTransactionByHash answer for the mirror. */
const signedTx = (o: Partial<FixtureOpts> = {}) =>
  signedMirrorTx({ issuer: ISSUER, receiptId: RID, receiptHash: ANCHORED, ...o });

function fakes(
  tx: MirrorTx | null,
  o: { mirrors?: MirrorEntry[]; anchored?: string; root?: string | Error } = {},
) {
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
        if (method === "get_receipt") return { receipt_hash: o.anchored ?? ANCHORED } as T;
        if (contract === TESTNET_MPC_SIGNER && method === "public_key") {
          const root = o.root ?? ROOT;
          if (root instanceof Error) throw root;
          return root as T;
        }
        throw new Error(method);
      },
      loadMirrors: async () => o.mirrors ?? [entry],
      getTx: async (h: string) => {
        txs.push(h);
        return tx;
      },
    },
  };
}

afterEach(cleanup);

describe("MirrorPanel", () => {
  it("shows ✓ lines and the explorer link for a real signed, mined mirror transaction", async () => {
    const f = fakes(await signedTx());
    render(<MirrorPanel {...f.props} />);
    expect(await screen.findByText(`✓ Sent from ${FROM} — ${DERIVES}`)).toBeTruthy();
    expect(screen.getByText("✓ Carries the same receipt hash")).toBeTruthy();
    expect(screen.getByText("✓ Sent back to itself on Ethereum Sepolia")).toBeTruthy();
    expect(screen.getByText("✓ Included in Sepolia block 16")).toBeTruthy();
    expect(screen.getByText("Checks out")).toBeTruthy();
    expect(screen.getByText("Mirrored on Ethereum")).toBeTruthy();
    const link = screen.getByRole("link", { name: "View the transaction on Sepolia Etherscan" });
    expect(link.getAttribute("href")).toBe(`https://sepolia.etherscan.io/tx/${TX_HASH}`);
    expect(f.txs).toEqual([TX_HASH]);
    // The hash compared is the one anchored on NEAR, and the root key is the signer's, both read from NEAR.
    expect(f.calls).toContainEqual({
      contract: REGISTRY,
      method: "get_receipt",
      args: { issuer: ISSUER, receipt_id: RID },
    });
    expect(f.calls).toContainEqual({ contract: TESTNET_MPC_SIGNER, method: "public_key", args: {} });
    expect(screen.getByText(new RegExp(`public key, read from ${TESTNET_MPC_SIGNER}\\.`))).toBeTruthy();
  });

  it("shows ✗ when another key signed it, even though the RPC claims the derived `from`", async () => {
    const tx = await signedTx({ signerSk: OTHER_SK });
    render(<MirrorPanel {...fakes({ ...tx, from: FROM }).props} />);
    expect(await screen.findByText(`✗ Sent from ${OTHER}, not ${FROM} — ${DERIVES}`)).toBeTruthy();
    expect(screen.getByText("✓ Carries the same receipt hash")).toBeTruthy();
    expect(screen.getByText("Does not check out")).toBeTruthy();
  });

  it("shows ✗ when the transaction carries another hash", async () => {
    render(
      <MirrorPanel
        {...fakes(await signedTx({ data: mirrorCalldata(ISSUER, RID, "SomeOtherHash") })).props}
      />,
    );
    expect(await screen.findByText(/^✗ Does not carry the same receipt hash/)).toBeTruthy();
    expect(screen.getByText(`✓ Sent from ${FROM} — ${DERIVES}`)).toBeTruthy();
  });

  it("checks against the hash anchored on NEAR, not the one in mirrors.json", async () => {
    const f = fakes(await signedTx(), { anchored: "TheChainSaysThis" });
    render(<MirrorPanel {...f.props} />);
    expect(await screen.findByText(/^✗ Does not carry the same receipt hash/)).toBeTruthy();
  });

  it("does not show a pending transaction as a full ✓", async () => {
    render(<MirrorPanel {...fakes(await signedTx({ blockNumber: null })).props} />);
    expect(await screen.findByText("✗ Not yet included in a block")).toBeTruthy();
    expect(screen.getByText(`✓ Sent from ${FROM} — ${DERIVES}`)).toBeTruthy();
    expect(screen.getByText("Does not check out")).toBeTruthy();
    expect(screen.queryByText("Checks out")).toBeNull();
  });

  it("refuses a transaction that is not type 2", async () => {
    render(<MirrorPanel {...fakes({ ...(await signedTx()), type: "0x0" }).props} />);
    expect(
      await screen.findByText("✗ Not an EIP-1559 (type 2) transaction, so its sender can't be checked"),
    ).toBeTruthy();
    expect(screen.queryByText(/^✓ Sent from/)).toBeNull();
  });

  it("falls back to the built-in root key when reading it fails, and says so", async () => {
    // The built-in key is the real testnet root, so the test-signed tx no longer matches: ✗.
    const f = fakes(await signedTx(), { root: new Error("view public_key: HTTP 502") });
    render(<MirrorPanel {...f.props} />);
    expect(await screen.findByText(/^✗ Sent from /)).toBeTruthy();
    expect(
      screen.getByText(
        new RegExp(
          `built into this app, because reading it from ${TESTNET_MPC_SIGNER} failed: view public_key: HTTP 502`,
        ),
      ),
    ).toBeTruthy();
  });

  it("says so when the transaction is not on Sepolia", async () => {
    render(<MirrorPanel {...fakes(null).props} />);
    expect(
      await screen.findByText(`✗ Transaction ${TX_HASH} was not found on Ethereum Sepolia`),
    ).toBeTruthy();
  });

  it("shows one muted line when the receipt is not mirrored", async () => {
    const f = fakes(await signedTx(), { mirrors: [] });
    render(<MirrorPanel {...f.props} />);
    expect(await screen.findByText("Not mirrored to another chain")).toBeTruthy();
    expect(screen.queryByText("Mirrored on Ethereum")).toBeNull();
    expect(f.txs).toEqual([]);
  });

  it("treats an unreadable mirrors.json as not mirrored", async () => {
    const f = fakes(await signedTx());
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
    const f = fakes(await signedTx());
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
        mirror={{ view: f.props.view, loadMirrors: f.props.loadMirrors, getTx: f.props.getTx }}
      />,
    );
    fireEvent.change(screen.getByLabelText("Receipt JSON"), { target: { value: "{}" } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(await screen.findByText("✓ Carries the same receipt hash")).toBeTruthy();
    await waitFor(() => expect(f.txs).toEqual([TX_HASH]));
  });
});
