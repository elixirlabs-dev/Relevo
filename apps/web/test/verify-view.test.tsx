import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildVectors } from "../../../scripts/lib/receipt-vectors.ts";
import { VerifyView } from "../components/VerifyView.tsx";
import type { VerifyOutcome } from "../lib/verify.ts";

// A verified registry receipt mounts the attestations panel, which reads /rpc: answer it offline.
beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response("", { status: 404 })),
  );
});
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

describe("VerifyView share links", async () => {
  const { encodeShare, decodeShare } = await import("../lib/share.ts");

  it("checks the receipt carried by a share link as soon as the page opens", async () => {
    const seen: string[] = [];
    const fragment = `#r=${await encodeShare(files["valid.json"])}`;
    render(
      <VerifyView
        app={app}
        fragment={fragment}
        verify={async (input) => {
          seen.push(input);
          return passing;
        }}
      />,
    );
    expect(await screen.findByText("Verified against the chain")).toBeTruthy();
    expect(seen).toEqual([files["valid.json"]]);
  });

  it("says so when a share link is broken", async () => {
    render(<VerifyView app={app} fragment="#r=AAAA" verify={async () => passing} />);
    expect(await screen.findByText(/This share link is broken/)).toBeTruthy();
  });

  it("copies a link that carries exactly the receipt that was verified", async () => {
    const copied: string[] = [];
    render(
      <VerifyView
        app={app}
        fragment=""
        verify={async () => passing}
        copy={async (s) => {
          copied.push(s);
        }}
      />,
    );
    paste(files["valid.json"]);
    fireEvent.click(await screen.findByRole("button", { name: "Copy share link" }));
    expect(await screen.findByText("Link copied.")).toBeTruthy();
    expect(copied[0]).toMatch(/\/verify#r=[\w-]+$/);
    expect(await decodeShare(copied[0].slice(copied[0].indexOf("#")))).toBe(files["valid.json"]);
  });
});

describe("VerifyView with a check report", async () => {
  const { buildCheckReport, signCheckReport } = await import("@elivo/shared/check-report");
  const { checkBatch, parsePlannedCsv } = await import("@elivo/shared/payout-check");
  const { rows } = parsePlannedCsv(
    "name,account,amount\nAna Secreta,002010077777777771,100\nBeto Secreto,990180002222333347,50\n",
  );
  const report = signCheckReport(
    buildCheckReport(checkBatch(rows, { rail: "SPEI" }), rows, {
      network: "testnet",
      registry: "registry.example.testnet",
      issuer: "payroll.example.testnet",
      report_id: "check-20261114-120000",
      salt: new Uint8Array(16),
    }),
    new Uint8Array(32).fill(3),
  );
  const ok: VerifyOutcome = {
    receipt: null,
    direct: null,
    check: report,
    hash: "HC",
    ok: true,
    checks: [
      { id: "registry", ok: true, detail: "For registry.example.testnet on testnet" },
      { id: "signature", ok: true, detail: "Signed" },
      { id: "anchor", ok: true, detail: "Hash HC matches" },
      { id: "totals", ok: true, detail: "The summary adds up from the 2 rows' findings" },
    ],
  };

  it("shows a check report with findings codes and no names", async () => {
    const { container } = render(
      <VerifyView app={{ ...app, registry: "registry.example.testnet" }} verify={async () => ok} />,
    );
    paste(JSON.stringify(report));
    expect(await screen.findByRole("heading", { name: "Check report" })).toBeTruthy();
    expect(
      screen.getByText(/check-20261114-120000 · checked by payroll.example.testnet · SPEI/),
    ).toBeTruthy();
    expect(screen.getByText("Warning · unknown_bank")).toBeTruthy();
    expect(
      [...container.querySelectorAll("table tbody tr")].map((r) => r.querySelector("td")?.textContent),
    ).toEqual(["1", "2"]);
    expect(container.querySelector("table")?.textContent).not.toMatch(/Ana|Beto/);
    expect(screen.queryByRole("button", { name: "Download CSV" })).toBeNull();
  });
});

describe("VerifyView with a v2 receipt (per-payee proofs)", async () => {
  const { readFileSync } = await import("node:fs");
  const text = readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8");
  const v2 = JSON.parse(text);
  const rapp = { ...app, registry: "registry.example.testnet" };
  const ok: VerifyOutcome = {
    receipt: null,
    direct: null,
    directV2: v2,
    hash: "HV2",
    ok: true,
    checks: [
      { id: "registry", ok: true, detail: "For registry.example.testnet on testnet" },
      { id: "signature", ok: true, detail: "Signed" },
      { id: "anchor", ok: true, detail: "Hash HV2 matches" },
      {
        id: "totals",
        ok: true,
        detail: "The payouts root, payout count and totals match the 5 payout rows",
      },
      {
        id: "checked_before",
        ok: true,
        detail:
          "The issuer anchored check check-20261114-110000 (hash CheckHash1) at 2026-11-14 11:00:00 UTC, before this receipt (anchored 2026-11-14 12:00:00 UTC)",
      },
    ],
  };

  it("offers the v2 sample on a site with a registry, and checks that file", async () => {
    const verify = vi.fn(async () => ok);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url === "/receipts/testnet-direct-payroll-v2.json"
          ? new Response(text)
          : new Response("", { status: 404 }),
      ),
    );
    render(<VerifyView app={rapp} verify={verify} save={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Use the payroll receipt v2 (per-payee proofs)" }));
    await waitFor(() => expect(verify).toHaveBeenCalledWith(text));
    cleanup();
    render(<VerifyView app={app} verify={verify} />);
    expect(
      screen.queryByRole("button", { name: "Use the payroll receipt v2 (per-payee proofs)" }),
    ).toBeNull();
  });

  it("shows the checked-before line, the report with 1-based positions, and the CSV", async () => {
    const saved: Array<{ name: string; text: string }> = [];
    render(
      <VerifyView app={rapp} verify={async () => ok} save={(name, t) => saved.push({ name, text: t })} />,
    );
    paste(text);
    expect(
      await screen.findByText(
        "✓ Checked before payment: The issuer anchored check check-20261114-110000 (hash CheckHash1) at 2026-11-14 11:00:00 UTC, before this receipt (anchored 2026-11-14 12:00:00 UTC)",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Delivery report" })).toBeTruthy();
    expect(
      screen.getByText(/Receipt payroll-2026-11-v2 · issued by payroll.pg-1794403941.testnet/),
    ).toBeTruthy();
    const cells = screen
      .getAllByRole("row")
      .slice(1)
      .map((r) => r.querySelector("td")?.textContent);
    expect(cells).toEqual(["1", "2", "3", "4", "5"]);
    expect(screen.getByText(/Merkle root/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Download CSV" }));
    expect(saved[0].name).toBe("elivo-payroll.pg-1794403941.testnet-payroll-2026-11-v2.csv");
  });

  it("names a failed checked-before line and shows no report", async () => {
    const bad: VerifyOutcome = {
      ...ok,
      ok: false,
      checks: [
        ...ok.checks.slice(0, 4),
        {
          id: "checked_before",
          ok: false,
          detail:
            "The check was anchored at 2026-11-14 13:00:00 UTC, not before the receipt (2026-11-14 12:00:00 UTC): it was not made before payment",
        },
      ],
    };
    render(<VerifyView app={rapp} verify={async () => bad} save={() => {}} />);
    paste(text);
    expect(await screen.findByText(/✗ Checked before payment: The check was anchored at/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Delivery report" })).toBeNull();
  });
});

describe("DirectReport's check-before sentence", async () => {
  const { readFileSync } = await import("node:fs");
  const { DirectReport } = await import("../components/DirectReport.tsx");
  const v2 = JSON.parse(readFileSync("apps/web/public/receipts/testnet-direct-payroll-v2.json", "utf8"));
  const linked = { ...v2, check_ref: { report_id: "check-20261114-110000", report_hash: "CheckHash1" } };

  it("says the batch was checked before payment only when that check passed", () => {
    render(<DirectReport receipt={linked} hash="HV2" checkedBefore print={() => {}} />);
    expect(
      screen.getByText(/The batch was checked before payment: check report check-20261114-110000\./),
    ).toBeTruthy();
  });

  it("names the linked check in neutral words when that check failed or didn't run", () => {
    for (const checkedBefore of [false, undefined]) {
      render(<DirectReport receipt={linked} hash="HV2" checkedBefore={checkedBefore} print={() => {}} />);
      expect(document.body.textContent).not.toMatch(/checked before payment/i);
      expect(
        screen.getByText(
          /This receipt names check report check-20261114-110000, but it was not shown to be anchored before the receipt\./,
        ),
      ).toBeTruthy();
      cleanup();
    }
  });

  it("says no check is linked when there is none", () => {
    render(<DirectReport receipt={v2} hash="HV2" checkedBefore={false} print={() => {}} />);
    expect(screen.getByText(/No check made before payment is linked\./)).toBeTruthy();
  });
});
