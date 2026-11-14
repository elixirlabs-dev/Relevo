import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import FundPage from "../app/fund/page.tsx";
import { FUND_MAINNET_WARNING, FundView } from "../components/FundView.tsx";
import { PayinPanel } from "../components/PayinPanel.tsx";
import { navLinks } from "../lib/deployment.ts";
import { ACTIVE_KEY, type ActiveDeposit } from "../lib/oneclick.ts";
import dryQuote from "./oneclick-fixtures/dry-quote.json" with { type: "json" };
import liveQuote from "./oneclick-fixtures/quote.json" with { type: "json" };
import statusPending from "./oneclick-fixtures/status-pending.json" with { type: "json" };
import statusRefunded from "./oneclick-fixtures/status-refunded.json" with { type: "json" };
import statusSuccess from "./oneclick-fixtures/status-success.json" with { type: "json" };

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const NOW = Date.parse("2026-11-14T20:30:00Z");
const DEPOSIT = "0x5c1e3a7f9b2d4e6081a3c5e7f9b1d3a5c7e9f1b3";
const ORIGIN_TX = "0x3f9a1c7e5b2d8f4a6c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function memStorage(init: Record<string, string> = {}) {
  const m = new Map(Object.entries(init));
  return {
    map: m,
    storage: {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage,
  };
}

/** A fake 1Click: quotes answer from the fixtures; each status poll takes the next answer in the list. */
function fakeOneClick(statuses: unknown[] = [statusPending]) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  let i = 0;
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/v0/quote")) return json(body.dry ? dryQuote : liveQuote);
    if (url.includes("/v0/status")) return json(statuses[Math.min(i++, statuses.length - 1)]);
    if (url.endsWith("/v0/deposit/submit")) return json(statusPending);
    return json({ message: "no" }, 404);
  });
  return {
    f: f as unknown as typeof fetch,
    calls,
    statusCalls: () => calls.filter((c) => c.url.includes("/v0/status")).length,
  };
}

function fill() {
  fireEvent.change(screen.getByLabelText("NEAR mainnet account that receives the USDC"), {
    target: { value: "payroll-treasury.near" },
  });
  fireEvent.change(screen.getByLabelText("Refund address on Base"), {
    target: { value: "0x0000000000000000000000000000000000000001" },
  });
}

it("shows the mainnet warning and starts with Base and 1.50 USDC", () => {
  render(<FundPage />);
  expect(screen.getByText(FUND_MAINNET_WARNING)).toBeTruthy();
  expect(FUND_MAINNET_WARNING).toBe(
    "Mainnet. Real money. This is separate from the testnet demo: USDC arrives in a NEAR mainnet account you choose, not in the testnet escrow.",
  );
  expect((screen.getByLabelText("Origin chain") as HTMLSelectElement).value).toBe("base");
  expect((screen.getByLabelText("Amount of USDC to send") as HTMLInputElement).value).toBe("1.50");
});

it("explains a bad input in words and does not call 1Click", async () => {
  const one = fakeOneClick();
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} />);
  fireEvent.change(screen.getByLabelText("NEAR mainnet account that receives the USDC"), {
    target: { value: "payroll.testnet" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Get a price" }));
  expect(await screen.findByText(/NEAR mainnet account/i, { selector: ".bad" })).toBeTruthy();
  expect(one.calls).toHaveLength(0);
});

it("gets a price with a dry quote: amount out, fees and time", async () => {
  const one = fakeOneClick();
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Get a price" }));
  const price = await screen.findByRole("group", { name: "Price" });
  expect(one.calls[0].body).toMatchObject({
    dry: true,
    amount: "1500000",
    recipient: "payroll-treasury.near",
  });
  expect(price.textContent).toContain("1.49606 USDC on NEAR");
  expect(price.textContent).toContain("0.00394 USDC");
  expect(price.textContent).toContain("1.481099 USDC");
  expect(price.textContent).toContain("about 35 s");
  expect(screen.queryByText(DEPOSIT)).toBeNull();
});

it("asks for the real-money acknowledgement before it gets a deposit address", async () => {
  const one = fakeOneClick();
  const copy = vi.fn(async () => {});
  const { storage, map } = memStorage();
  render(<FundView fetchImpl={one.f} storage={storage} now={() => NOW} copy={copy} pollMs={60_000} />);
  fill();
  const get = screen.getByRole("button", { name: "Get a deposit address" }) as HTMLButtonElement;
  expect(get.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText(/I understand this uses real money on mainnet/));
  expect(get.disabled).toBe(false);
  fireEvent.click(get);

  const deposit = await screen.findByRole("group", { name: "Deposit" });
  expect(one.calls[0].body).toMatchObject({ dry: false });
  expect(within(deposit).getByText(DEPOSIT)).toBeTruthy();
  expect(deposit.textContent).toContain("Send exactly 1.5 USDC on Base");
  expect(deposit.textContent).toContain("2026-11-14 21:22 UTC");
  expect(deposit.textContent).toMatch(/Send only USDC on Base, exactly this amount, before the deadline/);

  fireEvent.click(within(deposit).getByRole("button", { name: "Copy address" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(DEPOSIT));
  expect(await within(deposit).findByText("Copied.")).toBeTruthy();

  const saved = JSON.parse(map.get(ACTIVE_KEY) ?? "null") as ActiveDeposit;
  expect(saved).toMatchObject({
    depositAddress: DEPOSIT,
    amountIn: "1500000",
    deadline: "2026-11-14T21:22:10.507Z",
  });
});

it("polls the status until delivered, with words beside the marks, and links every tx", async () => {
  const one = fakeOneClick([statusPending, statusSuccess]);
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} pollMs={5} />);
  fill();
  fireEvent.click(screen.getByLabelText(/I understand this uses real money on mainnet/));
  fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));

  const steps = await screen.findByRole("list", { name: "Deposit progress" });
  await waitFor(() => expect(steps.textContent).toContain("✓ Delivered"));
  for (const li of within(steps).getAllByRole("listitem")) expect(li.textContent).toMatch(/Done/);
  expect(screen.getByText(/Delivered\. The USDC is in the NEAR account/)).toBeTruthy();

  expect(screen.getByRole("link", { name: /0x3f9a1c7e/ }).getAttribute("href")).toBe(
    `https://basescan.org/tx/${ORIGIN_TX}`,
  );
  expect(screen.getByRole("link", { name: /7Xh2pKcR/ }).getAttribute("href")).toBe(
    "https://nearblocks.io/txns/7Xh2pKcR9tLmV4nB8qD3sF6gJ1wY5zE2aU7oR4iT9kM3",
  );
  expect(screen.getByRole("link", { name: /C4mRk8Tz/ }).getAttribute("href")).toBe(
    "https://nearblocks.io/txns/C4mRk8Tz2wQ6nLp9vX3bH7sJ1dF5gY2aE8uK4oN6iV9t",
  );

  const after = one.statusCalls();
  await new Promise((r) => setTimeout(r, 40));
  expect(one.statusCalls()).toBe(after);
});

it("resumes polling an active deposit after a reload and shows a refund", async () => {
  const active: ActiveDeposit = {
    depositAddress: DEPOSIT,
    origin: "base",
    amountIn: "1500000",
    amountInFormatted: "1.5",
    amountOutFormatted: "1.49606",
    deadline: "2026-11-14T21:22:10.507Z",
    recipient: "payroll-treasury.near",
  };
  const { storage } = memStorage({ [ACTIVE_KEY]: JSON.stringify(active) });
  const one = fakeOneClick([statusRefunded]);
  render(<FundView fetchImpl={one.f} storage={storage} now={() => NOW} pollMs={5} />);
  expect(await screen.findByText(DEPOSIT)).toBeTruthy();
  const steps = await screen.findByRole("list", { name: "Deposit progress" });
  await waitFor(() => expect(steps.textContent).toContain("✗ Swapping and delivering — Stopped"));
  expect(screen.getByText(/Refunded\./)).toBeTruthy();
  expect(screen.getByText(/1\.4976 USDC/)).toBeTruthy();
});

it("stops checking ten minutes after the deadline", async () => {
  const active: ActiveDeposit = {
    depositAddress: DEPOSIT,
    origin: "arbitrum",
    amountIn: "1500000",
    amountInFormatted: "1.5",
    amountOutFormatted: "1.49606",
    deadline: "2026-11-14T21:22:10.507Z",
    recipient: "payroll-treasury.near",
  };
  const { storage } = memStorage({ [ACTIVE_KEY]: JSON.stringify(active) });
  const one = fakeOneClick();
  const late = Date.parse("2026-11-14T21:40:00Z");
  render(<FundView fetchImpl={one.f} storage={storage} now={() => late} pollMs={5} />);
  expect(await screen.findByText(/Stopped checking/)).toBeTruthy();
  await new Promise((r) => setTimeout(r, 30));
  expect(one.statusCalls()).toBeLessThanOrEqual(1);
});

it("sends an optional tx hash to 1Click to speed things up", async () => {
  const one = fakeOneClick();
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} pollMs={60_000} />);
  fill();
  fireEvent.click(screen.getByLabelText(/I understand this uses real money on mainnet/));
  fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
  await screen.findByRole("group", { name: "Deposit" });
  fireEvent.change(screen.getByLabelText("I sent it — here is my tx hash"), { target: { value: ORIGIN_TX } });
  fireEvent.click(screen.getByRole("button", { name: "Send tx hash" }));
  expect(await screen.findByText(/1Click has your tx hash/)).toBeTruthy();
  const sub = one.calls.find((c) => c.url.endsWith("/v0/deposit/submit"));
  expect(sub?.body).toEqual({ txHash: ORIGIN_TX, depositAddress: DEPOSIT });
});

it("puts Fund after Verify in the nav", () => {
  expect(navLinks(false).map((l) => l.href)).toEqual(["/firms", "/check", "/issue", "/verify", "/fund"]);
  expect(navLinks(false).at(-1)?.label).toBe("Fund");
});

it("links the testnet pay-in quote to the real mainnet deposit page", () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => json([])),
  );
  render(<PayinPanel totalLockedUnits="1000000" />);
  expect(screen.getByRole("link", { name: "Try a real mainnet deposit on /fund" }).getAttribute("href")).toBe(
    "/fund",
  );
});
