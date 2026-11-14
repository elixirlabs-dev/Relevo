import { describe, expect, it } from "vitest";
import {
  deriveEvmAddress,
  MIRROR_PATH,
  mirrorCalldata,
  parseMirrorCalldata,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_RPCS,
  sepoliaRpc,
  TESTNET_MPC_ROOT,
  upsertMirror,
  verifyMirrorTx,
} from "../src/evm-mirror.ts";

const ISSUER = "payroll.pg-1794403941.testnet";
const RID = "payroll-2026-11-v2";
const HASH = "8Q4kyb3Wq3oGTVzT5jK3w9d1nqQ7Tgq8f2k8ZpN1x4uY";
// Checked against the signer contract's derived_public_key view for this account and path.
const ADDRESS = "0xd58bd0be27a98d505c73bb4e24722cacf4342f8e";

const expected = { issuer: ISSUER, receipt_id: RID, receipt_hash: HASH, rootKey: TESTNET_MPC_ROOT };
const goodTx = () => ({
  from: ADDRESS,
  to: ADDRESS,
  input: mirrorCalldata(ISSUER, RID, HASH),
  chainId: "0xaa36a7",
});

describe("deriveEvmAddress", () => {
  it("derives the issuer's Ethereum address from the testnet MPC root key", () => {
    expect(MIRROR_PATH).toBe("elivo-receipt-mirror");
    expect(deriveEvmAddress(TESTNET_MPC_ROOT, ISSUER, MIRROR_PATH)).toBe(ADDRESS);
  });

  it("gives another address for another account or path", () => {
    expect(deriveEvmAddress(TESTNET_MPC_ROOT, "someone.testnet", MIRROR_PATH)).not.toBe(ADDRESS);
    expect(deriveEvmAddress(TESTNET_MPC_ROOT, ISSUER, "other-path")).not.toBe(ADDRESS);
  });

  it("rejects a root key that is not secp256k1", () => {
    expect(() => deriveEvmAddress("ed25519:abc", ISSUER, MIRROR_PATH)).toThrow(/secp256k1/);
  });
});

describe("mirror calldata", () => {
  it("is the hex of elivo-mirror-1:<issuer>/<receipt_id>:<hash>", () => {
    const hex = mirrorCalldata(ISSUER, RID, HASH);
    expect(hex.startsWith("0x")).toBe(true);
    expect(Buffer.from(hex.slice(2), "hex").toString("utf8")).toBe(`elivo-mirror-1:${ISSUER}/${RID}:${HASH}`);
  });

  it("round-trips", () => {
    expect(parseMirrorCalldata(mirrorCalldata(ISSUER, RID, HASH))).toEqual({
      issuer: ISSUER,
      receipt_id: RID,
      receipt_hash: HASH,
    });
  });

  it("keeps a receipt id with a slash in it", () => {
    expect(parseMirrorCalldata(mirrorCalldata(ISSUER, "a/b", HASH))?.receipt_id).toBe("a/b");
  });

  it("parses anything else to null", () => {
    expect(parseMirrorCalldata("0x")).toBeNull();
    expect(parseMirrorCalldata("0xzz")).toBeNull();
    expect(parseMirrorCalldata(`0x${Buffer.from("hello").toString("hex")}`)).toBeNull();
    expect(
      parseMirrorCalldata(`0x${Buffer.from(`elivo-mirror-1:${ISSUER}:${HASH}`).toString("hex")}`),
    ).toBeNull();
  });
});

describe("verifyMirrorTx", () => {
  it("accepts a self-send on Sepolia from the derived address carrying the anchored hash", () => {
    expect(SEPOLIA_CHAIN_ID).toBe(11155111);
    const v = verifyMirrorTx(goodTx(), expected);
    expect(v).toMatchObject({ ok: true, problems: [], expectedFrom: ADDRESS });
    expect(v.checks).toEqual({ from: true, selfSend: true, payload: true, chain: true });
  });

  it("compares addresses without regard to case", () => {
    const up = `0x${ADDRESS.slice(2).toUpperCase()}`;
    expect(verifyMirrorTx({ ...goodTx(), from: up, to: up }, expected).ok).toBe(true);
  });

  it("flags a sender that is not the issuer's derived address", () => {
    const other = "0x1111111111111111111111111111111111111111";
    const v = verifyMirrorTx({ ...goodTx(), from: other, to: other }, expected);
    expect(v.ok).toBe(false);
    expect(v.checks.from).toBe(false);
    expect(v.problems).toContain(`Sent from ${other}, not ${ADDRESS}, the address derived for ${ISSUER}`);
  });

  it("flags a transaction that is not a self-send", () => {
    const v = verifyMirrorTx({ ...goodTx(), to: "0x2222222222222222222222222222222222222222" }, expected);
    expect(v.checks).toMatchObject({ from: true, selfSend: false });
    expect(v.problems).toContain("Sent to 0x2222222222222222222222222222222222222222, not back to itself");
  });

  it("flags a contract creation (no recipient)", () => {
    const v = verifyMirrorTx({ ...goodTx(), to: null }, expected);
    expect(v.checks.selfSend).toBe(false);
    expect(v.problems).toContain("Sent to no address, not back to itself");
  });

  it("flags a different hash, issuer or receipt id in the calldata", () => {
    for (const input of [
      mirrorCalldata(ISSUER, RID, "OtherHash"),
      mirrorCalldata("someone.testnet", RID, HASH),
      mirrorCalldata(ISSUER, "payroll-2026-10", HASH),
    ]) {
      const v = verifyMirrorTx({ ...goodTx(), input }, expected);
      expect(v.ok).toBe(false);
      expect(v.checks).toMatchObject({ from: true, selfSend: true, payload: false, chain: true });
    }
    expect(
      verifyMirrorTx({ ...goodTx(), input: mirrorCalldata(ISSUER, RID, "OtherHash") }, expected).problems,
    ).toContain(`Carries ${ISSUER}/${RID}:OtherHash, not ${ISSUER}/${RID}:${HASH}`);
  });

  it("flags calldata that is not a mirror record", () => {
    const v = verifyMirrorTx({ ...goodTx(), input: "0x" }, expected);
    expect(v.checks.payload).toBe(false);
    expect(v.problems).toContain("The transaction data is not an elivo-mirror-1 record");
  });

  it("flags another chain, or no chain id", () => {
    const main = verifyMirrorTx({ ...goodTx(), chainId: "0x1" }, expected);
    expect(main.checks.chain).toBe(false);
    expect(main.problems).toContain("On chain 1, not Ethereum Sepolia (11155111)");
    const none = verifyMirrorTx({ ...goodTx(), chainId: undefined }, expected);
    expect(none.checks.chain).toBe(false);
    expect(none.problems).toContain(
      "The transaction names no chain id, so it is not bound to Ethereum Sepolia",
    );
  });
});

describe("upsertMirror", () => {
  const e = (issuer: string, receipt_id: string, tx_hash = "0x1") => ({
    issuer,
    receipt_id,
    receipt_hash: "H",
    chain: "sepolia" as const,
    tx_hash,
    from: ADDRESS,
  });

  it("adds an entry and keeps the list sorted by issuer, then receipt id", () => {
    const list = upsertMirror([e("b.testnet", "1"), e("a.testnet", "2")], e("a.testnet", "1"));
    expect(list.map((m) => `${m.issuer}/${m.receipt_id}`)).toEqual([
      "a.testnet/1",
      "a.testnet/2",
      "b.testnet/1",
    ]);
  });

  it("replaces the entry for the same issuer and receipt id", () => {
    const list = upsertMirror([e("a.testnet", "1", "0xold")], e("a.testnet", "1", "0xnew"));
    expect(list).toEqual([e("a.testnet", "1", "0xnew")]);
  });
});

describe("sepoliaRpc", () => {
  type Call = { url: string; body: { method: string; params: unknown[] } };
  const fakeFetch = (answers: Record<string, () => Response>, calls: Call[]) =>
    (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return answers[url]();
    }) as unknown as typeof fetch;
  const ok = (result: unknown) => () => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));

  it("posts a JSON-RPC call to the first RPC", async () => {
    const calls: Call[] = [];
    const r = await sepoliaRpc("eth_getBalance", ["0xabc", "latest"], {
      fetch: fakeFetch({ [SEPOLIA_RPCS[0]]: ok("0x10") }, calls),
    });
    expect(r).toBe("0x10");
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toMatchObject({ method: "eth_getBalance", params: ["0xabc", "latest"] });
  });

  it("falls back to the second RPC when the first fails", async () => {
    const calls: Call[] = [];
    const r = await sepoliaRpc("eth_chainId", [], {
      fetch: fakeFetch(
        { [SEPOLIA_RPCS[0]]: () => new Response("busy", { status: 503 }), [SEPOLIA_RPCS[1]]: ok("0xaa36a7") },
        calls,
      ),
    });
    expect(r).toBe("0xaa36a7");
    expect(calls.map((c) => c.url)).toEqual([...SEPOLIA_RPCS]);
  });

  it("throws the last error when every RPC fails", async () => {
    const err = () =>
      new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { message: "nonce too low" } }));
    await expect(
      sepoliaRpc("eth_sendRawTransaction", ["0x"], {
        fetch: fakeFetch({ [SEPOLIA_RPCS[0]]: err, [SEPOLIA_RPCS[1]]: err }, []),
      }),
    ).rejects.toThrow(/eth_sendRawTransaction: nonce too low/);
  });
});
