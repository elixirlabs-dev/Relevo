import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes } from "@noble/hashes/utils.js";
import { describe, expect, it } from "vitest";
import type { DirectPayout } from "../src/direct-receipt.ts";
import { merkleLeaf, merklePathSides, merkleProof, merkleRoot, merkleVerify } from "../src/merkle.ts";

const enc = (s: string) => new TextEncoder().encode(s);
// Leaves a..h = sha256("leaf-0") .. sha256("leaf-7"); the roots below were computed by hand with Python's
// hashlib: N(l, r) = sha256(0x01 ‖ l ‖ r), an odd node carried up unchanged.
const L = Array.from({ length: 8 }, (_, i) => sha256(enc(`leaf-${i}`)));
const N = (l: Uint8Array, r: Uint8Array) => sha256(concatBytes(Uint8Array.of(1), l, r));
const [a, b, c, d, e, f, g, h] = L;

describe("merkle root", () => {
  it.each([
    [1, "d2dbf006f96dd05044a8f63d8f118f23925ba4cc5750f8b6c8e287fd506c8188", a],
    [2, "c76c1321b98ab0ea04447b38d8daeb85fa04df66731a8f25a60c84a1548d9831", N(a, b)],
    [3, "3fd64e951bb292c4cc9ea78ea50e1115c0b754f0ca8b4a4f4a9610bd2c258877", N(N(a, b), c)],
    [5, "05d1a932e1c8acc9119e8dd9ad1a95f81a03443f90110935d9fc1c862aff9d91", N(N(N(a, b), N(c, d)), e)],
    [
      8,
      "d4f61b1e2303c35f0c89277fcfdd91e9d6631e11d5b6275e44f625f12d1648a6",
      N(N(N(a, b), N(c, d)), N(N(e, f), N(g, h))),
    ],
  ])("of %i leaves matches the hand-computed value", (n, hex, tree) => {
    expect(bytesToHex(merkleRoot(L.slice(0, n)))).toBe(hex);
    expect(bytesToHex(tree)).toBe(hex);
  });

  it("refuses an empty tree", () => {
    expect(() => merkleRoot([])).toThrow();
  });

  it("hashes a payout leaf as sha256(0x00 ‖ canonical JSON)", () => {
    const p: DirectPayout = {
      id: 0,
      payee_ref: "ab".repeat(32),
      account_last4: "7771",
      amount: "37000.00",
      status: "Paid",
      paid_at: "2026-11-14T10:00:00Z",
      reference: "SPEI-REF-0001",
    };
    expect(bytesToHex(merkleLeaf(p))).toBe(
      "75f71f3e1fb0b3aa87e77ebc2e7aa00f8ff12f9d15cce7d3aee725f98fe766e0",
    );
    // Key order doesn't matter: the JSON is canonical.
    const shuffled = Object.fromEntries(Object.entries(p).reverse()) as unknown as DirectPayout;
    expect(bytesToHex(merkleLeaf(shuffled))).toBe(bytesToHex(merkleLeaf(p)));
  });
});

describe("merkle proofs", () => {
  const five = L.slice(0, 5);
  const root = merkleRoot(five);

  it("verify for every index of 5 leaves, with the expected path shape", () => {
    for (let i = 0; i < 5; i++) {
      const p = merkleProof(five, i);
      expect(p.index).toBe(i);
      expect(merkleVerify(five[i], p, root)).toBe(true);
      expect(p.siblings.map((s) => s.side)).toEqual(merklePathSides(i, 5));
    }
    // The odd leaf is carried up twice: its only sibling is the root of the first four.
    expect(merkleProof(five, 4).siblings).toEqual([{ side: "L", hash: bytesToHex(N(N(a, b), N(c, d))) }]);
    expect(merkleProof(five, 0).siblings).toEqual([
      { side: "R", hash: bytesToHex(b) },
      { side: "R", hash: bytesToHex(N(c, d)) },
      { side: "R", hash: bytesToHex(e) },
    ]);
  });

  it("verify for every index of 1, 2, 3 and 8 leaves", () => {
    for (const n of [1, 2, 3, 8]) {
      const leaves = L.slice(0, n);
      for (let i = 0; i < n; i++)
        expect(merkleVerify(leaves[i], merkleProof(leaves, i), merkleRoot(leaves))).toBe(true);
    }
    expect(merkleProof([a], 0).siblings).toEqual([]);
  });

  it("fails with a swapped sibling, a flipped side, another leaf or another root", () => {
    const p = merkleProof(five, 1);
    const swapped = { ...p, siblings: [p.siblings[1], p.siblings[0], ...p.siblings.slice(2)] };
    expect(merkleVerify(five[1], swapped, root)).toBe(false);
    const flipped = {
      ...p,
      siblings: p.siblings.map((s, i) => (i === 0 ? { ...s, side: s.side === "L" ? "R" : "L" } : s)),
    } as typeof p;
    expect(merkleVerify(five[1], flipped, root)).toBe(false);
    expect(merkleVerify(five[2], p, root)).toBe(false);
    expect(merkleVerify(five[1], p, merkleRoot(L.slice(0, 4)))).toBe(false);
  });

  it("fails on malformed siblings instead of throwing", () => {
    const p = merkleProof(five, 0);
    const bad = (s: unknown) => ({ ...p, siblings: [s, ...p.siblings.slice(1)] }) as typeof p;
    expect(merkleVerify(five[0], bad({ side: "X", hash: p.siblings[0].hash }), root)).toBe(false);
    expect(merkleVerify(five[0], bad({ side: "R", hash: "zz" }), root)).toBe(false);
    expect(merkleVerify(five[0], bad(null), root)).toBe(false);
  });

  it("refuses an out-of-range index", () => {
    expect(() => merkleProof(five, 5)).toThrow();
    expect(() => merkleProof(five, -1)).toThrow();
  });
});
