import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ChainCallError } from "../src/chain.ts";
import {
  anchorDirectReceipt,
  buildDirectReceipt,
  ensureIssuerKeys,
  parseResultsCsv,
  signDirectReceipt,
} from "../src/direct-issue.ts";
import { directHashB58Web, verifyDirectSignaturesWeb } from "../src/direct-verify-web.ts";
import { keyFromSeed } from "../src/keys.ts";
import { type LocalStack, startLocalStack } from "../src/testing/localstack.ts";

const CSV = `name,account,amount,status,paid_at,reference
Lucía Fernández,002010077777777771,37000,paid,2026-11-14T10:00:00Z,SPEI-REF-0001
Sofía Herrera,012180001234567899,27750.00,returned,,ACCOUNT_CLOSED
`;

let stack: LocalStack;
beforeAll(async () => {
  stack = await startLocalStack();
});
afterAll(async () => {
  await stack?.stop();
});

interface AnchorView {
  receipt_hash: string;
  receipt_pk: string;
  key_version: number;
  mldsa65_pk: string | null;
}

describe("direct receipts on the registry", () => {
  it("publishes the issuer's key, anchors a receipt, and the receipt verifies against the chain", async () => {
    const { chain, deployment: d, keys } = stack;
    const registry = d.registry as string;
    const issuerId = `payroll.${d.escrow.split(".").slice(1).join(".")}`;
    const issuer = chain.signer(issuerId, keys.accounts[issuerId]);
    const receiptKey = keyFromSeed(randomBytes(32));

    const v1 = await ensureIssuerKeys(chain.view.bind(chain), issuer, registry, receiptKey);
    expect(v1).toBe(1);
    // Publishing the same key again is a no-op.
    expect(await ensureIssuerKeys(chain.view.bind(chain), issuer, registry, receiptKey)).toBe(1);

    const { rows } = parseResultsCsv(CSV, { rail: "SPEI" });
    const r = signDirectReceipt(
      buildDirectReceipt(rows, {
        network: "sandbox",
        registry,
        issuer: issuerId,
        receipt_id: "nov-contractors",
        rail: "SPEI",
        currency: "MXN",
        salt: randomBytes(16),
      }),
      receiptKey,
    );
    const { hash } = await anchorDirectReceipt(issuer, registry, r);

    const onChain = await chain.view<AnchorView>(registry, "get_receipt", {
      issuer: issuerId,
      receipt_id: "nov-contractors",
    });
    expect(onChain.receipt_hash).toBe(hash);
    expect(onChain.receipt_hash).toBe(await directHashB58Web(r));
    expect(onChain.receipt_pk).toBe(receiptKey.publicKeyStr);
    expect(await verifyDirectSignaturesWeb(r, onChain)).toEqual({ ok: true });

    // The same id can't be anchored twice, so a receipt can't be swapped after the fact.
    await expect(anchorDirectReceipt(issuer, registry, r)).rejects.toThrow(ChainCallError);

    // Rotating the key leaves the old receipt verifiable with the key it was anchored under.
    await ensureIssuerKeys(chain.view.bind(chain), issuer, registry, keyFromSeed(randomBytes(32)));
    const after = await chain.view<AnchorView>(registry, "get_receipt", {
      issuer: issuerId,
      receipt_id: "nov-contractors",
    });
    expect(after.receipt_pk).toBe(receiptKey.publicKeyStr);
  });
});
