import { describe, expect, it, vi } from "vitest";
import {
  ACTIVE_KEY,
  type ActiveDeposit,
  clearActive,
  describeStatus,
  FUND_ORIGINS,
  type FundingRequest,
  type FundingStatus,
  fundingStatus,
  fundingSteps,
  isTerminal,
  loadActive,
  nearTxUrl,
  originTxUrl,
  pollingEndsAt,
  quoteBody,
  quoteFunding,
  STATUS_TEXT,
  saveActive,
  submitDeposit,
  toUsdcUnits,
  txHashes,
  USDC_NEAR,
  validateFunding,
} from "../lib/oneclick.ts";
import dryQuote from "./oneclick-fixtures/dry-quote.json" with { type: "json" };
import liveQuote from "./oneclick-fixtures/quote.json" with { type: "json" };
import statusPending from "./oneclick-fixtures/status-pending.json" with { type: "json" };
import statusSuccess from "./oneclick-fixtures/status-success.json" with { type: "json" };

const NOW = Date.parse("2026-11-14T20:22:10.507Z");
const good: FundingRequest = {
  origin: "base",
  amountUsdc: "1.50",
  recipient: "payroll-treasury.near",
  refundTo: "0x0000000000000000000000000000000000000001",
  dry: true,
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("input validation", () => {
  it("accepts a named .near account and a 64-hex implicit account", () => {
    expect(validateFunding(good)).toBeNull();
    expect(validateFunding({ ...good, recipient: "a".repeat(64) })).toBeNull();
    expect(validateFunding({ ...good, recipient: "team.payroll.near" })).toBeNull();
  });

  it.each([
    ["recipient", { recipient: "payroll.testnet" }],
    ["recipient", { recipient: "Payroll.near" }],
    ["recipient", { recipient: "a".repeat(63) }],
    ["recipient", { recipient: "" }],
    ["refundTo", { refundTo: "0x123" }],
    ["refundTo", { refundTo: "payroll.near" }],
    ["amountUsdc", { amountUsdc: "0.99" }],
    ["amountUsdc", { amountUsdc: "100.01" }],
    ["amountUsdc", { amountUsdc: "1.505" }],
    ["amountUsdc", { amountUsdc: "abc" }],
    ["amountUsdc", { amountUsdc: "" }],
    ["origin", { origin: "solana" }],
  ])("rejects a bad %s", (field, patch) => {
    const err = validateFunding({ ...good, ...(patch as Partial<FundingRequest>) });
    expect(err?.field).toBe(field);
    expect(err?.message).toMatch(/\w/);
  });

  it("accepts the limits 1 and 100 USDC", () => {
    expect(validateFunding({ ...good, amountUsdc: "1" })).toBeNull();
    expect(validateFunding({ ...good, amountUsdc: "100.00" })).toBeNull();
  });

  it("converts USDC to 6-decimal units without floating point", () => {
    expect(toUsdcUnits("1.50")).toBe("1500000");
    expect(toUsdcUnits("1")).toBe("1000000");
    expect(toUsdcUnits("99.99")).toBe("99990000");
    expect(toUsdcUnits("100")).toBe("100000000");
  });
});

describe("quote body", () => {
  it("builds the exact 1Click request for USDC on Base to USDC on NEAR", () => {
    expect(quoteBody(good, NOW)).toEqual({
      dry: true,
      swapType: "EXACT_INPUT",
      slippageTolerance: 100,
      originAsset: "nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near",
      destinationAsset: USDC_NEAR,
      amount: "1500000",
      depositType: "ORIGIN_CHAIN",
      refundTo: "0x0000000000000000000000000000000000000001",
      refundType: "ORIGIN_CHAIN",
      recipient: "payroll-treasury.near",
      recipientType: "DESTINATION_CHAIN",
      deadline: "2026-11-14T21:22:10.507Z",
    });
  });

  it("uses the Arbitrum USDC asset and passes dry: false through", () => {
    const b = quoteBody({ ...good, origin: "arbitrum", dry: false }, NOW);
    expect(b.originAsset).toBe("nep141:arb-0xaf88d065e77c8cc2239327c5edb3a432268e5831.omft.near");
    expect(b.dry).toBe(false);
  });

  it("matches the request 1Click echoed back for the recorded dry quote", () => {
    const echoed = dryQuote.quoteRequest;
    const b = quoteBody({ ...good, recipient: "example.near" }, NOW);
    for (const k of Object.keys(b) as Array<keyof typeof b>) expect(echoed[k]).toEqual(b[k]);
  });
});

describe("quoteFunding", () => {
  it("POSTs the body to /v0/quote and returns the recorded dry quote", async () => {
    const f = vi.fn(async () => json(dryQuote));
    const r = await quoteFunding(good, f as unknown as typeof fetch, () => NOW);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://1click.chaindefuser.com/v0/quote");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual(quoteBody(good, NOW));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.quote.amountOutFormatted).toBe("1.49606");
      expect(r.data.quote.timeEstimate).toBe(35);
      expect(r.data.quote.depositAddress).toBeUndefined();
    }
  });

  it("returns the deposit address and deadline of a real quote", async () => {
    const f = vi.fn(async () => json(liveQuote));
    const r = await quoteFunding({ ...good, dry: false }, f as unknown as typeof fetch, () => NOW);
    expect(r.ok && r.data.quote.depositAddress).toBe("0x5c1e3a7f9b2d4e6081a3c5e7f9b1d3a5c7e9f1b3");
    expect(r.ok && r.data.quote.deadline).toBe("2026-11-14T21:22:10.507Z");
  });

  it("does not call 1Click when the input is invalid", async () => {
    const f = vi.fn();
    const r = await quoteFunding({ ...good, recipient: "nope" }, f as unknown as typeof fetch);
    expect(f).not.toHaveBeenCalled();
    expect(r).toMatchObject({ ok: false, reason: "invalid", field: "recipient" });
  });

  it("reports a non-200 answer with 1Click's message", async () => {
    const f = vi.fn(async () => json({ message: "Amount is too low for bridge", statusCode: 400 }, 400));
    const r = await quoteFunding(good, f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, reason: "http", status: 400 });
    expect(!r.ok && r.message).toContain("Amount is too low for bridge");
  });

  it("reports a network error in plain English", async () => {
    const f = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const r = await quoteFunding(good, f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, reason: "network" });
    expect(!r.ok && r.message).toMatch(/could not reach/i);
  });

  it("rejects a real quote that has no deposit address", async () => {
    const f = vi.fn(async () => json(dryQuote));
    const r = await quoteFunding({ ...good, dry: false }, f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, reason: "bad_response" });
  });

  it("rejects an answer that is not a quote", async () => {
    const f = vi.fn(async () => new Response("<html>oops</html>", { status: 200 }));
    const r = await quoteFunding(good, f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, reason: "bad_response" });
  });
});

describe("fundingStatus", () => {
  it("GETs the status for a deposit address", async () => {
    const f = vi.fn(async () => json(statusSuccess));
    const r = await fundingStatus("0x5c1e3a7f9b2d4e6081a3c5e7f9b1d3a5c7e9f1b3", f as unknown as typeof fetch);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(
      "https://1click.chaindefuser.com/v0/status?depositAddress=0x5c1e3a7f9b2d4e6081a3c5e7f9b1d3a5c7e9f1b3",
    );
    expect(r.ok && r.data.status).toBe("SUCCESS");
    expect(r.ok && r.data.swapDetails?.amountOutFormatted).toBe("1.49606");
  });

  it("reports a 404 and a network error", async () => {
    const notFound = vi.fn(async () => json({ message: "Deposit address 0x1 not found" }, 404));
    expect(await fundingStatus("0x1", notFound as unknown as typeof fetch)).toMatchObject({
      ok: false,
      reason: "http",
      status: 404,
    });
    const down = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(await fundingStatus("0x1", down as unknown as typeof fetch)).toMatchObject({
      ok: false,
      reason: "network",
    });
  });

  it("rejects an unknown status value", async () => {
    const f = vi.fn(async () => json({ ...statusPending, status: "WHATEVER" }));
    expect(await fundingStatus("0x1", f as unknown as typeof fetch)).toMatchObject({
      ok: false,
      reason: "bad_response",
    });
  });
});

describe("submitDeposit", () => {
  const tx = "0x3f9a1c7e5b2d8f4a6c0e1b3d5f7a9c2e4b6d8f0a1c3e5b7d9f2a4c6e8b0d1f3a";
  it("POSTs the tx hash and the deposit address", async () => {
    const f = vi.fn(async () => json(statusPending));
    const r = await submitDeposit(tx, "0x5c1e", f as unknown as typeof fetch);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://1click.chaindefuser.com/v0/deposit/submit");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ txHash: tx, depositAddress: "0x5c1e" });
    expect(r.ok).toBe(true);
  });

  it("refuses a malformed tx hash without calling 1Click", async () => {
    const f = vi.fn();
    expect(await submitDeposit("0x12", "0x5c1e", f as unknown as typeof fetch)).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(f).not.toHaveBeenCalled();
  });

  it("reports a non-200 answer", async () => {
    const f = vi.fn(async () => json({ message: "Transaction not found" }, 400));
    const r = await submitDeposit(tx, "0x5c1e", f as unknown as typeof fetch);
    expect(r).toMatchObject({ ok: false, reason: "http", status: 400 });
  });
});

describe("status in plain English", () => {
  const all: FundingStatus[] = [
    "PENDING_DEPOSIT",
    "KNOWN_DEPOSIT_TX",
    "PROCESSING",
    "INCOMPLETE_DEPOSIT",
    "SUCCESS",
    "REFUNDED",
    "FAILED",
  ];

  it("has a sentence for every status", () => {
    expect(Object.keys(STATUS_TEXT).sort()).toEqual([...all].sort());
    for (const s of all) expect(describeStatus(s)).toMatch(/^[A-Z].*\.$/);
    expect(describeStatus("PENDING_DEPOSIT")).toMatch(/waiting for your deposit/i);
    expect(describeStatus("SUCCESS")).toMatch(/delivered/i);
    expect(describeStatus("REFUNDED")).toMatch(/refund address/i);
    expect(describeStatus("SOMETHING_NEW")).toMatch(/SOMETHING_NEW/);
  });

  it("treats only SUCCESS, REFUNDED and FAILED as final", () => {
    expect(all.filter(isTerminal)).toEqual(["SUCCESS", "REFUNDED", "FAILED"]);
  });

  it("maps every status onto the four steps", () => {
    const states = (s: FundingStatus) => fundingSteps(s).map((x) => x.state);
    expect(fundingSteps("PENDING_DEPOSIT").map((x) => x.label)).toEqual([
      "Waiting for your deposit",
      "Deposit seen",
      "Swapping and delivering",
      "Delivered",
    ]);
    expect(states("PENDING_DEPOSIT")).toEqual(["current", "todo", "todo", "todo"]);
    expect(states("KNOWN_DEPOSIT_TX")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("INCOMPLETE_DEPOSIT")).toEqual(["done", "current", "todo", "todo"]);
    expect(states("PROCESSING")).toEqual(["done", "done", "current", "todo"]);
    expect(states("SUCCESS")).toEqual(["done", "done", "done", "done"]);
    expect(states("REFUNDED")).toEqual(["done", "done", "stopped", "todo"]);
    expect(states("FAILED")).toEqual(["done", "done", "stopped", "todo"]);
  });
});

describe("links and hashes", () => {
  it("links origin txs to the chain's explorer and NEAR txs to nearblocks", () => {
    expect(originTxUrl("base", "0xabc")).toBe("https://basescan.org/tx/0xabc");
    expect(originTxUrl("arbitrum", "0xabc")).toBe("https://arbiscan.io/tx/0xabc");
    expect(nearTxUrl("7Xh2")).toBe("https://nearblocks.io/txns/7Xh2");
    expect(FUND_ORIGINS.base.chain).toBe("Base");
    expect(FUND_ORIGINS.arbitrum.chain).toBe("Arbitrum");
  });

  it("reads hashes given as strings or as {hash} objects", () => {
    expect(txHashes(["a", { hash: "b", explorerUrl: "" }, 3, null])).toEqual(["a", "b"]);
    expect(txHashes(undefined)).toEqual([]);
  });

  it("stops polling ten minutes after the deadline", () => {
    expect(pollingEndsAt("2026-11-14T21:22:10.507Z")).toBe(Date.parse("2026-11-14T21:32:10.507Z"));
  });
});

describe("the active deposit in localStorage", () => {
  const active: ActiveDeposit = {
    depositAddress: "0x5c1e3a7f9b2d4e6081a3c5e7f9b1d3a5c7e9f1b3",
    origin: "base",
    amountIn: "1500000",
    amountInFormatted: "1.5",
    amountOutFormatted: "1.49606",
    deadline: "2026-11-14T21:22:10.507Z",
    recipient: "payroll-treasury.near",
  };

  it("saves, loads and clears it", () => {
    const store = new Map<string, string>();
    const s = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => store.set(k, v),
      removeItem: (k: string) => store.delete(k),
    } as unknown as Storage;
    saveActive(s, active);
    expect(JSON.parse(store.get(ACTIVE_KEY) ?? "null")).toEqual(active);
    expect(loadActive(s)).toEqual(active);
    clearActive(s);
    expect(loadActive(s)).toBeNull();
  });

  it("ignores a storage that throws, is missing, or holds junk", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(() => saveActive(throwing, active)).not.toThrow();
    expect(loadActive(throwing)).toBeNull();
    expect(() => clearActive(throwing)).not.toThrow();
    expect(loadActive(null)).toBeNull();
    const junk = { getItem: () => '{"depositAddress":5}' } as unknown as Storage;
    expect(loadActive(junk)).toBeNull();
  });
});
