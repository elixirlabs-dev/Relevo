import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { DaoVote } from "../components/DaoVote.tsx";
import type { WebConfig } from "../lib/config.ts";

let signedIn: string | null = null;
const signIn = vi.fn(async (id: string) => {
  if (id === "sender") throw new Error("Sender is not installed");
  if (id === "intear-wallet") signedIn = "alice.testnet"; // a popup wallet: no page reload
});
vi.mock("../lib/wallet.ts", () => ({
  WALLETS: [
    { id: "meteor-wallet", name: "Meteor Wallet" },
    { id: "intear-wallet", name: "Intear Wallet" },
    { id: "sender", name: "Sender" },
  ],
  walletPort: async () => ({ accountId: () => signedIn, signIn, send: async () => {} }),
}));

const cfg: WebConfig = {
  network: "testnet",
  escrow: "escrow.t",
  dao: "dao.t",
  usdc: "usdc.t",
  council: "council.t",
  router: "router.t",
  firms: { mx1: "mx1.t", mx2: "mx2.t", mx3: "mx3.t" },
  signer: "wallet",
  routerAvailable: true,
  explorer: null,
  rpcUrl: "http://127.0.0.1:3030",
  registry: null,
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("offers every wallet, signs in with the one chosen, and shows why a wallet could not connect", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({}, { status: 404 })),
  );
  render(<DaoVote draftId="d-1" cfg={cfg} funded={false} pollMs={60_000} />);
  for (const name of ["Meteor Wallet", "Intear Wallet", "Sender"])
    expect(await screen.findByRole("button", { name: `Connect ${name}` })).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Connect Sender" }));
  expect(await screen.findByText("Sender: Sender is not installed")).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Connect Intear Wallet" }));
  expect(signIn).toHaveBeenCalledWith("intear-wallet");
  // Signed in without a reload: the page picks up the account and the connect buttons go away.
  await waitFor(() => expect(screen.queryByRole("button", { name: "Connect Intear Wallet" })).toBeNull());
});
