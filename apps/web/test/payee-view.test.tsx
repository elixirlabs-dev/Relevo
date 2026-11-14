import { readFileSync } from "node:fs";
import { directV2HashB58, type PayeeProof } from "@elivo/shared/direct-receipt-v2";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PayeeView } from "../components/PayeeView.tsx";
import { formatWhen, LANG_KEY } from "../lib/i18n-payee.ts";
import { payeeLink } from "../lib/payee.ts";

const SAMPLE = readFileSync("apps/web/public/receipts/testnet-payee-proof-v2.json", "utf8");
const PROOF: PayeeProof = JSON.parse(SAMPLE);
const H = PROOF.header;
const AT_NS = "1794685161000000000";
const AT = new Date(Number(BigInt(AT_NS) / 1_000_000n)).toISOString();
const CLABE = "646180005555555554";
const app = { network: "testnet" as const, registry: H.registry };

const view = async <T,>(_c: string, method: string): Promise<T> => {
  if (method !== "get_receipt") throw new Error(method);
  return {
    issuer: H.issuer,
    receipt_id: H.receipt_id,
    receipt_hash: directV2HashB58(H),
    key_version: 1,
    receipt_pk: H.signatures.find((s) => s.alg === "ed25519")?.public_key,
    mldsa65_pk: H.signatures.find((s) => s.alg === "ml-dsa-65")?.public_key,
    anchored_at_ns: AT_NS,
  } as T;
};

const fragmentOf = async (p: PayeeProof) => {
  const link = await payeeLink("https://example.org", p);
  return link.slice(link.indexOf("#"));
};

const fetchSpy = vi.fn(async (url: string) =>
  url === "/receipts/testnet-payee-proof-v2.json"
    ? new Response(SAMPLE)
    : new Response("not found", { status: 404 }),
);

beforeEach(() => {
  localStorage.clear();
  fetchSpy.mockClear();
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("PayeeView", () => {
  it("shows the payout and a ✓ on every check for a genuine link", async () => {
    render(<PayeeView app={app} view={view} fragment={await fragmentOf(PROOF)} />);
    expect(await screen.findByText(`✓ Signed by ${H.issuer}'s key on NEAR`)).toBeTruthy();
    expect(screen.getByText(`✓ Anchored on NEAR at ${formatWhen(AT, "en")}`)).toBeTruthy();
    expect(screen.getByText("✓ Your payout is one of 5 in this receipt")).toBeTruthy();
    expect(screen.getByText("✓ Verified on NEAR")).toBeTruthy();
    expect(screen.getByText("18,500.00 MXN")).toBeTruthy();
    expect(screen.getByText("✓ Paid")).toBeTruthy();
    expect(screen.getByText("payout 5 of 5")).toBeTruthy();
    expect(screen.getByText("SIM-SPEI-20261114-0005")).toBeTruthy();
    expect(screen.getByText("SPEI tracking key (simulated)")).toBeTruthy();
    expect(screen.getByText(H.issuer)).toBeTruthy();
    expect(screen.getByText(H.receipt_id)).toBeTruthy();
    expect(
      screen.getByText("Treat this link like a payslip: anyone who has it can see this payout."),
    ).toBeTruthy();
    expect(screen.getByRole("heading", { level: 1, name: "Your payout" })).toBeTruthy();
  });

  it("shows ✗ on the Merkle line when the amount in the link was changed", async () => {
    const tampered = { ...PROOF, payout: { ...PROOF.payout, amount: "185000.00" } };
    render(<PayeeView app={app} view={view} fragment={await fragmentOf(tampered)} />);
    expect(
      await screen.findByText("✗ Your payout doesn't match this receipt: the link was changed"),
    ).toBeTruthy();
    expect(screen.getByText(`✓ Signed by ${H.issuer}'s key on NEAR`)).toBeTruthy();
    expect(screen.getByText("✗ Not verified")).toBeTruthy();
  });

  it("confirms the payee's own CLABE locally, and rejects another, without sending it anywhere", async () => {
    const seen: unknown[] = [];
    const v = <T,>(c: string, method: string, args?: object): Promise<T> => {
      seen.push(args);
      return view<T>(c, method);
    };
    render(<PayeeView app={app} view={v} fragment={await fragmentOf(PROOF)} />);
    await screen.findByText("✓ Verified on NEAR");
    const calls = seen.length;
    const input = screen.getByLabelText("Your CLABE (18 digits)");
    fireEvent.change(input, { target: { value: "6461 8000 5555 5555 54" } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    expect(screen.getByText("✓ This is your account: the payout went to this CLABE")).toBeTruthy();
    fireEvent.change(input, { target: { value: "002010077777777771" } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    expect(
      screen.getByText("✗ Not this account: this payout went to an account ending in 5554"),
    ).toBeTruthy();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen.length).toBe(calls);
    expect(JSON.stringify(seen)).not.toContain(CLABE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CLABE);
    expect(JSON.stringify({ ...localStorage })).not.toContain("002010077777777771");
  });

  it("switches to Spanish with the ES toggle, and remembers it", async () => {
    render(<PayeeView app={app} view={view} fragment={await fragmentOf(PROOF)} />);
    await screen.findByText("✓ Verified on NEAR");
    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    expect(screen.getByRole("heading", { level: 1, name: "Tu pago" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Confirma que es tu cuenta" })).toBeTruthy();
    expect(screen.getByText("✓ Verificado en NEAR")).toBeTruthy();
    expect(screen.getByText("✓ Pagado")).toBeTruthy();
    expect(screen.getByText("pago 5 de 5")).toBeTruthy();
    expect(screen.getByText(`✓ Registrado en NEAR el ${formatWhen(AT, "es")}`)).toBeTruthy();
    expect(localStorage.getItem(LANG_KEY)).toBe("es");
    fireEvent.click(screen.getByRole("button", { name: "EN" }));
    expect(screen.getByRole("heading", { level: 1, name: "Your payout" })).toBeTruthy();
    expect(localStorage.getItem(LANG_KEY)).toBe("en");
  });

  it("starts in Spanish when the browser language is Spanish", async () => {
    vi.spyOn(navigator, "language", "get").mockReturnValue("es-MX");
    render(<PayeeView app={app} view={view} fragment="" />);
    expect(await screen.findByRole("heading", { level: 1, name: "Tu pago" })).toBeTruthy();
  });

  it("explains itself without a link, and opens the sample link", async () => {
    render(<PayeeView app={app} view={view} fragment="" />);
    fireEvent.click(await screen.findByRole("button", { name: "See a sample payee link" }));
    expect(await screen.findByText("✓ Your payout is one of 5 in this receipt")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith("/receipts/testnet-payee-proof-v2.json");
    expect(screen.getByText(/invented payroll data/)).toBeTruthy();
  });

  it("says a broken link is broken, and still offers the sample", async () => {
    render(<PayeeView app={app} view={view} fragment="#p=AAAA" />);
    expect(await screen.findByText(/This link is broken or incomplete/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "See a sample payee link" })).toBeTruthy();
  });
});
