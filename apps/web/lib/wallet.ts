"use client";
/**
 * Wallet Selector core with three testnet wallets and our own buttons (modal-ui pins React 18):
 * MyNearWallet and Intear (web wallets) and Sender (browser extension).
 * Left out: Meteor (its selector module pins an SDK that needs near-api-js 6) and HERE (it pulls in an
 * old copy of the @near-js packages).
 */
import { actionCreators } from "@near-js/transactions";
import { setupWalletSelector, type WalletSelector } from "@near-wallet-selector/core";
import { setupIntearWallet } from "@near-wallet-selector/intear-wallet";
import { setupMyNearWallet } from "@near-wallet-selector/my-near-wallet";
import { setupSender } from "@near-wallet-selector/sender";
import type { WalletPort } from "./signer.ts";
import type { TxSpec } from "./txs.ts";

let selector: Promise<WalletSelector> | null = null;

function getSelector(): Promise<WalletSelector> {
  selector ??= setupWalletSelector({
    network: "testnet",
    modules: [setupMyNearWallet(), setupIntearWallet(), setupSender()],
  });
  return selector;
}

export const WALLETS = [
  { id: "my-near-wallet", name: "MyNearWallet" },
  { id: "intear-wallet", name: "Intear Wallet" },
  { id: "sender", name: "Sender" },
] as const;

export async function walletPort(): Promise<WalletPort> {
  const s = await getSelector();
  return {
    accountId: () => s.store.getState().accounts.find((a) => a.active)?.accountId ?? null,
    signIn: async (walletId) => {
      const w = await s.wallet(walletId);
      // Browser wallets take optional params; the union type wants hardware-wallet fields too.
      await (w.signIn as (p: object) => Promise<unknown>)({});
    },
    send: async (tx: TxSpec) => {
      const w = await s.wallet();
      await w.signAndSendTransaction({
        receiverId: tx.receiverId,
        actions: tx.actions.map((a) =>
          actionCreators.functionCall(
            a.params.methodName,
            a.params.args,
            BigInt(a.params.gas),
            BigInt(a.params.deposit),
          ),
        ),
      });
    },
  };
}

export async function signOut(): Promise<void> {
  const s = await getSelector();
  if (s.isSignedIn()) await (await s.wallet()).signOut();
}
