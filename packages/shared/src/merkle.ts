/**
 * Binary SHA-256 Merkle tree over the payouts of an `elivo-direct-receipt-2`. Browser-safe.
 *
 * - Leaf = sha256(0x00 ‖ RFC 8785 canonical JSON of the payout, UTF-8).
 * - Internal node = sha256(0x01 ‖ left ‖ right). The prefixes keep a leaf from passing as a node.
 * - An odd node at any level is carried up unchanged (no duplication). The root of one leaf is the leaf.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hexToBytes } from "@noble/hashes/utils.js";
import canonicalize from "canonicalize";
import type { DirectPayout } from "./direct-receipt.ts";

export interface MerkleSibling {
  side: "L" | "R";
  /** hex */
  hash: string;
}

export interface MerkleProof {
  index: number;
  siblings: MerkleSibling[];
}

const LEAF = Uint8Array.of(0x00);
const NODE = Uint8Array.of(0x01);

export function merkleLeaf(payout: DirectPayout): Uint8Array {
  return sha256(concatBytes(LEAF, new TextEncoder().encode(canonicalize(payout) ?? "")));
}

export function merkleNode(left: Uint8Array, right: Uint8Array): Uint8Array {
  return sha256(concatBytes(NODE, left, right));
}

function nextLevel(level: Uint8Array[]): Uint8Array[] {
  const up: Uint8Array[] = [];
  for (let i = 0; i < level.length; i += 2)
    up.push(i + 1 < level.length ? merkleNode(level[i], level[i + 1]) : level[i]);
  return up;
}

export function merkleRoot(leaves: Uint8Array[]): Uint8Array {
  if (leaves.length === 0) throw new Error("merkle: no leaves");
  let level = leaves;
  while (level.length > 1) level = nextLevel(level);
  return level[0];
}

export function merkleProof(leaves: Uint8Array[], index: number): MerkleProof {
  if (!Number.isInteger(index) || index < 0 || index >= leaves.length)
    throw new Error(`merkle: index ${index} out of range`);
  const siblings: MerkleSibling[] = [];
  let level = leaves;
  let i = index;
  while (level.length > 1) {
    if (i % 2 === 1) siblings.push({ side: "L", hash: bytesToHex(level[i - 1]) });
    else if (i + 1 < level.length) siblings.push({ side: "R", hash: bytesToHex(level[i + 1]) });
    level = nextLevel(level);
    i = Math.floor(i / 2);
  }
  return { index, siblings };
}

/** The sides a proof for `index` must have in a tree of `count` leaves (odd nodes have no sibling). */
export function merklePathSides(index: number, count: number): Array<"L" | "R"> {
  const sides: Array<"L" | "R"> = [];
  let i = index;
  let n = count;
  while (n > 1) {
    if (i % 2 === 1) sides.push("L");
    else if (i + 1 < n) sides.push("R");
    i = Math.floor(i / 2);
    n = Math.ceil(n / 2);
  }
  return sides;
}

const HEX32 = /^[0-9a-f]{64}$/;

export function merkleVerify(leaf: Uint8Array, proof: MerkleProof, root: Uint8Array): boolean {
  if (!proof || !Array.isArray(proof.siblings)) return false;
  let h = leaf;
  for (const s of proof.siblings) {
    if (!s || typeof s.hash !== "string" || !HEX32.test(s.hash)) return false;
    const sib = hexToBytes(s.hash);
    if (s.side === "L") h = merkleNode(sib, h);
    else if (s.side === "R") h = merkleNode(h, sib);
    else return false;
  }
  return bytesToHex(h) === bytesToHex(root);
}
