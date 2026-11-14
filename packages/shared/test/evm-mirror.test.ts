import { privateKeyToAccount } from "viem/accounts";
import { describe, expect, it } from "vitest";
import {
  childSk,
  type FixtureOpts,
  signedMirrorTx,
  testRootKey,
} from "../../../scripts/lib/mirror-fixture.ts";
import {
  deriveEvmAddress,
  MIRROR_PATH,
  mirrorCalldata,
  parseMirrorCalldata,
  recoverMirrorSender,
  rlpEncode,
  SEPOLIA_CHAIN_ID,
  SEPOLIA_RPCS,
  sepoliaRpc,
  TESTNET_MPC_ROOT,
  unsignedType2Payload,
  upsertMirror,
  verifyMirrorTx,
} from "../src/evm-mirror.ts";

const ISSUER = "payroll.pg-1794403941.testnet";
const RID = "payroll-2026-11-v2";
const HASH = "8Q4kyb3Wq3oGTVzT5jK3w9d1nqQ7Tgq8f2k8ZpN1x4uY";
// Checked against the signer contract's derived_public_key view for this account and path.
const ADDRESS = "0xd58bd0be27a98d505c73bb4e24722cacf4342f8e";

// Signed transactions need a private key, so verifyMirrorTx is tested against a test MPC root key.
const ROOT = testRootKey();
const DERIVED = deriveEvmAddress(ROOT, ISSUER, MIRROR_PATH);
const OTHER_SK = 0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdefn;
const OTHER = privateKeyToAccount(`0x${OTHER_SK.toString(16).padStart(64, "0")}`).address.toLowerCase();
const expected = { issuer: ISSUER, receipt_id: RID, receipt_hash: HASH, rootKey: ROOT };
const signed = (o: Partial<FixtureOpts> = {}) =>
  signedMirrorTx({ issuer: ISSUER, receiptId: RID, receiptHash: HASH, ...o });

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

describe("rlpEncode", () => {
  // Vectors from the Ethereum RLP spec.
  const b = (s: string) => new TextEncoder().encode(s);
  const hex = (u: Uint8Array) => Buffer.from(u).toString("hex");
  it("encodes bytes and lists", () => {
    expect(hex(rlpEncode(b("dog")))).toBe("83646f67");
    expect(hex(rlpEncode([b("cat"), b("dog")]))).toBe("c88363617483646f67");
    expect(hex(rlpEncode(new Uint8Array()))).toBe("80");
    expect(hex(rlpEncode([]))).toBe("c0");
    expect(hex(rlpEncode(new Uint8Array([0x0f])))).toBe("0f");
    expect(hex(rlpEncode(new Uint8Array([0x04, 0x00])))).toBe("820400");
    expect(hex(rlpEncode([[], [[]], [[], [[]]]]))).toBe("c7c0c1c0c3c0c1c0");
    const long = b("Lorem ipsum dolor sit amet, consectetur adipisicing elit");
    expect(hex(rlpEncode(long)).slice(0, 4)).toBe("b838");
  });
});

describe("recoverMirrorSender", () => {
  it("recovers the signer of a real signed type-2 transaction (signed locally with viem)", async () => {
    const tx = await signed({ signerSk: OTHER_SK });
    expect(recoverMirrorSender(tx)).toBe(OTHER);
    expect(recoverMirrorSender(await signed())).toBe(DERIVED);
  });

  it("rebuilds the exact unsigned payload the signer hashed (with an access list too)", async () => {
    const tx = await signed();
    expect(Buffer.from(unsignedType2Payload(tx)).toString("hex").slice(0, 2)).toBe("02");
    const withList = {
      ...tx,
      accessList: [{ address: OTHER, storageKeys: [`0x${"00".repeat(31)}01`] }],
    };
    // A different access list is a different payload, so the same signature recovers someone else.
    expect(recoverMirrorSender(withList)).not.toBe(DERIVED);
  });

  it("does not trust the RPC's `from`", async () => {
    const tx = await signed({ signerSk: OTHER_SK });
    expect(recoverMirrorSender({ ...tx, from: DERIVED })).toBe(OTHER);
  });

  it("refuses anything that is not a type-2 transaction", async () => {
    const tx = await signed();
    for (const type of ["0x0", "0x1", "0x3", undefined])
      expect(() => recoverMirrorSender({ ...tx, type })).toThrow(/type 2/);
  });
});

describe("verifyMirrorTx", () => {
  it("the test root key behaves like the real one: the child key signs for the derived address", () => {
    expect(
      privateKeyToAccount(`0x${childSk(ISSUER).toString(16).padStart(64, "0")}`).address.toLowerCase(),
    ).toBe(DERIVED);
  });

  it("accepts a mined self-send on Sepolia signed for the derived address, carrying the anchored hash", async () => {
    expect(SEPOLIA_CHAIN_ID).toBe(11155111);
    const v = verifyMirrorTx(await signed(), expected);
    expect(v).toMatchObject({ ok: true, problems: [], expectedFrom: DERIVED, recoveredFrom: DERIVED });
    expect(v.checks).toEqual({
      type2: true,
      from: true,
      selfSend: true,
      payload: true,
      chain: true,
      included: true,
    });
  });

  it("flags a transaction signed by another key, even when the RPC claims the derived `from`", async () => {
    const tx = await signed({ signerSk: OTHER_SK });
    const v = verifyMirrorTx({ ...tx, from: DERIVED }, expected);
    expect(v.ok).toBe(false);
    expect(v.checks.from).toBe(false);
    expect(v.recoveredFrom).toBe(OTHER);
    expect(v.problems).toContain(`Signed by ${OTHER}, not ${DERIVED}, the address derived for ${ISSUER}`);
  });

  it("flags calldata swapped after signing (the signature then recovers someone else)", async () => {
    const tx = await signed();
    const v = verifyMirrorTx({ ...tx, input: mirrorCalldata(ISSUER, RID, "OtherHash") }, expected);
    expect(v.checks.from).toBe(false);
    expect(v.checks.payload).toBe(false);
  });

  it("flags a transaction that is not a self-send", async () => {
    const to = "0x2222222222222222222222222222222222222222";
    const v = verifyMirrorTx(await signed({ to }), expected);
    expect(v.checks).toMatchObject({ from: true, selfSend: false });
    expect(v.problems).toContain(`Sent to ${to}, not back to itself`);
  });

  it("flags a contract creation (no recipient)", async () => {
    const v = verifyMirrorTx(await signed({ to: null }), expected);
    expect(v.checks.selfSend).toBe(false);
    expect(v.problems).toContain("Sent to no address, not back to itself");
  });

  it("flags a different hash, issuer or receipt id in the calldata", async () => {
    for (const data of [
      mirrorCalldata(ISSUER, RID, "OtherHash"),
      mirrorCalldata("someone.testnet", RID, HASH),
      mirrorCalldata(ISSUER, "payroll-2026-10", HASH),
    ]) {
      const v = verifyMirrorTx(await signed({ data }), expected);
      expect(v.ok).toBe(false);
      expect(v.checks).toMatchObject({ from: true, selfSend: true, payload: false, chain: true });
    }
    const v = verifyMirrorTx(await signed({ data: mirrorCalldata(ISSUER, RID, "OtherHash") }), expected);
    expect(v.problems).toContain(`Carries ${ISSUER}/${RID}:OtherHash, not ${ISSUER}/${RID}:${HASH}`);
  });

  it("flags calldata that is not a mirror record", async () => {
    const v = verifyMirrorTx(await signed({ data: "0x" }), expected);
    expect(v.checks.payload).toBe(false);
    expect(v.problems).toContain("The transaction data is not an elivo-mirror-1 record");
  });

  it("flags another chain", async () => {
    const v = verifyMirrorTx(await signed({ chainId: 1 }), expected);
    expect(v.checks).toMatchObject({ from: true, chain: false });
    expect(v.problems).toContain("On chain 1, not Ethereum Sepolia (11155111)");
  });

  it("flags a pending transaction", async () => {
    const v = verifyMirrorTx(await signed({ blockNumber: null }), expected);
    expect(v.ok).toBe(false);
    expect(v.checks).toMatchObject({ from: true, payload: true, included: false });
    expect(v.problems).toContain("Not yet included in a block");
  });

  it("refuses a transaction that is not type 2", async () => {
    const v = verifyMirrorTx({ ...(await signed()), type: "0x0" }, expected);
    expect(v.ok).toBe(false);
    expect(v.recoveredFrom).toBeNull();
    expect(v.checks).toMatchObject({ type2: false, from: false });
    expect(v.problems).toContain("Not an EIP-1559 (type 2) transaction, so its sender can't be checked");
  });

  it("with the real testnet root key, the issuer's address is 0xd58b…2f8e", () => {
    expect(deriveEvmAddress(TESTNET_MPC_ROOT, ISSUER, MIRROR_PATH)).toBe(ADDRESS);
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
