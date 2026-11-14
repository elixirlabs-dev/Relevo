import { readFileSync } from "node:fs";
import { directV2HashB58, type PayeeProof } from "@elivo/shared/direct-receipt-v2";
import { describe, expect, it } from "vitest";
import { decodePayeeLink, payeeLink, verifyPayeeProof } from "../lib/payee.ts";
import { encodeShare } from "../lib/share.ts";

const PROOF: PayeeProof = JSON.parse(
  readFileSync("apps/web/public/receipts/testnet-payee-proof-v2.json", "utf8"),
);
const H = PROOF.header;
const ED = H.signatures.find((s) => s.alg === "ed25519")?.public_key as string;
const PQ = H.signatures.find((s) => s.alg === "ml-dsa-65")?.public_key as string;
const HASH = directV2HashB58(H);
const AT_NS = "1794685161000000000"; // 2026-11-14T19:39:21Z
const app = { network: "testnet", registry: H.registry };

/** A registry that has anchored this receipt with the issuer's keys (or what the test passes). */
function chain(anchor: object | null = {}) {
  const calls: Array<{ contract: string; method: string; args?: object }> = [];
  const view = async <T>(contract: string, method: string, args?: object): Promise<T> => {
    calls.push({ contract, method, args });
    if (method !== "get_receipt") throw new Error(method);
    return (anchor && {
      issuer: H.issuer,
      receipt_id: H.receipt_id,
      receipt_hash: HASH,
      key_version: 1,
      receipt_pk: ED,
      mldsa65_pk: PQ,
      anchored_at_ns: AT_NS,
      ...anchor,
    }) as T;
  };
  return { view, calls };
}
const okById = (r: Awaited<ReturnType<typeof verifyPayeeProof>>) =>
  Object.fromEntries(r.checks.map((c) => [c.id, c.ok]));

describe("payee links", () => {
  it("carry one payee's proof in the fragment, and round-trip it", async () => {
    const link = await payeeLink("https://relevo-amber.vercel.app", PROOF);
    expect(link.startsWith("https://relevo-amber.vercel.app/payee#p=")).toBe(true);
    expect(link).toMatch(/^[\w:/.#=-]+$/);
    expect(link.length).toBeLessThan(12_000);
    expect(await decodePayeeLink(link.slice(link.indexOf("#")))).toEqual(PROOF);
  });

  it("refuse anything that is not a payee proof link", async () => {
    expect(await decodePayeeLink("")).toBeNull();
    expect(await decodePayeeLink("#r=abc")).toBeNull();
    expect(await decodePayeeLink("#p=!!!")).toBeNull();
    expect(await decodePayeeLink("#p=AAAA")).toBeNull();
    expect(await decodePayeeLink(`#p=${await encodeShare('{"version":"elivo-payee-proof-1"}')}`)).toBeNull();
    expect(await decodePayeeLink(`#p=${await encodeShare("not json")}`)).toBeNull();
  });
});

describe("verifyPayeeProof", () => {
  it("passes every check for the testnet sample, with keys and hash from the chain", async () => {
    const c = chain();
    const r = await verifyPayeeProof(PROOF, app, c.view);
    expect(r.checks.map((x) => [x.id, x.ok])).toEqual([
      ["registry", true],
      ["signature", true],
      ["anchor", true],
      ["merkle", true],
    ]);
    expect(r.ok).toBe(true);
    expect(r.hash).toBe(HASH);
    expect(r.anchoredAt).toBe(new Date(Number(BigInt(AT_NS) / 1_000_000n)).toISOString());
    expect(c.calls).toEqual([
      {
        contract: H.registry,
        method: "get_receipt",
        args: { issuer: H.issuer, receipt_id: H.receipt_id },
      },
    ]);
  });

  it("fails only the Merkle check when the amount in the link was changed", async () => {
    const tampered = { ...PROOF, payout: { ...PROOF.payout, amount: "185000.00" } };
    const r = await verifyPayeeProof(tampered, app, chain().view);
    expect(okById(r)).toEqual({ registry: true, signature: true, anchor: true, merkle: false });
    expect(r.ok).toBe(false);
  });

  it("fails the signature when the registry holds another key for the issuer", async () => {
    const other = "ed25519:3tbBnJ5yGw4kzdY4zM7j8Jz7d4Mx8eEMxxMeAqZdTLeW";
    const r = await verifyPayeeProof(PROOF, app, chain({ receipt_pk: other, mldsa65_pk: null }).view);
    expect(okById(r).signature).toBe(false);
    expect(r.ok).toBe(false);
  });

  it("fails the anchor when the chain holds another hash, or none", async () => {
    const r = await verifyPayeeProof(PROOF, app, chain({ receipt_hash: "1111" }).view);
    expect(okById(r)).toMatchObject({ signature: true, anchor: false });
    const none = await verifyPayeeProof(PROOF, app, chain(null).view);
    expect(okById(none)).toMatchObject({ anchor: false, merkle: true });
    expect(none.ok).toBe(false);
  });

  it("refuses a proof for another registry without reading the chain, and still checks the path", async () => {
    const c = chain();
    const r = await verifyPayeeProof(
      PROOF,
      { network: "testnet", registry: "registry.other.testnet" },
      c.view,
    );
    expect(r.checks.map((x) => [x.id, x.ok])).toEqual([
      ["registry", false],
      ["merkle", true],
    ]);
    expect(c.calls).toHaveLength(0);
    expect(r.ok).toBe(false);
  });
});
