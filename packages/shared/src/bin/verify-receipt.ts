/**
 * verify-receipt <file> --pubkey <ed25519:...>
 * verify-receipt <file> --chain --rpc <url> --escrow <account>      (a batch receipt, elivo-receipt-1)
 * verify-receipt <file> --chain --rpc <url> --registry <account>    (a direct receipt, elivo-direct-receipt-1)
 * Prints OK (exit 0) or FAIL: <reason> (exit 1). A key embedded in the file is never trusted alone.
 */
import { readFileSync } from "node:fs";
import { type DirectReceipt, directTotalsProblems, isDirectReceipt } from "../direct-receipt.ts";
import { directHashB58Web, type IssuerKeys, verifyDirectSignaturesWeb } from "../direct-verify-web.ts";
import { type Receipt, receiptHashB58, verifyReceipt } from "../receipt.ts";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(reason: string): never {
  console.log(`FAIL: ${reason}`);
  process.exit(1);
}

async function main() {
  const file = process.argv[2];
  if (!file || file.startsWith("--")) {
    console.error(
      "usage: verify-receipt <file> (--pubkey <ed25519:...> | --chain --rpc <url> --escrow <id>)",
    );
    process.exit(2);
  }
  let receipt: Receipt;
  try {
    receipt = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    fail("unreadable");
  }
  if (isDirectReceipt(receipt)) return verifyDirect(receipt);
  let expected = arg("--pubkey");
  let anchored: string | null | undefined;
  if (process.argv.includes("--chain")) {
    const rpc = arg("--rpc");
    const escrow = arg("--escrow");
    if (!escrow) fail("--chain needs --escrow (the file's escrow is not trusted)");
    if (!rpc) fail("missing --rpc");
    const { Chain } = await import("../chain.ts");
    const chain = new Chain({ rpcUrl: rpc as string, network: "testnet" });
    const batch = await chain.view<{ receipt_pk: string; receipt_hash: string | null } | null>(
      escrow,
      "get_batch",
      {
        batch_id: receipt.batch_id,
      },
    );
    if (!batch) fail("unknown_batch");
    expected = batch.receipt_pk;
    anchored = batch.receipt_hash;
  }
  if (!expected) fail("no expected public key (use --pubkey or --chain)");
  const v = verifyReceipt(receipt, expected);
  if (!v.ok) fail(v.reason);
  if (anchored !== undefined) {
    if (!anchored) fail("not_anchored");
    if (anchored !== receiptHashB58(receipt)) fail("hash_mismatch");
  }
  console.log("OK");
}

async function verifyDirect(r: DirectReceipt) {
  const rpc = arg("--rpc");
  const registry = arg("--registry");
  const pubkey = arg("--pubkey");
  let keys: IssuerKeys | undefined;
  let anchored: string | undefined;
  if (process.argv.includes("--chain")) {
    if (!registry) fail("--chain needs --registry (the file's registry is not trusted)");
    if (!rpc) fail("missing --rpc");
    if (r.registry !== registry) fail(`wrong_registry: the receipt is for ${r.registry}, not ${registry}`);
    const { Chain } = await import("../chain.ts");
    const chain = new Chain({ rpcUrl: rpc, network: "testnet" });
    const a = await chain.view<(IssuerKeys & { receipt_hash: string }) | null>(registry, "get_receipt", {
      issuer: r.issuer,
      receipt_id: r.receipt_id,
    });
    if (!a) fail("not_anchored");
    keys = a;
    anchored = a.receipt_hash;
  } else if (pubkey) {
    if (r.signatures.some((x) => x.alg === "ml-dsa-65"))
      fail("post-quantum receipt: use --chain, so the ML-DSA-65 key comes from the registry");
    keys = { receipt_pk: pubkey };
  }
  if (!keys) fail("no expected public key (use --pubkey or --chain)");
  const v = await verifyDirectSignaturesWeb(r, keys);
  if (!v.ok) fail(v.reason);
  if (anchored !== undefined && anchored !== (await directHashB58Web(r))) fail("hash_mismatch");
  if (directTotalsProblems(r).length) fail("totals_mismatch");
  console.log("OK");
}

main().catch((e) => fail(`error: ${(e as Error).message}`));
