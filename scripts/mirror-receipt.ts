/**
 * pnpm mirror-receipt --issuer <account> --id <receipt id>
 *
 * Mirrors a receipt's anchor onto Ethereum Sepolia with NEAR Chain Signatures: the issuer's NEAR testnet
 * account asks NEAR's MPC network (v1.signer-prod.testnet) to sign a 0-value Sepolia self-send whose data
 * is `elivo-mirror-1:<issuer>/<receipt_id>:<anchored hash>`. Anyone can then check that the Ethereum
 * sender is the address the MPC network derives for that NEAR account, from public data only.
 *
 * - Reads the anchored hash from the receipt registry in deployments/testnet.json (never from a file).
 * - The issuer signs the NEAR call with its key in ~/.near-credentials/testnet/<issuer>.json.
 * - The derived Ethereum address pays Sepolia gas: fund it with Sepolia ETH first (the script says which).
 * - Appends the mirror to apps/web/public/receipts/mirrors.json, which /verify reads.
 *
 * Testnet prototype. Payout firms and SPEI receipts are simulated. Contract unaudited.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Chain } from "../packages/shared/src/chain.ts";
import { env, loadDeployment } from "../packages/shared/src/config.ts";
import {
  deriveEvmAddress,
  MIRROR_PATH,
  type MirrorEntry,
  mirrorCalldata,
  SEPOLIA_CHAIN_ID,
  sepoliaRpc,
  sepoliaTxUrl,
  TESTNET_MPC_ROOT,
  TESTNET_MPC_SIGNER,
  upsertMirror,
  verifyMirrorTx,
} from "../packages/shared/src/evm-mirror.ts";
import { loadKeyFile } from "../packages/shared/src/keys.ts";
import { LABEL } from "../packages/shared/src/label.ts";
import { requestMpcSignature } from "../packages/shared/src/mpc-sign.ts";
import {
  assembleSignedTx,
  buildMirrorTx,
  mirrorSigningHash,
  recoverSigner,
  signatureFromMpc,
} from "./lib/mirror-tx.ts";

const MIRRORS = join("apps", "web", "public", "receipts", "mirrors.json");

function arg(name: string): string {
  const i = process.argv.indexOf(name);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v) {
    console.error("usage: pnpm mirror-receipt --issuer <account> --id <receipt id>");
    process.exit(2);
  }
  return v;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const eth = (wei: bigint) => `${(Number(wei) / 1e18).toFixed(6)} Sepolia ETH`;

async function main() {
  console.log(LABEL);
  const issuerId = arg("--issuer");
  const receiptId = arg("--id");

  const d = loadDeployment("deployments/testnet.json");
  if (!d.registry) throw new Error("deployments/testnet.json has no registry");
  const chain = new Chain({
    rpcUrl: d.rpcUrl,
    network: "testnet",
    fallbackRpcUrls: env({ ELIVO_NETWORK: "testnet" }).rpcFallbacks,
  });

  const anchor = await chain.view<{ receipt_hash: string } | null>(d.registry, "get_receipt", {
    issuer: issuerId,
    receipt_id: receiptId,
  });
  if (!anchor) throw new Error(`${issuerId} has not anchored ${receiptId} in ${d.registry}`);
  console.log(`Anchored hash on NEAR: ${anchor.receipt_hash}`);

  // The root key in this repo must be the one the signer contract uses, or the derived address is wrong.
  const root = await chain.view<string>(TESTNET_MPC_SIGNER, "public_key", {});
  if (root !== TESTNET_MPC_ROOT)
    throw new Error(`${TESTNET_MPC_SIGNER} root key is ${root}, not ${TESTNET_MPC_ROOT}`);
  const from = deriveEvmAddress(TESTNET_MPC_ROOT, issuerId, MIRROR_PATH);
  console.log(`Ethereum address NEAR's MPC network derives for ${issuerId} (path ${MIRROR_PATH}): ${from}`);

  const chainId = Number(BigInt(await sepoliaRpc<string>("eth_chainId", [])));
  if (chainId !== SEPOLIA_CHAIN_ID) throw new Error(`the Sepolia RPC answers for chain ${chainId}`);
  const balance = BigInt(await sepoliaRpc<string>("eth_getBalance", [from, "latest"]));
  if (balance === 0n) throw new Error(`fund ${from} with Sepolia ETH, then run this again`);

  const nonce = Number(BigInt(await sepoliaRpc<string>("eth_getTransactionCount", [from, "pending"])));
  const block = await sepoliaRpc<{ baseFeePerGas: string }>("eth_getBlockByNumber", ["latest", false]);
  const tip = BigInt(await sepoliaRpc<string>("eth_maxPriorityFeePerGas", []));
  const tx = buildMirrorTx({
    from,
    data: mirrorCalldata(issuerId, receiptId, anchor.receipt_hash),
    nonce,
    maxPriorityFeePerGas: tip,
    maxFeePerGas: BigInt(block.baseFeePerGas) * 2n + tip,
  });
  const maxCost = (tx.gas ?? 0n) * (tx.maxFeePerGas ?? 0n);
  if (balance < maxCost)
    throw new Error(
      `fund ${from} with Sepolia ETH: it holds ${eth(balance)}, the transaction may cost ${eth(maxCost)}`,
    );

  const hash = mirrorSigningHash(tx);
  console.log(`Asking ${TESTNET_MPC_SIGNER} to sign ${hash} as ${issuerId} (this can take a minute)…`);
  const issuer = chain.account(
    issuerId,
    loadKeyFile(join(homedir(), ".near-credentials", "testnet", `${issuerId}.json`)),
  );
  const mpc = await requestMpcSignature(issuer, {
    signerId: TESTNET_MPC_SIGNER,
    payloadHex: hash.slice(2),
    path: MIRROR_PATH,
  });
  console.log(`Signed on NEAR: ${chain.explorerTx(mpc.txHash)}`);

  const sig = signatureFromMpc(mpc.value);
  const signer = await recoverSigner(hash, sig);
  if (signer !== from)
    throw new Error(`the MPC signature recovers to ${signer}, not ${from}: not broadcasting`);
  const raw = assembleSignedTx(tx, sig);

  const txHash = await sepoliaRpc<string>("eth_sendRawTransaction", [raw]);
  console.log(`Sent on Sepolia: ${txHash}`);
  let mined: { status: string } | null = null;
  for (let i = 0; i < 40 && !mined; i++) {
    await wait(3_000);
    mined = await sepoliaRpc<{ status: string } | null>("eth_getTransactionReceipt", [txHash]).catch(
      () => null,
    );
  }
  if (!mined) throw new Error(`${txHash} is not mined after 2 minutes: check ${sepoliaTxUrl(txHash)}`);
  if (mined.status !== "0x1") throw new Error(`${txHash} failed on Sepolia: ${sepoliaTxUrl(txHash)}`);

  // Check what the chain now holds, the same way /verify will.
  const onChain = await sepoliaRpc<{ from: string; to: string | null; input: string; chainId?: string }>(
    "eth_getTransactionByHash",
    [txHash],
  );
  const v = verifyMirrorTx(onChain, {
    issuer: issuerId,
    receipt_id: receiptId,
    receipt_hash: anchor.receipt_hash,
    rootKey: TESTNET_MPC_ROOT,
  });
  if (!v.ok) throw new Error(`the mined transaction does not check out: ${v.problems.join("; ")}`);

  const entry: MirrorEntry = {
    issuer: issuerId,
    receipt_id: receiptId,
    receipt_hash: anchor.receipt_hash,
    chain: "sepolia",
    tx_hash: txHash,
    from,
  };
  const list = existsSync(MIRRORS) ? (JSON.parse(readFileSync(MIRRORS, "utf8")) as MirrorEntry[]) : [];
  writeFileSync(MIRRORS, `${JSON.stringify(upsertMirror(list, entry), null, 2)}\n`);
  console.log(`Mirrored on Ethereum Sepolia: ${sepoliaTxUrl(txHash)}`);
  console.log(`Wrote ${MIRRORS}`);
}

main().catch((e) => {
  console.error(`FAIL: ${(e as Error).message}`);
  process.exit(1);
});
