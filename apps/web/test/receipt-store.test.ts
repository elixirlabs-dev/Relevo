import { parseResultsCsv } from "@elivo/shared/direct-build";
import {
  buildDirectReceiptV2,
  directV2HashB58,
  payeeRefMatches,
  signDirectReceiptV2,
  verifyPayeeProofStructure,
} from "@elivo/shared/direct-receipt-v2";
import { describe, expect, it } from "vitest";
import { SAMPLE_RESULTS_CSV } from "../lib/issue.ts";
import { findPayout, listIssued, MAX_ISSUED, payeeProofFor, saveIssued } from "../lib/receipt-store.ts";

function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    getItem: (k) => m.get(k) ?? null,
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => void m.delete(k),
    setItem: (k, v) => void m.set(k, v),
  };
}

const account = "alice.testnet";
const salt = new Uint8Array(16).fill(5);
const saltHex = "05".repeat(16);
const { rows } = parseResultsCsv(SAMPLE_RESULTS_CSV, { rail: "SPEI" });

function issued(receipt_id: string) {
  const receipt = signDirectReceiptV2(
    buildDirectReceiptV2(rows, {
      network: "testnet",
      registry: "registry.example.testnet",
      issuer: account,
      receipt_id,
      rail: "SPEI",
      currency: "MXN",
      salt,
    }),
    new Uint8Array(32).fill(1),
  );
  return {
    receipt_id,
    hash: directV2HashB58(receipt),
    receipt,
    receiptSaltHex: saltHex,
    names: rows.map((r) => r.name),
    accounts: rows.map((r) => r.account),
  };
}

describe("receipt store", () => {
  it("keeps issued receipts per account, newest first, replacing one re-saved under the same id", () => {
    const s = memoryStorage();
    expect(listIssued(account, s)).toEqual([]);
    saveIssued(account, issued("nov-1"), s);
    saveIssued(account, issued("nov-2"), s);
    saveIssued(account, issued("nov-1"), s);
    expect(listIssued(account, s).map((r) => r.receipt_id)).toEqual(["nov-1", "nov-2"]);
    expect(listIssued("bob.testnet", s)).toEqual([]);
  });

  it("finds a payout by name (accents, case and spaces ignored) or by full account", () => {
    const s = memoryStorage();
    saveIssued(account, issued("nov-1"), s);
    const byName = findPayout(account, "  lucia   FERNANDEZ ", s);
    expect(byName).toEqual([
      { receipt_id: "nov-1", index: 0, name: "Lucía Fernández", amount: "37000.00", status: "Paid" },
    ]);
    expect(findPayout(account, "012180001234567899", s)).toEqual([
      { receipt_id: "nov-1", index: 2, name: "Sofía Herrera", amount: "27750.00", status: "Returned" },
    ]);
    expect(findPayout(account, "nobody", s)).toEqual([]);
    expect(findPayout(account, "  ", s)).toEqual([]);
    // Only a full account matches: the last 4 digits alone are not enough.
    expect(findPayout(account, "7899", s)).toEqual([]);
  });

  it("finds the same payee in every receipt issued from this browser", () => {
    const s = memoryStorage();
    saveIssued(account, issued("nov-1"), s);
    saveIssued(account, issued("dec-1"), s);
    expect(findPayout(account, "Mateo Ríos", s).map((m) => [m.receipt_id, m.index])).toEqual([
      ["dec-1", 1],
      ["nov-1", 1],
    ]);
  });

  it("makes a payee proof from the stored salt that verifies and matches the payee's account", () => {
    const s = memoryStorage();
    saveIssued(account, issued("nov-1"), s);
    const [rec] = listIssued(account, s);
    const p = payeeProofFor(rec, 4);
    expect(verifyPayeeProofStructure(p)).toEqual([]);
    expect(payeeRefMatches(p, "646180005555555554")).toBe(true);
    expect(payeeRefMatches(p, "002010077777777771")).toBe(false);
    // The proof carries no name and no full account.
    expect(JSON.stringify(p)).not.toContain("Valentina");
    expect(JSON.stringify(p)).not.toContain("646180005555555554");
  });

  it("says whether it kept the receipt: false when the store's key can't be written", () => {
    const s = memoryStorage();
    expect(saveIssued(account, issued("nov-1"), s)).toBe(true);
    const full: Storage = {
      ...s,
      getItem: (k) => s.getItem(k),
      setItem: (k, v) => {
        if (k.startsWith("elivo-issued:")) throw new DOMException("quota", "QuotaExceededError");
        s.setItem(k, v);
      },
    };
    expect(saveIssued(account, issued("nov-2"), full)).toBe(false);
    expect(listIssued(account, s).map((r) => r.receipt_id)).toEqual(["nov-1"]);
    expect(saveIssued(account, issued("nov-3"), null)).toBe(false);
  });

  it("keeps the newest receipts only, and carries over entries it doesn't recognise", () => {
    const s = memoryStorage();
    const one = issued("r-0");
    const older = Array.from({ length: MAX_ISSUED + 5 }, (_, i) => ({
      ...one,
      receipt_id: `r-${i}`,
      receipt: { ...one.receipt, receipt_id: `r-${i}` },
    }));
    const foreign = { kind: "from a later version", receipt_id: "x" };
    s.setItem(`elivo-issued:${account}`, JSON.stringify([...older, foreign]));
    expect(saveIssued(account, issued("new"), s)).toBe(true);
    const kept = listIssued(account, s).map((r) => r.receipt_id);
    expect(kept).toHaveLength(MAX_ISSUED);
    expect(kept[0]).toBe("new");
    expect(kept[1]).toBe("r-0");
    expect(kept.at(-1)).toBe(`r-${MAX_ISSUED - 2}`);
    const raw = JSON.parse(s.getItem(`elivo-issued:${account}`) as string);
    expect(raw.at(-1)).toEqual(foreign);
  });

  it("doesn't overwrite a store it can't read", () => {
    const s = memoryStorage();
    s.setItem(`elivo-issued:${account}`, "{not json");
    expect(saveIssued(account, issued("nov-1"), s)).toBe(false);
    expect(s.getItem(`elivo-issued:${account}`)).toBe("{not json");
  });

  it("ignores broken or blocked storage", () => {
    const s = memoryStorage();
    s.setItem(`elivo-issued:${account}`, "{not json");
    expect(listIssued(account, s)).toEqual([]);
    s.setItem(`elivo-issued:${account}`, JSON.stringify([{ receipt_id: "x" }]));
    expect(listIssued(account, s)).toEqual([]);
    const blocked = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(saveIssued(account, issued("nov-1"), blocked)).toBe(false);
    expect(listIssued(account, blocked)).toEqual([]);
    expect(findPayout(account, "Mateo Ríos", null)).toEqual([]);
  });
});
