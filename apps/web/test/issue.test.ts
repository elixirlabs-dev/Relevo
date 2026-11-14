import {
  directV2HashB58Web,
  isDirectReceiptV2,
  verifyDirectV2SignaturesWeb,
  verifyDirectV2Structure,
} from "@elivo/shared/direct-receipt-v2";
import { describe, expect, it } from "vitest";
import { recordAnchoredCheck } from "../lib/check.ts";
import { issuerKeys, PENDING_KEY, prepareIssue, readPending, SAMPLE_RESULTS_CSV } from "../lib/issue.ts";

const registry = "registry.example.testnet";
const account = "alice.testnet";

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

const base = {
  csv: SAMPLE_RESULTS_CSV,
  rail: "SPEI",
  currency: "MXN",
  receiptId: "demo-1",
  account,
  registry,
  network: "testnet",
  postQuantum: true,
};

describe("issuer keys", () => {
  it("are created once per account and reused from storage", () => {
    const s = memoryStorage();
    const a = issuerKeys(account, s);
    const b = issuerKeys(account, s);
    expect(b.edPk).toBe(a.edPk);
    expect(b.pq.publicKeyB64).toBe(a.pq.publicKeyB64);
    expect(issuerKeys("bob.testnet", s).edPk).not.toBe(a.edPk);
  });

  it("still work when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(issuerKeys(account, broken).edPk).toMatch(/^ed25519:/);
  });
});

describe("prepareIssue", () => {
  it("signs in the browser and builds one transaction: publish keys, then anchor", async () => {
    const s = memoryStorage();
    const out = prepareIssue({ ...base, currentKeys: null }, s);
    if (!out.ok) throw new Error(out.errors.join());
    const keys = issuerKeys(account, s);
    expect(out.receipt.issuer).toBe(account);
    expect(out.receipt.registry).toBe(registry);
    expect(isDirectReceiptV2(out.receipt)).toBe(true);
    expect(out.receipt.version).toBe("elivo-direct-receipt-2");
    expect(verifyDirectV2Structure(out.receipt)).toEqual([]);
    expect(out.receipt.signatures.map((x) => x.alg)).toEqual(["ed25519", "ml-dsa-65"]);
    expect(
      await verifyDirectV2SignaturesWeb(out.receipt, {
        receipt_pk: keys.edPk,
        mldsa65_pk: keys.pq.publicKeyB64,
      }),
    ).toEqual({ ok: true });
    expect(out.tx.receiverId).toBe(registry);
    expect(out.tx.actions.map((a) => a.params.methodName)).toEqual(["set_keys", "anchor"]);
    expect(out.tx.actions[0].params.args).toEqual({
      receipt_pk: keys.edPk,
      mldsa65_pk: keys.pq.publicKeyB64,
    });
    expect(out.tx.actions[1].params.args).toEqual({ receipt_id: "demo-1", receipt_hash: out.hash });
    expect(out.hash).toBe(await directV2HashB58Web(out.receipt));
    // Names and full account numbers never leave the browser.
    expect(JSON.stringify(out.tx)).not.toContain("002010077777777771");
    expect(JSON.stringify(out.receipt)).not.toContain("Lucía");
  });

  it("skips publishing keys the registry already has", () => {
    const s = memoryStorage();
    const keys = issuerKeys(account, s);
    const out = prepareIssue(
      { ...base, currentKeys: { receipt_pk: keys.edPk, mldsa65_pk: keys.pq.publicKeyB64 } },
      s,
    );
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.tx.actions.map((a) => a.params.methodName)).toEqual(["anchor"]);
  });

  it("publishes a key set without the post-quantum key when that option is off", () => {
    const s = memoryStorage();
    const keys = issuerKeys(account, s);
    const out = prepareIssue(
      {
        ...base,
        postQuantum: false,
        currentKeys: { receipt_pk: keys.edPk, mldsa65_pk: keys.pq.publicKeyB64 },
      },
      s,
    );
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.receipt.signatures).toHaveLength(1);
    expect(out.tx.actions[0].params.args).toEqual({ receipt_pk: keys.edPk, mldsa65_pk: null });
  });

  it("reports bad rows and a bad receipt id instead of signing", () => {
    const bad = prepareIssue(
      {
        ...base,

        csv: "name,account,amount,status,paid_at,reference\nA,002010077777777772,10,paid,2026-11-14T10:00:00Z,R\n",
        currentKeys: null,
      },
      memoryStorage(),
    );
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.errors).toEqual(["Row 2: clabe_check_digit"]);
    const badId = prepareIssue({ ...base, receiptId: "has space", currentKeys: null }, memoryStorage());
    expect(badId.ok ? [] : badId.errors).toEqual([
      "Receipt id: 1 to 64 letters, digits, dots, dashes or underscores",
    ]);
  });

  it("keeps the signed receipt and its salt as pending, so a wallet that reloads the page doesn't lose them", () => {
    const s = memoryStorage();
    const out = prepareIssue({ ...base, currentKeys: null }, s);
    if (!out.ok) throw new Error(out.errors.join());
    expect(s.getItem(PENDING_KEY)).toBeNull();
    s.setItem(PENDING_KEY, JSON.stringify(out.pending));
    const back = readPending(s);
    expect(back?.receipt.receipt_id).toBe("demo-1");
    expect(back?.receiptSaltHex).toMatch(/^[0-9a-f]{32}$/);
    expect(back?.names).toEqual([
      "Lucía Fernández",
      "Mateo Ríos",
      "Sofía Herrera",
      "Diego Navarro",
      "Valentina Cruz",
    ]);
    expect(back?.accounts[0]).toBe("002010077777777771");
    s.setItem(PENDING_KEY, "{not json");
    expect(readPending(s)).toBeNull();
    // A pending entry whose names don't line up with the payouts is dropped.
    s.setItem(PENDING_KEY, JSON.stringify({ ...out.pending, names: ["only one"] }));
    expect(readPending(s)).toBeNull();
    // A bare receipt (the old pending format) is not enough: there is no salt to make payee links.
    s.setItem(PENDING_KEY, JSON.stringify(out.receipt));
    expect(readPending(s)).toBeNull();
  });

  it("keeps the receipt salt out of the receipt and the transaction", () => {
    const out = prepareIssue({ ...base, currentKeys: null }, memoryStorage());
    if (!out.ok) throw new Error(out.errors.join());
    expect(JSON.stringify(out.receipt)).not.toContain(out.pending.receiptSaltHex);
    expect(JSON.stringify(out.tx)).not.toContain(out.pending.receiptSaltHex);
  });
});

describe("prepareIssue and the check made before paying", () => {
  const last = {
    report_id: "check-20261114-150000",
    hash: "CheckHash111",
    checked_at: "2026-11-14T15:00:00.000Z",
  };

  it("points the receipt at the last check this browser anchored for the account", async () => {
    const s = memoryStorage();
    recordAnchoredCheck(account, last, s);
    const out = prepareIssue({ ...base, currentKeys: null }, s);
    if (!out.ok) throw new Error(out.errors.join());
    expect(out.receipt.check_ref).toEqual({ report_id: last.report_id, report_hash: last.hash });
    // check_ref is inside the signed header, so the anchored hash covers it.
    expect(out.hash).toBe(await directV2HashB58Web(out.receipt));
  });

  it("leaves check_ref empty when there is no anchored check, or when asked not to link one", () => {
    const s = memoryStorage();
    const none = prepareIssue({ ...base, currentKeys: null }, s);
    expect(none.ok && none.receipt.check_ref).toBeNull();
    recordAnchoredCheck(account, last, s);
    const unlinked = prepareIssue({ ...base, currentKeys: null, checkRef: null }, s);
    expect(unlinked.ok && unlinked.receipt.check_ref).toBeNull();
    recordAnchoredCheck("bob.testnet", last, s);
    const other = prepareIssue({ ...base, account: "carol.testnet", currentKeys: null }, s);
    expect(other.ok && other.receipt.check_ref).toBeNull();
  });

  it("uses the check given explicitly", () => {
    const out = prepareIssue(
      { ...base, currentKeys: null, checkRef: { report_id: "check-x", report_hash: "H" } },
      memoryStorage(),
    );
    expect(out.ok && out.receipt.check_ref).toEqual({ report_id: "check-x", report_hash: "H" });
  });
});
