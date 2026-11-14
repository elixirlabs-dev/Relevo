import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeShare, encodeShare, shareUrl } from "../lib/share.ts";

const pq = readFileSync("apps/web/public/receipts/testnet-direct-payroll-pq.json", "utf8");
const batch = readFileSync("apps/web/public/receipts/testnet-batch-5.json", "utf8");

describe("share links", () => {
  it("round-trip a receipt byte for byte, so the anchored hash still matches", async () => {
    for (const text of [pq, batch]) expect(await decodeShare(await encodeShare(text))).toBe(text);
  });

  it("stay short enough to paste: the post-quantum receipt fits in a link", async () => {
    const link = shareUrl("https://relevo-amber.vercel.app", await encodeShare(pq));
    expect(link.startsWith("https://relevo-amber.vercel.app/verify#r=")).toBe(true);
    expect(link.length).toBeLessThan(10_000);
    expect(link).toMatch(/^[\w:/.#=-]+$/);
  });

  it("ignore anything that is not a share fragment, or that is broken", async () => {
    expect(await decodeShare("")).toBeNull();
    expect(await decodeShare("#other=1")).toBeNull();
    expect(await decodeShare("#r=!!!not-base64")).toBeNull();
    expect(await decodeShare("#r=AAAA")).toBeNull();
  });

  it("refuse a link that inflates past 1 MB", async () => {
    const big = await encodeShare("x".repeat(2_000_000));
    expect(await decodeShare(big)).toBeNull();
  });
});
