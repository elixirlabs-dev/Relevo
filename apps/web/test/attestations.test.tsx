import { ATTEST_DEPOSIT } from "@elivo/shared/direct-receipt";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVectors } from "../../../scripts/lib/receipt-vectors.ts";
import { Attestations } from "../components/Attestations.tsx";
import { VerifyView } from "../components/VerifyView.tsx";
import { ATTEST_PENDING_KEY } from "../lib/attest.ts";
import type { WalletPort } from "../lib/signer.ts";
import type { TxSpec } from "../lib/txs.ts";
import type { VerifyOutcome } from "../lib/verify.ts";

const REGISTRY = "registry.example.testnet";
const DAO = "dao.example.testnet";
const ISSUER = "payroll.example.testnet";
const RID = "payroll-2026-11-v2";
const COUNCIL = "council.example.testnet";
// 2026-11-14 12:00:00 UTC
const NS = "1794657600000000000";
const POLICY = {
  roles: [
    { name: "all", kind: "Everyone" },
    { name: "council", kind: { Group: [COUNCIL] } },
  ],
};
const wallets = [{ id: "meteor-wallet", name: "Meteor Wallet" }];

type Att = { attester: string; attested_at_ns: string };

/** A fake chain: get_attestations from a list the wallet's attest appends to; get_policy from `policy`. */
function fakeChain(atts: Att[], policy: object | Error = POLICY) {
  const list = [...atts];
  const sent: TxSpec[] = [];
  /** The pending attest in sessionStorage at the moment each transaction went to the wallet. */
  const pendings: Array<string | null> = [];
  const calls: Array<{ contract: string; method: string; args?: object }> = [];
  const view = async <T,>(contract: string, method: string, args?: object): Promise<T> => {
    calls.push({ contract, method, args });
    if (method === "get_attestations") return [...list] as T;
    if (method === "get_policy") {
      if (policy instanceof Error) throw policy;
      return policy as T;
    }
    throw new Error(method);
  };
  const port = (account: string | null, fail?: string): WalletPort => {
    let acct = account;
    return {
      accountId: () => acct,
      signIn: async () => {
        acct ??= "auditor.testnet";
      },
      send: async (tx) => {
        if (fail) throw new Error(fail);
        sent.push(tx);
        pendings.push(sessionStorage.getItem(ATTEST_PENDING_KEY));
        list.push({ attester: acct as string, attested_at_ns: NS });
      },
    };
  };
  return { view, port, sent, calls, list, pendings };
}

const props = {
  registry: REGISTRY,
  dao: DAO,
  issuer: ISSUER,
  receiptId: RID,
  hash: "HV2",
  text: "{}",
  retryMs: 1,
};

beforeEach(() => {
  sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Attestations", () => {
  it("lists each attester with its time and a DAO chip from the DAO's policy", async () => {
    const c = fakeChain([
      { attester: COUNCIL, attested_at_ns: NS },
      { attester: "auditor.testnet", attested_at_ns: NS },
    ]);
    render(<Attestations {...props} view={c.view} wallet={{ port: c.port(null), wallets }} />);
    expect(await screen.findByText(`${COUNCIL} · 2026-11-14 12:00:00 UTC`)).toBeTruthy();
    expect(screen.getByText("auditor.testnet · 2026-11-14 12:00:00 UTC")).toBeTruthy();
    expect(await screen.findByText("DAO council")).toBeTruthy();
    expect(screen.getAllByText(/^DAO /)).toHaveLength(1);
    expect(c.calls).toContainEqual({ contract: DAO, method: "get_policy", args: undefined });
    expect(c.calls).toContainEqual({
      contract: REGISTRY,
      method: "get_attestations",
      args: { issuer: ISSUER, receipt_id: RID },
    });
  });

  it("marks the issuer's own attestation with an Issuer chip, so it doesn't read as independent", async () => {
    const c = fakeChain([
      { attester: ISSUER, attested_at_ns: NS },
      { attester: "auditor.testnet", attested_at_ns: NS },
    ]);
    render(<Attestations {...props} view={c.view} wallet={{ port: c.port(null), wallets }} />);
    const own = (await screen.findByText(`${ISSUER} · 2026-11-14 12:00:00 UTC`)).closest("li") as HTMLElement;
    expect(own.textContent).toContain("Issuer");
    expect(screen.getAllByText("Issuer")).toHaveLength(1);
    const other = screen.getByText("auditor.testnet · 2026-11-14 12:00:00 UTC").closest("li") as HTMLElement;
    expect(other.textContent).not.toContain("Issuer");
  });

  it("lists attesters without chips when the policy read fails", async () => {
    const c = fakeChain([{ attester: COUNCIL, attested_at_ns: NS }], new Error("view get_policy: 403"));
    render(<Attestations {...props} view={c.view} wallet={{ port: c.port(null), wallets }} />);
    expect(await screen.findByText(`${COUNCIL} · 2026-11-14 12:00:00 UTC`)).toBeTruthy();
    await waitFor(() => expect(c.calls.some((x) => x.method === "get_policy")).toBe(true));
    expect(screen.queryByText(/^DAO /)).toBeNull();
  });

  it("says no one has attested when the list is empty", async () => {
    const c = fakeChain([]);
    render(<Attestations {...props} view={c.view} wallet={{ port: c.port(null), wallets }} />);
    expect(await screen.findByText("No one has attested this receipt yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Attest that you checked this receipt" })).toBeTruthy();
    expect(
      screen.getByText(
        "Your NEAR account is recorded as having checked this receipt. You're vouching that you ran the checks, not that the payments happened.",
      ),
    ).toBeTruthy();
  });

  it("hides the button when the connected account already attested", async () => {
    const c = fakeChain([{ attester: COUNCIL, attested_at_ns: NS }]);
    render(<Attestations {...props} view={c.view} wallet={{ port: c.port(COUNCIL), wallets }} />);
    expect(await screen.findByText(`You attested this receipt as ${COUNCIL}.`)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Attest that you checked this receipt" })).toBeNull();
  });

  it("connects a wallet, sends attest and lists the new attester", async () => {
    const c = fakeChain([]);
    render(<Attestations {...props} view={c.view} wallet={{ port: c.port(null), wallets }} />);
    fireEvent.click(await screen.findByRole("button", { name: "Attest that you checked this receipt" }));
    fireEvent.click(await screen.findByRole("button", { name: "Connect Meteor Wallet" }));
    expect(await screen.findByText("auditor.testnet · 2026-11-14 12:00:00 UTC")).toBeTruthy();
    expect(c.sent).toEqual([
      {
        receiverId: REGISTRY,
        actions: [
          {
            type: "FunctionCall",
            params: {
              methodName: "attest",
              args: { issuer: ISSUER, receipt_id: RID, receipt_hash: "HV2" },
              gas: "30000000000000",
              deposit: ATTEST_DEPOSIT.toString(),
            },
          },
        ],
      },
    ]);
    expect(screen.queryByRole("button", { name: "Attest that you checked this receipt" })).toBeNull();
    // While the wallet had the transaction, the receipt text was kept for a reload; it is gone after.
    expect(JSON.parse(c.pendings[0] as string)).toMatchObject({
      issuer: ISSUER,
      receipt_id: RID,
      account: "auditor.testnet",
      text: "{}",
    });
    expect(sessionStorage.getItem(ATTEST_PENDING_KEY)).toBeNull();
  });

  it("off testnet, lists attesters but offers no wallet button (the wallets are testnet wallets)", async () => {
    const c = fakeChain([{ attester: COUNCIL, attested_at_ns: NS }]);
    render(<Attestations {...props} network="sandbox" view={c.view} />);
    expect(await screen.findByText(`${COUNCIL} · 2026-11-14 12:00:00 UTC`)).toBeTruthy();
    expect(screen.getByText("Attesting from a wallet needs the testnet deployment.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Attest that you checked this receipt" })).toBeNull();
  });

  it("puts a contract error in plain words", async () => {
    const c = fakeChain([]);
    render(
      <Attestations
        {...props}
        view={c.view}
        wallet={{ port: c.port("auditor.testnet", "Smart contract panicked: hash_mismatch"), wallets }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Attest that you checked this receipt" }));
    expect(await screen.findByText("This file doesn't match the anchored receipt.")).toBeTruthy();
  });

  it("after a wallet redirect, re-reads the list until the chain shows the attestation", async () => {
    sessionStorage.setItem(
      ATTEST_PENDING_KEY,
      JSON.stringify({
        issuer: ISSUER,
        receipt_id: RID,
        account: "auditor.testnet",
        text: "{}",
        at: Date.now(),
      }),
    );
    const c = fakeChain([]);
    let reads = 0;
    const lagging = async <T,>(contract: string, method: string, args?: object): Promise<T> => {
      // The chain catches up on the third read.
      if (method === "get_attestations" && ++reads === 3)
        c.list.push({ attester: "auditor.testnet", attested_at_ns: NS });
      return c.view<T>(contract, method, args);
    };
    render(<Attestations {...props} view={lagging} wallet={{ port: c.port("auditor.testnet"), wallets }} />);
    expect(await screen.findByText("You attested this receipt as auditor.testnet.")).toBeTruthy();
    expect(reads).toBeGreaterThanOrEqual(3);
    expect(sessionStorage.getItem(ATTEST_PENDING_KEY)).toBeNull();
  });
});

describe("VerifyView's attestations panel", () => {
  const { files, manifest } = buildVectors();
  const app = { escrow: "escrow.example.testnet", network: "testnet" as const, registry: REGISTRY, dao: DAO };
  const checks = [
    { id: "registry" as const, ok: true, detail: "For the registry" },
    { id: "signature" as const, ok: true, detail: "Signed" },
    { id: "anchor" as const, ok: true, detail: "Hash matches" },
    { id: "totals" as const, ok: true, detail: "Totals add up" },
  ];
  const paste = (text: string) => {
    fireEvent.change(screen.getByLabelText("Receipt JSON"), { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
  };

  it("shows the panel for a verified registry receipt", async () => {
    const { readFileSync } = await import("node:fs");
    const v2 = JSON.parse(readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8"));
    const ok: VerifyOutcome = { receipt: null, direct: null, directV2: v2, hash: "HV2", ok: true, checks };
    const c = fakeChain([{ attester: COUNCIL, attested_at_ns: NS }]);
    render(
      <VerifyView
        app={app}
        verify={async () => ok}
        attest={{ view: c.view, wallet: { port: c.port(null), wallets }, retryMs: 1 }}
      />,
    );
    paste("{}");
    expect(await screen.findByText(`${COUNCIL} · 2026-11-14 12:00:00 UTC`)).toBeTruthy();
    expect(screen.getByText("Attestations")).toBeTruthy();
    expect(c.calls).toContainEqual({
      contract: REGISTRY,
      method: "get_attestations",
      args: { issuer: v2.issuer, receipt_id: v2.receipt_id },
    });
  });

  describe("after a wallet reloaded the page", () => {
    const pending = (text: string) =>
      sessionStorage.setItem(
        ATTEST_PENDING_KEY,
        JSON.stringify({ issuer: ISSUER, receipt_id: RID, account: "auditor.testnet", text, at: Date.now() }),
      );
    afterEach(() => window.history.replaceState(null, "", "/"));

    it("restores the receipt, verifies it again and shows the new attester once the chain has it", async () => {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8");
      const v2 = JSON.parse(text);
      const ok: VerifyOutcome = { receipt: null, direct: null, directV2: v2, hash: "HV2", ok: true, checks };
      sessionStorage.setItem(
        ATTEST_PENDING_KEY,
        JSON.stringify({
          issuer: v2.issuer,
          receipt_id: v2.receipt_id,
          account: "auditor.testnet",
          text,
          at: Date.now(),
        }),
      );
      window.history.replaceState(null, "", "/verify?transactionHashes=abc");
      const c = fakeChain([{ attester: COUNCIL, attested_at_ns: NS }]);
      let reads = 0;
      const lagging = async <T,>(contract: string, method: string, args?: object): Promise<T> => {
        // The chain catches up on the second read.
        if (method === "get_attestations" && ++reads === 2)
          c.list.push({ attester: "auditor.testnet", attested_at_ns: NS });
        return c.view<T>(contract, method, args);
      };
      const verify = vi.fn(async () => ok);
      render(
        <VerifyView
          app={app}
          verify={verify}
          attest={{ view: lagging, wallet: { port: c.port("auditor.testnet"), wallets }, retryMs: 1 }}
        />,
      );
      expect(await screen.findByText("You attested this receipt as auditor.testnet.")).toBeTruthy();
      expect(verify).toHaveBeenCalledWith(text);
      expect((screen.getByLabelText("Receipt JSON") as HTMLTextAreaElement).value).toBe(text);
      expect(screen.getByText("auditor.testnet · 2026-11-14 12:00:00 UTC")).toBeTruthy();
      expect(sessionStorage.getItem(ATTEST_PENDING_KEY)).toBeNull();
    });

    it("after a cancel (?errorCode), says nothing was attested once, then clears it", async () => {
      const { readFileSync } = await import("node:fs");
      const text = readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8");
      const v2 = JSON.parse(text);
      const ok: VerifyOutcome = { receipt: null, direct: null, directV2: v2, hash: "HV2", ok: true, checks };
      sessionStorage.setItem(
        ATTEST_PENDING_KEY,
        JSON.stringify({
          issuer: v2.issuer,
          receipt_id: v2.receipt_id,
          account: "auditor.testnet",
          text,
          at: Date.now(),
        }),
      );
      window.history.replaceState(null, "", "/verify?errorCode=userRejected");
      const c = fakeChain([]);
      const deps = { view: c.view, wallet: { port: c.port("auditor.testnet"), wallets }, retryMs: 1 };
      render(<VerifyView app={app} verify={async () => ok} attest={deps} />);
      expect(
        await screen.findByText("The wallet transaction was cancelled; nothing was attested."),
      ).toBeTruthy();
      expect(await screen.findByText("No one has attested this receipt yet.")).toBeTruthy();
      expect(sessionStorage.getItem(ATTEST_PENDING_KEY)).toBeNull();
      // Verifying the same receipt again (same URL) shows no stale cancel message.
      cleanup();
      render(<VerifyView app={app} verify={async () => ok} attest={deps} />);
      expect((screen.getByLabelText("Receipt JSON") as HTMLTextAreaElement).value).toBe("");
      paste(text);
      expect(await screen.findByText("No one has attested this receipt yet.")).toBeTruthy();
      expect(screen.queryByText("The wallet transaction was cancelled; nothing was attested.")).toBeNull();
    });

    it("drops the pending attest when the restored receipt no longer verifies", async () => {
      pending("{}");
      const bad: VerifyOutcome = {
        receipt: null,
        direct: null,
        hash: null,
        ok: false,
        checks: [{ id: "format", ok: false, detail: "Not a receipt" }],
      };
      render(<VerifyView app={app} verify={async () => bad} attest={{ view: fakeChain([]).view }} />);
      expect(await screen.findByText("✗ File: Not a receipt")).toBeTruthy();
      await waitFor(() => expect(sessionStorage.getItem(ATTEST_PENDING_KEY)).toBeNull());
    });

    it("ignores a pending attest older than 10 minutes", async () => {
      sessionStorage.setItem(
        ATTEST_PENDING_KEY,
        JSON.stringify({
          issuer: ISSUER,
          receipt_id: RID,
          account: "auditor.testnet",
          text: "{}",
          at: Date.now() - 11 * 60_000,
        }),
      );
      const verify = vi.fn(async () => {
        throw new Error("should not run");
      });
      render(<VerifyView app={app} verify={verify} />);
      await waitFor(() => expect(sessionStorage.getItem(ATTEST_PENDING_KEY)).toBeNull());
      expect(verify).not.toHaveBeenCalled();
      expect((screen.getByLabelText("Receipt JSON") as HTMLTextAreaElement).value).toBe("");
    });
  });

  it("shows no panel for an escrow batch receipt", async () => {
    const ok: VerifyOutcome = {
      receipt: JSON.parse(files["valid.json"]),
      direct: null,
      hash: manifest[0].receipt_hash,
      ok: true,
      checks,
    };
    const c = fakeChain([]);
    render(
      <VerifyView
        app={app}
        verify={async () => ok}
        attest={{ view: c.view, wallet: { port: c.port(null), wallets }, retryMs: 1 }}
      />,
    );
    paste(files["valid.json"]);
    expect(await screen.findByText("Verified against the chain")).toBeTruthy();
    expect(screen.queryByText("Attestations")).toBeNull();
    expect(screen.queryByRole("button", { name: "Attest that you checked this receipt" })).toBeNull();
    expect(c.calls).toEqual([]);
  });

  it("shows no panel when verification failed", async () => {
    const { readFileSync } = await import("node:fs");
    const v2 = JSON.parse(readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8"));
    const bad: VerifyOutcome = {
      receipt: null,
      direct: null,
      directV2: v2,
      hash: "HV2",
      ok: false,
      checks: [...checks.slice(0, 2), { id: "anchor", ok: false, detail: "Hash differs" }, checks[3]],
    };
    const c = fakeChain([]);
    render(
      <VerifyView
        app={app}
        verify={async () => bad}
        attest={{ view: c.view, wallet: { port: c.port(null), wallets }, retryMs: 1 }}
      />,
    );
    paste("{}");
    expect(await screen.findByText("✗ Anchored on-chain: Hash differs")).toBeTruthy();
    expect(screen.queryByText("Attestations")).toBeNull();
  });
});
