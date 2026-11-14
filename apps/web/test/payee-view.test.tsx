import { readFileSync } from "node:fs";
import { parseResultsCsv } from "@elivo/shared/direct-build";
import {
  buildDirectReceiptV2,
  directV2HashB58,
  type PayeeProof,
  payeeProof,
  signDirectReceiptV2,
  verifyPayeeProofStructure,
} from "@elivo/shared/direct-receipt-v2";
import { merkleLeaf, merkleNode } from "@elivo/shared/merkle";
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

/** A registry that has anchored `h` with the keys it was signed with. */
const viewOf =
  (h: PayeeProof["header"]) =>
  async <T,>(_c: string, method: string): Promise<T> => {
    if (method !== "get_receipt") throw new Error(method);
    return {
      issuer: h.issuer,
      receipt_id: h.receipt_id,
      receipt_hash: directV2HashB58(h),
      key_version: 1,
      receipt_pk: h.signatures.find((s) => s.alg === "ed25519")?.public_key,
      mldsa65_pk: h.signatures.find((s) => s.alg === "ml-dsa-65")?.public_key ?? null,
      anchored_at_ns: AT_NS,
    } as T;
  };
const view = viewOf(H);

/** A signed and anchored SEPA receipt (another rail than SPEI), and the proof for its second payout. */
function sepaProof(): PayeeProof {
  const csv =
    "name,account,amount,status,paid_at,reference\nA,DE89370400440532013000,10.00,paid,2026-11-14T10:00:00Z,R1\nB,GB29NWBK60161331926819,20.00,paid,2026-11-14T10:00:00Z,SEPA-0002\n";
  const salt = new Uint8Array(16).fill(3);
  const r = signDirectReceiptV2(
    buildDirectReceiptV2(parseResultsCsv(csv, { rail: "SEPA" }).rows, {
      network: "testnet",
      registry: H.registry,
      issuer: H.issuer,
      receipt_id: "sepa-nov",
      rail: "SEPA",
      currency: "EUR",
      salt,
    }),
    new Uint8Array(32).fill(9),
  );
  return payeeProof(r, 1, salt);
}

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
    expect(screen.getByText(`✓ Anchored on NEAR on ${formatWhen(AT, "en")}`)).toBeTruthy();
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

  it("shows no ✓ anywhere for a forged header whose payouts_root matches its own payout", async () => {
    // A forger raises the amount and recomputes the root, so the Merkle path is self-consistent; the
    // header no longer matches the issuer's signature or the anchored hash.
    const payout = { ...PROOF.payout, amount: "185000.00" };
    const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    const bytes = (h: string) => Uint8Array.from(h.match(/../g) ?? [], (x) => Number.parseInt(x, 16));
    const root = hex(merkleNode(bytes(PROOF.proof.siblings[0].hash), merkleLeaf(payout)));
    const forged: PayeeProof = { ...PROOF, header: { ...H, payouts_root: root }, payout };
    expect(verifyPayeeProofStructure(forged)).toEqual([]);

    render(<PayeeView app={app} view={view} fragment={await fragmentOf(forged)} />);
    expect(await screen.findByText("✗ Not verified")).toBeTruthy();
    expect(screen.getByText("— Not checked: the receipt itself isn't verified")).toBeTruthy();
    expect(screen.getByText(`✗ Not signed by ${H.issuer}'s key on NEAR`)).toBeTruthy();
    expect(screen.getByText("Paid")).toBeTruthy();
    expect(document.body.textContent).not.toContain("✓");
    expect(document.querySelector(".ok")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    expect(screen.getByText("— No se revisó: el recibo en sí no está verificado")).toBeTruthy();
    expect(screen.getByText("Pagado")).toBeTruthy();
    expect(document.body.textContent).not.toContain("✓");
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

  it("never shows a green ✓ match for a link whose receipt is not verified on NEAR (EN and ES)", async () => {
    // A forged link: the right payee salt and payee_ref, under a header the issuer never signed.
    const forged: PayeeProof = { ...PROOF, header: { ...H, currency: "USD" } };
    render(<PayeeView app={app} view={view} fragment={await fragmentOf(forged)} />);
    expect(await screen.findByText("✗ Not verified")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your CLABE (18 digits)"), { target: { value: CLABE } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    const line = screen.getByText("This link names your account, but the receipt is not verified on NEAR");
    expect(line.className).not.toContain("ok");
    expect(document.querySelector(".ok")).toBeNull();
    expect(document.body.textContent).not.toContain("This is your account");
    expect(document.body.textContent).not.toContain("✓");

    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    fireEvent.change(screen.getByLabelText("Tu CLABE (18 dígitos)"), { target: { value: CLABE } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar mi cuenta" }));
    expect(
      screen.getByText("Este enlace menciona tu cuenta, pero el recibo no está verificado en NEAR"),
    ).toBeTruthy();
    expect(document.querySelector(".ok")).toBeNull();
    expect(document.body.textContent).not.toContain("✓");
  });

  it("on another rail, asks for an account number and matches it in any letter case (EN and ES)", async () => {
    const p = sepaProof();
    render(<PayeeView app={app} view={viewOf(p.header)} fragment={await fragmentOf(p)} />);
    expect(await screen.findByText("✓ Verified on NEAR")).toBeTruthy();
    expect(screen.getByText("Payment reference")).toBeTruthy();
    expect(screen.getByText("SEPA-0002")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/CLABE|SPEI/);
    const input = screen.getByLabelText("Your account number (4 to 34 letters or digits)");
    fireEvent.change(input, { target: { value: "gb29 nwbk 6016 1331 9268 19" } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    expect(screen.getByText("✓ This is your account: the payout went to this account number")).toBeTruthy();
    fireEvent.change(input, { target: { value: "DE89370400440532013000" } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    expect(
      screen.getByText("✗ Not this account: this payout went to an account ending in 6819"),
    ).toBeTruthy();
    fireEvent.change(input, { target: { value: "AB1" } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    expect(screen.getByText("✗ An account number has 4 to 34 letters or digits.")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "ES" }));
    expect(screen.getByText("Referencia del pago")).toBeTruthy();
    const es = screen.getByLabelText("Tu número de cuenta (de 4 a 34 letras o dígitos)");
    fireEvent.change(es, { target: { value: "GB29NWBK60161331926819" } });
    fireEvent.click(screen.getByRole("button", { name: "Revisar mi cuenta" }));
    expect(screen.getByText("✓ Es tu cuenta: el pago se hizo a este número de cuenta")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/CLABE|SPEI/);
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
    expect(screen.getByRole("heading", { name: "Verificaciones" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Revisiones");
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
    // The sample says which (invented) account to type to try the confirm.
    expect(screen.getByText(/646180005555555554/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Your CLABE (18 digits)"), { target: { value: CLABE } });
    fireEvent.click(screen.getByRole("button", { name: "Check my account" }));
    expect(screen.getByText("✓ This is your account: the payout went to this CLABE")).toBeTruthy();
  });

  it("says a broken link is broken, and still offers the sample", async () => {
    render(<PayeeView app={app} view={view} fragment="#p=AAAA" />);
    expect(await screen.findByText(/This link is broken or incomplete/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "See a sample payee link" })).toBeTruthy();
  });
});
