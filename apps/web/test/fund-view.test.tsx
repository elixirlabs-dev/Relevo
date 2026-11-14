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
/** Past the deadline (21:22:10 UTC), but inside the ten minutes of polling after it. */
const AFTER_DEADLINE = Date.parse("2026-11-14T21:25:00Z");
const DEPOSIT = "0x5c1e3a7f9b2d4e6081a3c5e7f9b1d3a5c7e9f1b3";
const REFUND = "0x0000000000000000000000000000000000000001";
const ORIGIN_TX = "0x3f9a1c7e5b2d8f4a6c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a";
const DEADLINE_PASSED =
  "Deadline passed. Do not send to this address; funds sent now may be lost. Start over for a new address.";
const ACTIVE: ActiveDeposit = {
  depositAddress: DEPOSIT,
  origin: "base",
  amountIn: "1500000",
  amountOutFormatted: "1.49606",
  deadline: "2026-11-14T21:22:10.507Z",
  recipient: "payroll-treasury.near",
  refundTo: REFUND,
};

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

const saved = (a: ActiveDeposit = ACTIVE) => memStorage({ [ACTIVE_KEY]: JSON.stringify(a) }).storage;

/**
 * A fake 1Click: quotes answer from the fixtures (or `live` for the real quote); each status poll takes
 * the next answer in the list. A Response is returned as is; "hang" never answers.
 */
function fakeOneClick(statuses: unknown[] = [statusPending], live: unknown = liveQuote) {
  const calls: Array<{ url: string; body?: unknown }> = [];
  let i = 0;
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, body });
    if (url.endsWith("/v0/quote")) return json(body.dry ? dryQuote : live);
    if (url.includes("/v0/status")) {
      const next = statuses[Math.min(i++, statuses.length - 1)];
      if (next === "hang") return new Promise<Response>(() => {});
      return next instanceof Response ? next.clone() : json(next);
    }
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
  fireEvent.change(screen.getByLabelText("Refund address on Base"), { target: { value: REFUND } });
}

const acknowledge = () =>
  fireEvent.click(screen.getByLabelText(/I understand this uses real money on mainnet/));

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

it.each([
  [
    "the amount",
    () => fireEvent.change(screen.getByLabelText("Amount of USDC to send"), { target: { value: "2" } }),
  ],
  [
    "the chain",
    () => fireEvent.change(screen.getByLabelText("Origin chain"), { target: { value: "arbitrum" } }),
  ],
  [
    "the recipient",
    () =>
      fireEvent.change(screen.getByLabelText("NEAR mainnet account that receives the USDC"), {
        target: { value: "other.near" },
      }),
  ],
])("drops the shown price when %s changes", async (_what, change) => {
  const one = fakeOneClick();
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} />);
  fill();
  fireEvent.click(screen.getByRole("button", { name: "Get a price" }));
  await screen.findByRole("group", { name: "Price" });
  change();
  expect(screen.queryByRole("group", { name: "Price" })).toBeNull();
});

it("asks for the real-money acknowledgement before it gets a deposit address", async () => {
  const one = fakeOneClick();
  const copy = vi.fn(async () => {});
  const { storage, map } = memStorage();
  render(<FundView fetchImpl={one.f} storage={storage} now={() => NOW} copy={copy} pollMs={60_000} />);
  fill();
  const get = screen.getByRole("button", { name: "Get a deposit address" }) as HTMLButtonElement;
  expect(get.disabled).toBe(true);
  acknowledge();
  expect(get.disabled).toBe(false);
  fireEvent.click(get);

  const deposit = await screen.findByRole("group", { name: "Deposit" });
  expect(one.calls[0].body).toMatchObject({ dry: false });
  expect(within(deposit).getByText(DEPOSIT)).toBeTruthy();
  expect(deposit.textContent).toContain("Send exactly 1.50 USDC on Base");
  expect(deposit.textContent).toContain("2026-11-14 21:22 UTC");
  expect(deposit.textContent).toContain(`Refunds go to ${REFUND} on Base`);
  expect(deposit.textContent).toMatch(/Send only USDC on Base, exactly this amount, before the deadline/);
  expect(deposit.textContent).toMatch(/after the deadline may be lost/);
  expect(deposit.textContent).not.toMatch(/returns what it can/);

  fireEvent.click(within(deposit).getByRole("button", { name: "Copy address" }));
  await waitFor(() => expect(copy).toHaveBeenCalledWith(DEPOSIT));
  expect(await within(deposit).findByText("Copied.")).toBeTruthy();

  const kept = JSON.parse(map.get(ACTIVE_KEY) ?? "null") as ActiveDeposit;
  expect(kept).toMatchObject({
    depositAddress: DEPOSIT,
    amountIn: "1500000",
    deadline: "2026-11-14T21:22:10.507Z",
    refundTo: REFUND,
  });
});

it("refuses a real quote whose amount differs from the one asked for, and shows no address", async () => {
  const one = fakeOneClick([statusPending], {
    ...liveQuote,
    quote: { ...liveQuote.quote, amountIn: "15000000", amountInFormatted: "15" },
  });
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} pollMs={60_000} />);
  fill();
  acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
  expect(await screen.findByText(/amount/i, { selector: ".bad" })).toBeTruthy();
  expect(screen.queryByText(DEPOSIT)).toBeNull();
  expect(screen.queryByRole("group", { name: "Deposit" })).toBeNull();
});

it("polls the status until delivered, with words beside the marks, and links every tx", async () => {
  const one = fakeOneClick([statusPending, statusSuccess]);
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} pollMs={5} />);
  fill();
  acknowledge();
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

it("treats a 'not found' status as waiting for the deposit, not an error", async () => {
  const one = fakeOneClick([json({ message: `Deposit address ${DEPOSIT} not found` }, 404)]);
  render(<FundView fetchImpl={one.f} storage={saved()} now={() => NOW} pollMs={60_000} />);
  await waitFor(() => expect(one.statusCalls()).toBe(1));
  expect(await screen.findByText(/Waiting for your deposit\./)).toBeTruthy();
  expect(screen.queryByText(/Could not check the status/)).toBeNull();
});

it("resumes polling an active deposit after a reload, asks with its memo, and shows a refund", async () => {
  const one = fakeOneClick([statusRefunded]);
  render(
    <FundView
      fetchImpl={one.f}
      storage={saved({ ...ACTIVE, depositMemo: "memo-7" })}
      now={() => NOW}
      pollMs={5}
    />,
  );
  expect(await screen.findByText(DEPOSIT)).toBeTruthy();
  const steps = await screen.findByRole("list", { name: "Deposit progress" });
  await waitFor(() => expect(steps.textContent).toContain("✗ Swapping and delivering — Stopped"));
  expect(screen.getByText(/Refunded\./)).toBeTruthy();
  expect(screen.getByText(/1\.4976 USDC/)).toBeTruthy();
  expect(one.calls.find((c) => c.url.includes("/v0/status"))?.url).toContain(
    `depositAddress=${DEPOSIT}&depositMemo=memo-7`,
  );
});

it("after the deadline, with no deposit seen, hides the address and says not to send", async () => {
  const one = fakeOneClick([statusPending]);
  render(<FundView fetchImpl={one.f} storage={saved()} now={() => AFTER_DEADLINE} pollMs={60_000} />);
  expect(await screen.findByText(DEADLINE_PASSED)).toBeTruthy();
  await waitFor(() => expect(one.statusCalls()).toBe(1));
  expect(screen.queryByText(DEPOSIT)).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  expect(screen.queryByText(/Send exactly/)).toBeNull();
  expect(screen.getByRole("button", { name: "Start over" })).toBeTruthy();
});

it("after the deadline, before any status has come back, still hides the address", async () => {
  const one = fakeOneClick(["hang"]);
  render(<FundView fetchImpl={one.f} storage={saved()} now={() => AFTER_DEADLINE} pollMs={60_000} />);
  expect(await screen.findByText(DEADLINE_PASSED)).toBeTruthy();
  expect(screen.queryByText(DEPOSIT)).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  expect(screen.queryByText(/Send exactly/)).toBeNull();
});

it("after the deadline, with a deposit already seen, keeps following it but asks for nothing more", async () => {
  const one = fakeOneClick([{ ...statusPending, status: "PROCESSING" }]);
  render(<FundView fetchImpl={one.f} storage={saved()} now={() => AFTER_DEADLINE} pollMs={60_000} />);
  expect(await screen.findByText(/Deposit received/)).toBeTruthy();
  expect(screen.queryByText(DEADLINE_PASSED)).toBeNull();
  expect(screen.queryByRole("button", { name: "Copy address" })).toBeNull();
  expect(screen.queryByText(/Send exactly/)).toBeNull();
});

it("stops checking ten minutes after the deadline", async () => {
  const one = fakeOneClick();
  const late = Date.parse("2026-11-14T21:40:00Z");
  render(
    <FundView
      fetchImpl={one.f}
      storage={saved({ ...ACTIVE, origin: "arbitrum" })}
      now={() => late}
      pollMs={5}
    />,
  );
  expect(await screen.findByText(/Stopped checking/)).toBeTruthy();
  expect(screen.getByText(DEADLINE_PASSED)).toBeTruthy();
  expect(screen.queryByText(DEPOSIT)).toBeNull();
  await new Promise((r) => setTimeout(r, 30));
  expect(one.statusCalls()).toBeLessThanOrEqual(1);
});

it("start over clears the deposit and the real-money acknowledgement", async () => {
  const { storage, map } = memStorage();
  const one = fakeOneClick();
  render(<FundView fetchImpl={one.f} storage={storage} now={() => NOW} pollMs={60_000} />);
  fill();
  acknowledge();
  fireEvent.click(screen.getByRole("button", { name: "Get a deposit address" }));
  await screen.findByRole("group", { name: "Deposit" });
  fireEvent.click(screen.getByRole("button", { name: "Start over" }));
  expect(map.has(ACTIVE_KEY)).toBe(false);
  expect(
    (screen.getByLabelText(/I understand this uses real money on mainnet/) as HTMLInputElement).checked,
  ).toBe(false);
  expect((screen.getByRole("button", { name: "Get a deposit address" }) as HTMLButtonElement).disabled).toBe(
    true,
  );
});

it("sends an optional tx hash to 1Click to speed things up", async () => {
  const one = fakeOneClick();
  render(<FundView fetchImpl={one.f} storage={null} now={() => NOW} pollMs={60_000} />);
  fill();
  acknowledge();
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
