/**
 * pnpm issue-receipt <results.csv> --id <receipt id> --issuer <account> [--rail SPEI] [--currency MXN] [--pq] [--v2]
 *
 * Issues an elivo-direct-receipt-1 for payouts the issuer already made outside the escrow, on testnet:
 * builds the receipt from the results CSV, signs it with the issuer's receipt key, publishes that key
 * in the receipt registry if needed, and anchors the receipt's hash there.
 *
 * - The issuer account signs with its key in ~/.near-credentials/testnet/<issuer>.json.
 * - The receipt key is .data/keys/receipt-<issuer>.json (created on first use).
 * - With --pq the receipt is also signed with ML-DSA-65 (post-quantum), whose seed is
 *   .data/keys/receipt-mldsa-<issuer>.json; the issuer's key set in the registry then includes that key.
 * - The receipt and its payee salt are written to .data/receipts/. Keep the salt with your records.
 * - With --v2 it issues an elivo-direct-receipt-2 instead: the signatures and the anchored hash cover a
 *   Merkle root over the payouts, and one elivo-payee-proof-1 per payee is written next to the receipt
 *   (<receipt>.payee-<i>.json), to hand to that payee only. The receipt salt is printed once: it is a
 *   secret, keep it.
 *
 * Testnet prototype. Payout firms and SPEI receipts are simulated. Contract unaudited.
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Chain } from "../packages/shared/src/chain.ts";
import { env, loadDeployment } from "../packages/shared/src/config.ts";
import {
  anchorDirectReceipt,
  buildDirectReceipt,
  ensureIssuerKeys,
  parseResultsCsv,
  signDirectReceipt,
} from "../packages/shared/src/direct-issue.ts";
import {
  anchorDirectReceiptV2,
  buildDirectReceiptV2,
  signDirectReceiptV2,
} from "../packages/shared/src/direct-receipt-v2.ts";
import { keyFromSeed, loadKeyFile } from "../packages/shared/src/keys.ts";
import { LABEL } from "../packages/shared/src/label.ts";
import { type MlDsaKey, mldsaFromSeed } from "../packages/shared/src/pq-keys.ts";
import { writeDirectV2Files } from "./lib/direct-v2-files.ts";

function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (!v) {
    console.error(
      "usage: pnpm issue-receipt <results.csv> --id <receipt id> --issuer <account> [--rail SPEI] [--currency MXN] [--pq] [--v2]",
    );
    process.exit(2);
  }
  return v;
}

async function main() {
  console.log(LABEL);
  const file = process.argv[2];
  if (!file || file.startsWith("--")) arg("--missing-file");
  const id = arg("--id");
  const issuerId = arg("--issuer");
  const rail = arg("--rail", "SPEI");
  const currency = arg("--currency", "MXN");

  const d = loadDeployment("deployments/testnet.json");
  if (!d.registry)
    throw new Error("deployments/testnet.json has no registry: run ./scripts/deploy-registry.sh");
  const chain = new Chain({
    rpcUrl: d.rpcUrl,
    network: "testnet",
    fallbackRpcUrls: env({ ELIVO_NETWORK: "testnet" }).rpcFallbacks,
  });

  const { rows, errors } = parseResultsCsv(readFileSync(file, "utf8"), { rail });
  if (errors.length) {
    for (const e of errors) console.error(`row ${e.row}: ${e.reason}`);
    process.exit(1);
  }

  const keyFile = join(".data", "keys", `receipt-${issuerId}.json`);
  if (!existsSync(keyFile)) {
    mkdirSync(join(".data", "keys"), { recursive: true });
    const k = keyFromSeed(randomBytes(32));
    writeFileSync(keyFile, JSON.stringify({ public_key: k.publicKeyStr, secret_key: k.secretKeyStr }), {
      mode: 0o600,
    });
  }
  const receiptKey = loadKeyFile(keyFile);
  let pq: MlDsaKey | undefined;
  if (process.argv.includes("--pq")) {
    const pqFile = join(".data", "keys", `receipt-mldsa-${issuerId}.json`);
    if (!existsSync(pqFile))
      writeFileSync(pqFile, JSON.stringify({ alg: "ml-dsa-65", seed: randomBytes(32).toString("hex") }), {
        mode: 0o600,
      });
    pq = mldsaFromSeed(Buffer.from(JSON.parse(readFileSync(pqFile, "utf8")).seed, "hex"));
  }
  const issuer = chain.signer(
    issuerId,
    loadKeyFile(join(homedir(), ".near-credentials", "testnet", `${issuerId}.json`)),
  );

  const version = await ensureIssuerKeys(chain.view.bind(chain), issuer, d.registry, receiptKey, pq);
  const salt = randomBytes(16);
  const keyLine = `Receipt key version ${version}: ${receiptKey.publicKeyStr}${pq ? " + ML-DSA-65 (post-quantum)" : ""}`;
  const verifyLine = (f: string) =>
    `Verify: pnpm verify-receipt ${f} --chain --rpc ${d.rpcUrl} --registry ${d.registry}`;

  if (process.argv.includes("--v2")) {
    const r2 = signDirectReceiptV2(
      buildDirectReceiptV2(rows, {
        network: "testnet",
        registry: d.registry,
        issuer: issuerId,
        receipt_id: id,
        rail,
        currency,
        salt,
      }),
      receiptKey.seed,
      pq,
    );
    const anchored = await anchorDirectReceiptV2(issuer, d.registry, r2);
    const files = writeDirectV2Files(join(".data", "receipts"), `direct-${issuerId}-${id}`, r2, salt);
    console.log(keyLine);
    console.log(`Anchored ${anchored.hash} (elivo-direct-receipt-2): ${chain.explorerTx(anchored.txHash)}`);
    console.log(`Wrote ${files.receipt}`);
    console.log(
      `Wrote ${files.proofs.length} payee proofs: ${files.proofs[0]} ... (give each payee only theirs)`,
    );
    console.log(
      `Receipt salt (SECRET, keep it with your records; also in ${files.salt}): ${salt.toString("hex")}`,
    );
    console.log(verifyLine(files.receipt));
    return;
  }

  const receipt = signDirectReceipt(
    buildDirectReceipt(rows, {
      network: "testnet",
      registry: d.registry,
      issuer: issuerId,
      receipt_id: id,
      rail,
      currency,
      salt,
    }),
    receiptKey,
    pq,
  );
  const { txHash, hash } = await anchorDirectReceipt(issuer, d.registry, receipt);

  mkdirSync(join(".data", "receipts"), { recursive: true });
  const out = join(".data", "receipts", `direct-${issuerId}-${id}.json`);
  writeFileSync(out, `${JSON.stringify(receipt, null, 2)}\n`);
  writeFileSync(join(".data", "receipts", `direct-${issuerId}-${id}.salt`), `${salt.toString("hex")}\n`);
  console.log(keyLine);
  console.log(`Anchored ${hash}: ${chain.explorerTx(txHash)}`);
  console.log(`Wrote ${out}`);
  console.log(verifyLine(out));
}

main().catch((e) => {
  console.error(`FAIL: ${(e as Error).message}`);
  process.exit(1);
});
