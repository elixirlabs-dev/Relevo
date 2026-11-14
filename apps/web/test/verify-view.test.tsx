import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildVectors } from "../../../scripts/lib/receipt-vectors.ts";
import { VerifyView } from "../components/VerifyView.tsx";
import type { VerifyOutcome } from "../lib/verify.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const { files, manifest } = buildVectors();
const receipt = JSON.parse(files["valid.json"]);
const app = { escrow: "escrow.example.testnet", network: "testnet" as const };
const passing: VerifyOutcome = {
  receipt,
  direct: null,
  hash: manifest[0].receipt_hash,
  ok: true,
  checks: [
    { id: "escrow", ok: true, detail: "For escrow.example.testnet on testnet, the escrow this app uses" },
    { id: "signature", ok: true, detail: "Signed by the batch's receipt key on-chain, ed25519:K" },
    { id: "anchor", ok: true, detail: "Hash H matches the hash anchored on-chain" },
    { id: "totals", ok: true, detail: "Totals add up from the 3 payout rows" },
  ],
};
const failing: VerifyOutcome = {
  ...passing,
  ok: false,
  checks: [
    passing.checks[0],
    {
      id: "signature",
      ok: false,
      detail: "The signature does not match the contents: the file was changed after signing",
    },
    ...passing.checks.slice(2),
  ],
};

function paste(text: string) {
  fireEvent.change(screen.getByLabelText("Receipt JSON"), { target: { value: text } });
  fireEvent.click(screen.getByRole("button", { name: "Verify" }));
}

describe("VerifyView", () => {
  it("lists each passing check and offers the CSV", async () => {
    const saved: Array<{ name: string; text: string }> = [];
    render(
      <VerifyView app={app} verify={async () => passing} save={(name, text) => saved.push({ name, text })} />,
    );
    paste(files["valid.json"]);
    expect(
      await screen.findByText("✓ Signature: Signed by the batch's receipt key on-chain, ed25519:K"),
    ).toBeTruthy();
    expect(screen.getByText("✓ Anchored on-chain: Hash H matches the hash anchored on-chain")).toBeTruthy();
    expect(screen.getByText("Verified against the chain")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(saved[0].name).toBe("elivo-batch-7.csv");
    expect(saved[0].text.startsWith("batch_id,network,escrow,receipt_hash,")).toBe(true);
    expect(saved[0].text).toContain(manifest[0].receipt_hash as string);
  });

  it("names the failing check and offers no CSV", async () => {
    render(<VerifyView app={app} verify={async () => failing} save={() => {}} />);
    paste(files["edited-amount.json"]);
    expect(
      await screen.findByText(
        "✗ Signature: The signature does not match the contents: the file was changed after signing",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Not verified: the CSV export needs every check to pass")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("verifies the testnet reference receipt on testnet only", async () => {
    const verify = vi.fn(async () => passing);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/receipts/testnet-batch-5.json"
          ? new Response(files["valid.json"])
          : new Response("", { status: 404 }),
      ),
    );
    const { unmount } = render(<VerifyView app={app} verify={verify} save={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Use the testnet reference receipt (batch 5)" }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith(files["valid.json"]));
    unmount();
    render(<VerifyView app={{ ...app, network: "sandbox" }} verify={verify} save={() => {}} />);
    expect(screen.queryByRole("button", { name: /testnet reference receipt/ })).toBeNull();
  });

  it("drops the verdict and the CSV as soon as the text changes", async () => {
    render(<VerifyView app={app} verify={async () => passing} save={() => {}} />);
    paste(files["valid.json"]);
    await screen.findByText("Verified against the chain");
    fireEvent.change(screen.getByLabelText("Receipt JSON"), {
      target: { value: files["edited-amount.json"] },
    });
    expect(screen.queryByText("Verified against the chain")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });

  it("ignores a check that finishes after the text was changed", async () => {
    let release: (o: VerifyOutcome) => void = () => {};
    const verify = vi.fn(() => new Promise<VerifyOutcome>((r) => (release = r)));
    render(<VerifyView app={app} verify={verify} save={() => {}} />);
    paste(files["valid.json"]);
    await waitFor(() => expect(verify).toHaveBeenCalledOnce());
    fireEvent.change(screen.getByLabelText("Receipt JSON"), {
      target: { value: files["edited-amount.json"] },
    });
    release(passing);
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("Verified against the chain")).toBeNull();
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
    expect((screen.getByRole("button", { name: "Verify" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows a printable delivery report once every check passes", async () => {
    const print = vi.fn();
    render(<VerifyView app={app} verify={async () => passing} save={() => {}} print={print} />);
    paste(files["valid.json"]);
    expect(await screen.findByRole("heading", { name: "Delivery report" })).toBeTruthy();
    expect(
      screen.getByText(
        "3 payouts: 2 delivered, 1 refunded to the funder. 0.40 USDC in late penalties paid to the funder.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Batch 7 · funded by dao.example.testnet · testnet")).toBeTruthy();
    // header + 3 payouts
    expect(screen.getAllByRole("row")).toHaveLength(4);
    expect(screen.getByText("Refunded: account closed")).toBeTruthy();
    expect(screen.getByText("Delivered after reroute (mx3.example.testnet missed its cut-off)")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Print report" }));
    expect(print).toHaveBeenCalledOnce();
  });

  it("shows no delivery report when a check fails", async () => {
    render(<VerifyView app={app} verify={async () => failing} save={() => {}} />);
    paste(files["edited-amount.json"]);
    await screen.findByText("Not verified: the CSV export needs every check to pass");
    expect(screen.queryByRole("heading", { name: "Delivery report" })).toBeNull();
  });

  it("carries the testnet label", () => {
    render(<VerifyView app={app} verify={async () => passing} save={() => {}} />);
    expect(
      screen.getByText(
        /Testnet prototype\. Payout firms and SPEI receipts are simulated\. Contract unaudited\./,
      ),
    ).toBeTruthy();
  });
});

describe("VerifyView with a direct receipt", async () => {
  const { buildDirectReceipt, parseResultsCsv, signDirectReceipt } = await import(
    "@elivo/shared/direct-issue"
  );
  const { keyFromSeed } = await import("@elivo/shared/keys");
  const csv = `name,account,amount,status,paid_at,reference
A,002010077777777771,100,paid,2026-11-14T10:00:00Z,SPEI-REF-1
B,012180001234567899,50,returned,,ACCOUNT_CLOSED
`;
  const direct = signDirectReceipt(
    buildDirectReceipt(parseResultsCsv(csv, { rail: "SPEI" }).rows, {
      network: "testnet",
      registry: "registry.example.testnet",
      issuer: "payroll.example.testnet",
      receipt_id: "nov",
      rail: "SPEI",
      currency: "MXN",
      salt: new Uint8Array(16),
    }),
    keyFromSeed(new Uint8Array(32).fill(3)),
  );
  const ok: VerifyOutcome = {
    receipt: null,
    direct,
    hash: "HD",
    ok: true,
    checks: [
      { id: "registry", ok: true, detail: "For registry.example.testnet on testnet" },
      { id: "signature", ok: true, detail: "Signed" },
      { id: "anchor", ok: true, detail: "Hash HD matches" },
      { id: "totals", ok: true, detail: "Totals add up from the 2 payout rows" },
    ],
  };

  it("shows the report and offers the direct CSV", async () => {
    const saved: Array<{ name: string; text: string }> = [];
    render(
      <VerifyView
        app={{ ...app, registry: "registry.example.testnet" }}
        verify={async () => ok}
        save={(name, text) => saved.push({ name, text })}
      />,
    );
    paste(JSON.stringify(direct));
    expect(await screen.findByText("✓ Registry: For registry.example.testnet on testnet")).toBeTruthy();
    expect(screen.getByText(/Receipt nov · issued by payroll.example.testnet · SPEI in MXN/)).toBeTruthy();
    expect(screen.getByText("Returned: account closed")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(saved[0].name).toBe("elivo-payroll.example.testnet-nov.csv");
    expect(saved[0].text.startsWith("issuer,receipt_id,")).toBe(true);
  });

  it("offers the sample payroll receipt only when the site has a registry", () => {
    render(<VerifyView app={app} verify={async () => ok} />);
    expect(
      screen.queryByRole("button", {
        name: "Use a payroll receipt made outside the escrow (post-quantum signed)",
      }),
    ).toBeNull();
    cleanup();
    render(<VerifyView app={{ ...app, registry: "registry.example.testnet" }} verify={async () => ok} />);
    expect(
      screen.getByRole("button", {
        name: "Use a payroll receipt made outside the escrow (post-quantum signed)",
      }),
    ).toBeTruthy();
  });
});
