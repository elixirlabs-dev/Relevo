import { ATTEST_DEPOSIT } from "@elivo/shared/direct-receipt";
import { describe, expect, it } from "vitest";
import {
  ATTEST_PENDING_KEY,
  attestErrorWords,
  attestTx,
  daoRoles,
  readPendingAttest,
  writePendingAttest,
} from "../lib/attest.ts";

describe("attestTx", () => {
  it("sends attest to the registry with the issuer, receipt id and hash, ATTEST_DEPOSIT and 30 Tgas", () => {
    expect(
      attestTx({
        registry: "registry.example.testnet",
        issuer: "payroll.example.testnet",
        receiptId: "payroll-2026-11-v2",
        hash: "HASH58",
      }),
    ).toEqual({
      receiverId: "registry.example.testnet",
      actions: [
        {
          type: "FunctionCall",
          params: {
            methodName: "attest",
            args: {
              issuer: "payroll.example.testnet",
              receipt_id: "payroll-2026-11-v2",
              receipt_hash: "HASH58",
            },
            gas: "30000000000000",
            deposit: ATTEST_DEPOSIT.toString(),
          },
        },
      ],
    });
    expect(ATTEST_DEPOSIT.toString()).toBe("10000000000000000000000");
  });
});

describe("daoRoles", () => {
  const policy = {
    roles: [
      { name: "all", kind: "Everyone" },
      { name: "council", kind: { Group: ["council.example.testnet", "b.testnet"] } },
      { name: "auditors", kind: { Group: ["b.testnet"] } },
      { name: "members", kind: { Member: "1" } },
    ],
  };
  it("names every Group role that holds the account", () => {
    expect(daoRoles(policy, "council.example.testnet")).toEqual(["council"]);
    expect(daoRoles(policy, "b.testnet")).toEqual(["council", "auditors"]);
    expect(daoRoles(policy, "someone.testnet")).toEqual([]);
  });
  it("gives no roles for a missing or malformed policy", () => {
    expect(daoRoles(null, "b.testnet")).toEqual([]);
    expect(daoRoles({ roles: "x" }, "b.testnet")).toEqual([]);
    expect(daoRoles({ roles: [null, { name: 1, kind: { Group: ["b.testnet"] } }] }, "b.testnet")).toEqual([]);
  });
});

describe("attestErrorWords", () => {
  it("puts the contract's errors in plain words", () => {
    expect(attestErrorWords(new Error("Smart contract panicked: already_attested"))).toBe(
      "You've already attested this receipt.",
    );
    expect(attestErrorWords(new Error("ExecutionError: hash_mismatch"))).toBe(
      "This file doesn't match the anchored receipt.",
    );
    expect(attestErrorWords(new Error("not_anchored"))).toBe(
      "This receipt is not anchored in the registry, so it can't be attested.",
    );
    expect(attestErrorWords(new Error("too_many_attestations"))).toBe(
      "This receipt already has the most attestations the registry keeps (100).",
    );
    expect(attestErrorWords(new Error("User rejected"))).toBe("User rejected");
  });
  it("finds the error inside a wallet's full NEAR failure", () => {
    const failure = JSON.stringify({
      index: 0,
      kind: { ExecutionError: "Smart contract panicked: hash_mismatch" },
    });
    expect(attestErrorWords(new Error(failure))).toBe("This file doesn't match the anchored receipt.");
    expect(attestErrorWords(new Error(""))).toBe("The transaction did not go through.");
  });
});

describe("pending attest", () => {
  const entry = { issuer: "i.testnet", receipt_id: "r", account: "a.testnet", text: "{}", at: 1_000_000 };
  const store = () => {
    const m = new Map<string, string>();
    return {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      removeItem: (k: string) => void m.delete(k),
    } as unknown as Storage;
  };
  it("reads back what was written, within 10 minutes", () => {
    const s = store();
    writePendingAttest(s, entry);
    expect(readPendingAttest(s, entry.at + 9 * 60_000)).toEqual(entry);
  });
  it("drops a stale or malformed entry", () => {
    const s = store();
    writePendingAttest(s, entry);
    expect(readPendingAttest(s, entry.at + 10 * 60_000 + 1)).toBeNull();
    expect(s.getItem(ATTEST_PENDING_KEY)).toBeNull();
    s.setItem(ATTEST_PENDING_KEY, JSON.stringify({ issuer: "i.testnet", receipt_id: "r", account: "a" }));
    expect(readPendingAttest(s, entry.at)).toBeNull();
    expect(s.getItem(ATTEST_PENDING_KEY)).toBeNull();
    s.setItem(ATTEST_PENDING_KEY, "not json");
    expect(readPendingAttest(s, entry.at)).toBeNull();
  });
  it("survives storage that throws", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(() => writePendingAttest(broken, entry)).not.toThrow();
    expect(readPendingAttest(broken)).toBeNull();
    expect(readPendingAttest(null)).toBeNull();
  });
});
