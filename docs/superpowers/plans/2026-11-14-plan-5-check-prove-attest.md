# Plan 5: Check before, prove after, attest on NEAR

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Three additions to Relevo Payout Guard: (1) check a payout batch before money moves and anchor that check; (2) receipt v2, where each payee gets a private link that proves their own row without seeing anyone else's; (3) anyone with a NEAR wallet (an auditor, donor or DAO member) can attest on-chain that they checked a receipt.

**Architecture:** All checking, signing, hashing and Merkle work runs in the browser (and in the Node CLI) from `packages/shared`. The registry contract (`contracts/registry`) gains attestations. The web app (`apps/web`, Next.js 16) gets `/check` and `/payee`; `/issue` and `/verify` are extended. Names and account numbers never leave the browser; only hashes go on-chain.

**Tech Stack:** TypeScript (tsc 7, biome 2.6, vitest 5), @noble/hashes, @noble/curves, @noble/post-quantum, canonicalize (RFC 8785), Next.js 16, Wallet Selector, near-sdk 5.30 (Rust).

**Spec:** none on disk. This plan is the binding description, approved in chat on 2026-11-14. Rulings made without a spec are provisional.

## Global Constraints

- The label constant `LABEL` from `packages/shared/src/label.ts` ("Testnet prototype. Payout firms and SPEI receipts are simulated. Contract unaudited.") stays on every screen. New signed documents carry it in a `label` field.
- No personal data on-chain or in any server request: names and account numbers stay in the browser. Documents use salted `payee_ref` hashes and `account_last4` only.
- The home page never uses the word "guarantee".
- No business-plan content, customer or competitor names, keys, or local paths in the repo.
- Existing receipts keep verifying: `elivo-receipt-1` (escrow batch 5) and `elivo-direct-receipt-1` (both files in `apps/web/public/receipts/`). No change to their formats.
- Canonical JSON is RFC 8785 via `canonicalize`; hashes are SHA-256; signatures are ed25519, plus ML-DSA-65 (context "elivo-direct-receipt-1" as today, via `packages/shared/src/pq-keys.ts`) when the issuer's on-chain key set has an ML-DSA key. Keys always come from the registry on-chain, never from the file.
- Every commit message ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Gate before each commit: `pnpm lint && pnpm typecheck && pnpm test` all pass. Contract tasks also run `cargo test -p elivo-registry`; `make wasm` refreshes `contracts/res/*.wasm` when the contract changes.
- Copy style: plain English, short sentences, no hype. Honest labels: anything simulated says so.

## Review Focus

1. A batch with mixed problems (bad check digit, unknown bank code, duplicate account, outlier amount) must produce a finding on every affected row, not only the first.
2. A payee proof for the last row of a batch with an odd number of payouts (5) must verify; so must a one-payout receipt.
3. A tampered payee proof (changed amount, or a sibling hash swapped) must fail, and so must a proof whose header was anchored under a different issuer.
4. A v1 direct receipt and the escrow batch-5 receipt must still pass on `/verify` after the v2 changes.
5. Attesting twice from the same account, or attesting a hash that doesn't match the anchor, must be rejected by the contract with a clear error.

---

### Task 1: Pre-payout check engine (shared)

**Files:**
- Create: `packages/shared/src/spei-banks.ts`, `packages/shared/src/payout-check.ts`
- Test: `packages/shared/test/payout-check.test.ts`
- Modify: `packages/shared/package.json` exports, if subpath exports are listed there (follow how `direct-build` is exported).

**Interfaces:**
- Produces:
  - `SPEI_BANKS: Record<string, string>`: the 3-digit bank code (CLABE digits 1–3) mapped to a short bank name. A partial list of well-known SPEI participants. The file header says it is partial and must be checked against Banxico's current participant list before production. Include at least 002 BANAMEX, 006 BANCOMEXT, 009 BANOBRAS, 012 BBVA MEXICO, 014 SANTANDER, 019 BANJERCITO, 021 HSBC, 030 BAJIO, 032 IXE, 036 INBURSA, 042 MIFEL, 044 SCOTIABANK, 058 BANREGIO, 059 INVEX, 062 AFIRME, 072 BANORTE, 106 BANK OF AMERICA, 127 AZTECA, 130 COMPARTAMOS, 137 BANCOPPEL, 166 BANCO DEL BIENESTAR, 638 NU MEXICO, 646 STP, 699 FONDEADORA, 722 MERCADO PAGO.
  - `bankForClabe(clabe: string): string | null`
  - `type CheckLevel = "block" | "warn"`
  - `type CheckCode = "missing_name" | "bad_amount" | "clabe_length" | "clabe_non_digit" | "clabe_check_digit" | "bad_account" | "unknown_bank" | "duplicate_account" | "name_multiple_accounts" | "amount_outlier" | "account_changed"`
  - `interface PlannedRow { row: number; name: string; account: string; amount: string }` (amount has two decimal places)
  - `interface RowCheck { row: number; name: string; account_last4: string; bank: string | null; amount: string; findings: { code: CheckCode; level: CheckLevel; message: string }[] }`
  - `interface CheckResult { rail: string; rows: RowCheck[]; summary: { rows: number; blocked: number; warned: number; clean: number }; ok: boolean }` (`ok` is true when no row has a block finding)
  - `parsePlannedCsv(text: string): { rows: PlannedRow[]; errors: { row: number; reason: string }[] }`. Header `name,account,amount`. Also accepts the results header `name,account,amount,status,paid_at,reference` and ignores the extra columns. At most 500 data rows. Row numbers are 1-based, counting the header as row 1 (as in `parseResultsCsv`). Parse problems such as a bad header or an unparseable file are `errors`. Row-level value problems are NOT errors here; they become findings in `checkBatch`, so a bad row still appears in the report.
  - `checkBatch(rows: PlannedRow[], opts: { rail: string; history?: Record<string, string> }): CheckResult`. `history` maps a normalised name to the account used last time.
- Rules, all applied to every row (never stop at the first):
  - **block** `missing_name`.
  - **block** `bad_amount`: not `^\d{1,15}(\.\d{1,2})?$` or ≤ 0.
  - On rail SPEI: **block** `clabe_length`, `clabe_non_digit`, `clabe_check_digit` (from `validateClabe` in `clabe.ts`). **warn** `unknown_bank` when the CLABE is valid but its code isn't in `SPEI_BANKS`; the message says the prototype's list is partial.
  - On any other rail: **block** `bad_account` unless `^[A-Za-z0-9]{4,34}$`.
  - **warn** `duplicate_account`: the same account appears in more than one row; flag every such row.
  - **warn** `name_multiple_accounts`: the same normalised name (trimmed, lower-case, accents stripped with NFD, inner whitespace collapsed) appears with different accounts.
  - **warn** `amount_outlier`: the batch has ≥ 3 rows and the amount is > 3× the median of valid amounts.
  - **warn** `account_changed`: `history` has this normalised name with a different account. The message says this is the classic sign of payroll diversion and asks the user to confirm the change with the payee through a known channel.
- Messages are one plain-English sentence each.

- [ ] **Step 1: Write failing tests** in `payout-check.test.ts`:
  - `bankForClabe("002010077777777771") === "BANAMEX"`;
  - a 6-row SPEI batch with one bad check digit (block), one unknown bank code with a valid check digit (warn), two rows sharing an account (both warn `duplicate_account`), and one amount 10× the median (warn `amount_outlier`). Assert each row's codes exactly, `summary`, and `ok === false`;
  - a clean batch built from the five rows of `SAMPLE_RESULTS_CSV` in `apps/web/lib/issue.ts` (copy them into the test) gives `ok === true` and no findings;
  - `account_changed` fires when `history` maps "lucia fernandez" to another CLABE, and "Lucía  Fernández " normalises to the same key;
  - `parsePlannedCsv` accepts both headers, rejects a bad header with `bad_header`, and keeps a row with an empty name as a row (with `missing_name` from `checkBatch`);
  - a non-SPEI rail with `"DE89370400440532013000"` is clean, and `"x"` is blocked as `bad_account`.
- [ ] **Step 2: Run** `pnpm vitest run packages/shared/test/payout-check.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** `spei-banks.ts` and `payout-check.ts` (browser-safe, no Node imports; use `csv-parse/browser/esm/sync` like `direct-build.ts`). Export `normaliseName(name: string): string` too.
- [ ] **Step 4: Run** the test file. Expected: PASS. Then run the full gate.
- [ ] **Step 5: Commit** `feat(shared): pre-payout check engine (CLABE, bank code, duplicates, outliers, account changes)`.

### Task 2: `/check` page and the anchored check report

**Files:**
- Create: `packages/shared/src/check-report.ts`, `apps/web/app/check/page.tsx`, `apps/web/components/CheckView.tsx`, `apps/web/lib/check.ts`
- Modify: `apps/web/lib/deployment.ts` (nav: add "Check" before "Issue"), `apps/web/lib/verify.ts` and `apps/web/components/VerifyView.tsx` (accept a check report), `apps/web/app/page.tsx` ("Try it in 60 seconds" gets a Check card first), `docs/receipts/README.md` (a short section on `elivo-check-report-1`), plus a JSON schema file `docs/receipts/elivo-check-report-1.schema.json`
- Test: `packages/shared/test/check-report.test.ts`, `apps/web/test/check.test.ts`, `apps/web/test/check-view.test.tsx` (follow the patterns in `apps/web/test/issue.test.ts` and `issue-view.test.tsx`)

**Interfaces:**
- Consumes: Task 1 (`parsePlannedCsv`, `checkBatch`, `normaliseName`, `CheckResult`). From existing code: `issuerKeys(account, storage)` and the tx-building pattern in `apps/web/lib/issue.ts`; the wallet signer used by `IssueView.tsx`; `signDirectReceiptWeb`'s signing approach in `direct-build.ts`; the registry's existing `anchor(receipt_id, receipt_hash)`; the verification in `direct-verify-web.ts` and `lib/verify.ts`.
- Produces:
  - `CHECK_VERSION = "elivo-check-report-1"`.
  - `interface CheckReportBody { version; label; network; registry; issuer; report_id; checked_at; rail; engine: "elivo-check-1"; rows: { id: number; payee_ref: string; account_last4: string; bank: string | null; amount: string; findings: CheckCode[] }[]; summary: { rows; blocked; warned; clean } }`. `payee_ref` is sha256(salt ‖ account) hex, as in direct receipts.
  - `interface CheckReport extends CheckReportBody { signatures: DirectSignature[] }`, signed exactly like a direct receipt (canonical JSON without `signatures`, ed25519, plus ML-DSA-65 when chosen).
  - `buildCheckReport(result: CheckResult, rows: PlannedRow[], meta: { network; registry; issuer; report_id; salt: Uint8Array; checked_at?: string }): CheckReportBody`, `signCheckReport(body, edSeed, pq?)`, `checkReportHashB58(r): string` (base58 sha256 of the canonical whole signed report, as anchored), `isCheckReport(x): x is CheckReport` (strict, like `isDirectReceipt`).
  - The report is anchored in the existing registry with `anchor(receipt_id = report_id, receipt_hash)`. `report_id` is `check-YYYYMMDD-HHMMSS` (UTC).
  - `apps/web/lib/check.ts`: `prepareCheckAnchor(...)`, which signs the report and returns `{ report, hash, tx }` like `prepareIssue`. History is kept in `localStorage` under `elivo-check-history:<account or "local">` (normalised name → account), written only after a check runs, and read back for `account_changed`. `lastAnchoredCheck(account, storage): { report_id: string; hash: string; checked_at: string } | null` is used by Task 4.
- Page behaviour (`/check`):
  - A textarea plus file upload for the CSV and a rail field (default SPEI).
  - A "Use a sample batch with problems" button that loads a 6-row sample with one problem of each kind. Its accounts are invented; the sample also includes the 5 clean rows' style.
  - "Check batch" shows the summary (rows, blocked, warnings, clean) and a table: row, name, bank, last 4 digits, amount, findings as chips (block red, warn amber). Text uses text colours; the chip colour is not the only signal, since each chip shows a word.
  - A note: "Name-to-account matching needs a licensed account-validation provider; not checked in this prototype."
  - When `ok`: "Anchor this check on NEAR" (connect the wallet if needed). It signs the report with the visitor's issuer keys (publishing keys first if needed, exactly like /issue) and anchors it. Then it shows the report id, hash, explorer link, "Download check report (JSON)", and "Next: issue the receipt after paying →" linking to `/issue`.
  - When blocked: the anchor button is disabled with the reason.
- `/verify` accepts a check report. It shows signature, anchor and totals checks like a direct receipt, titled "Check report". The rows table shows findings codes, not names.

- [ ] **Step 1: Write failing tests:**
  - shared: build, sign, verify round-trip; changing one finding breaks the signature; `isCheckReport` rejects a direct receipt and vice versa.
  - web lib: `prepareCheckAnchor` builds `set_keys` + `anchor` the first time and only `anchor` when the keys match; history is written and read.
  - view: the sample with problems renders block and warn chips and disables anchoring; a clean batch enables it.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate. Expected: PASS. Also `pnpm build:web` must succeed.
- [ ] **Step 5: Commit** `feat(web,shared): /check — check a batch before paying and anchor the check report on NEAR`.

### Task 3: Receipt v2 with per-payout Merkle proofs (shared + CLI + docs)

**Files:**
- Create: `packages/shared/src/merkle.ts`, `packages/shared/src/direct-receipt-v2.ts` (types, build, sign, hash, verify helpers, payee proof), `docs/receipts/elivo-direct-receipt-2.schema.json`, `docs/receipts/elivo-payee-proof-1.schema.json`
- Modify: `packages/shared/src/bin/verify-receipt.ts` (accept v2 receipts and payee proofs), `docs/receipts/README.md`, `scripts/issue-receipt.ts` (add `--v2` to issue a v2 receipt and write the per-payee proofs next to it)
- Test: `packages/shared/test/merkle.test.ts`, `packages/shared/test/direct-receipt-v2.test.ts`, and extend the CLI test that covers direct receipts (find it under `packages/shared/test/`).

**Interfaces:**
- Consumes: `ResultRow` and `parseResultsCsv` from `direct-build.ts`; `DirectPayout`, `DirectTotals`, `directTotals`, `DirectSignature`, `RECEIPT_ID` from `direct-receipt.ts`; the ML-DSA helpers.
- Produces (exact):
  - `merkleLeaf(payout: DirectPayout): Uint8Array` = sha256(0x00 ‖ canonical JSON bytes of the payout).
  - Internal node = sha256(0x01 ‖ left ‖ right). An odd node at any level is carried up unchanged (no duplication). Root of one leaf = that leaf.
  - `merkleRoot(leaves): Uint8Array`, `merkleProof(leaves, index): { index: number; siblings: { side: "L" | "R"; hash: string /*hex*/ }[] }`, `merkleVerify(leaf, proof, root): boolean`.
  - `DIRECT_V2 = "elivo-direct-receipt-2"`.
  - `DirectReceiptV2Header`: every v1 body field except `payouts`, with `version: DIRECT_V2`, plus `payouts_root: string` (hex), `payout_count: number`, and `check_ref: { report_id: string; report_hash: string } | null`.
  - `DirectReceiptV2 = DirectReceiptV2Header & { signatures: DirectSignature[]; payouts: DirectPayout[] }`.
  - Signing bytes = canonical JSON of the header (no `payouts`, no `signatures`). The anchored hash = base58(sha256(canonical JSON of header + `signatures`)), i.e. the receipt without `payouts`. That is why one payee's proof verifies without the other rows.
  - Per-payee salt: `payee_salt_i = sha256(receipt_salt ‖ uint32be(i))`, and `payee_ref_i = hex(sha256(payee_salt_i ‖ utf8(account)))`. The issuer keeps `receipt_salt`.
  - `buildDirectReceiptV2(rows: ResultRow[], meta: DirectMeta & { check_ref?: ... }): { header: DirectReceiptV2Header; payouts: DirectPayout[] }`, `signDirectReceiptV2(built, edSeed, pq?): DirectReceiptV2`, `directV2HashB58(r): string`, `isDirectReceiptV2(x)` (strict).
  - `verifyDirectV2Structure(r): string[]`, which returns problems: root mismatch, `payout_count` mismatch, totals mismatch.
  - `PAYEE_PROOF = "elivo-payee-proof-1"`. `interface PayeeProof { version; header: DirectReceiptV2Header & { signatures: DirectSignature[] }; payout: DirectPayout; proof: { index; siblings }; payee_salt: string /*hex*/ }`.
  - `payeeProof(r: DirectReceiptV2, index: number, receiptSalt: Uint8Array): PayeeProof`, `isPayeeProof(x)`, `verifyPayeeProofStructure(p): string[]` (Merkle path to `payouts_root`, `payout.id === proof.index`), `payeeRefMatches(p, account): boolean`.
  - The signature and anchor checks reuse the v1 machinery over the v2 signing bytes; export `directV2SigningBytes(header)`.
- CLI: `pnpm verify-receipt <file> --chain` verifies a v2 receipt or a payee proof against the registry, and the output names the format.

- [ ] **Step 1: Write failing tests:** Merkle roots for 1, 2, 3, 5 and 8 leaves against hand-computed values; proofs for every index of 5 leaves verify; a swapped sibling fails. v2: build+sign+hash; one changed amount breaks `payouts_root`; a payee proof for every index of the 5-row sample verifies; a tampered proof fails; `payeeRefMatches` is true only for the right CLABE; v1 functions are unchanged (existing tests stay green).
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): elivo-direct-receipt-2 — Merkle root over payouts, per-payee proofs`.

### Task 4: `/issue` issues v2, payee links, and "Your receipts"; `/verify` handles v2

**Files:**
- Modify: `apps/web/lib/issue.ts`, `apps/web/components/IssueView.tsx`, `apps/web/lib/verify.ts`, `apps/web/components/VerifyView.tsx`, `apps/web/components/DirectReport.tsx`, `apps/web/lib/share.ts` (only if a generic encode/decode helper is needed; keep the existing `#r=` behaviour)
- Create: `apps/web/lib/receipt-store.ts`
- Test: extend `apps/web/test/issue.test.ts`, `issue-view.test.tsx`, `verify.test.ts`, `verify-view.test.tsx`; create `apps/web/test/receipt-store.test.ts`

**Interfaces:**
- Consumes: Task 3 (all v2 functions); Task 2 (`lastAnchoredCheck`).
- Produces:
  - `prepareIssue` now issues v2 by default. If `lastAnchoredCheck(account)` exists, its `report_id` and hash go into `check_ref`. The input gains an optional `checkRef`, so tests stay deterministic.
  - `receipt-store.ts`: `saveIssued(account, { receipt_id, hash, receipt: DirectReceiptV2, receiptSaltHex, names: string[], accounts: string[] }, storage)`, `listIssued(account, storage)`, and `findPayout(account, query, storage)`. The query is a name (normalised as in Task 1) or a full account; it returns matches `{ receipt_id, index, name, amount, status }`. Kept only in this browser's `localStorage`. The UI says so.
  - `payeeLink(origin, proof: PayeeProof): string` = `${origin}/payee#p=<base64url(deflate-raw(JSON))>` (reuse the compression in `share.ts`).
- `/issue` after anchoring:
  - a "Payee links" table (name, amount, status, "Copy link"), with a note: "Each link proves one payout. It shows nobody else's pay.";
  - "Download receipt (auditor copy)";
  - a "Find a payout" search box ("where is my money?") over this browser's issued receipts, returning the row and its payee link.
  - The pending-receipt flow through a wallet redirect keeps working (store the v2 receipt and its salt in `sessionStorage` as today).
- `/verify` with a v2 receipt:
  - checks Merkle root, count and totals, signatures (from on-chain keys), and the anchor;
  - if `check_ref` is set, fetches that anchor and shows "Checked before payment: check anchored <time>, receipt anchored <time>". This passes only when the check anchor exists, its hash matches `report_hash`, it is under the same issuer, and it came earlier.
  - v1 and escrow receipts behave as before.

- [ ] **Step 1: Write failing tests** for each behaviour above, including that v1 and batch-5 still verify (Review Focus 4) and that the check-before line fails when the check was anchored after the receipt.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate and `pnpm build:web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): /issue issues v2 receipts with payee links and a payout search; /verify checks v2 and check-before`.

### Task 5: `/payee` page, English and Spanish

**Files:**
- Create: `apps/web/app/payee/page.tsx`, `apps/web/components/PayeeView.tsx`, `apps/web/lib/payee.ts` (decode the link and verify against the chain), `apps/web/lib/i18n-payee.ts` (EN/ES strings)
- Test: `apps/web/test/payee.test.ts`, `apps/web/test/payee-view.test.tsx`

**Interfaces:**
- Consumes: Task 3 (`isPayeeProof`, `verifyPayeeProofStructure`, `payeeRefMatches`, `directV2SigningBytes`), Task 4 (`payeeLink` format), and the existing chain reads in `lib/verify.ts` (registry `get_receipt` and `get_keys`).
- Behaviour:
  - Reads `#p=` and shows one card: amount, currency, status, paid at, reference (the SPEI tracking key, labelled simulated), issuer account, and receipt id.
  - Checks shown as ✓/✗ lines: "Signed by <issuer>'s key on NEAR", "Anchored on NEAR at <time>", "Your payout is one of <n> in this receipt" (the Merkle path).
  - Optional: "Confirm it's your account". The payee types their CLABE and it is checked locally against `payee_ref` ("never sent anywhere").
  - A language toggle EN | ES, defaulting to the browser language when it starts with "es". The choice is remembered in `localStorage` (wrapped in try/catch).
  - Spanish strings are natural Mexican Spanish.
  - With no fragment, or a bad one, the page shows a short explanation and a link to try a sample. The sample is a payee link built from a v2 sample receipt that the implementer issues on testnet with `pnpm issue-receipt --v2` and commits as `apps/web/public/receipts/testnet-direct-payroll-v2.json`, plus a proof file. If testnet issuing isn't possible in the implementer's environment, they report NEEDS_CONTEXT instead of faking an anchor.
  - The LABEL banner is present.

- [ ] **Step 1: Write failing tests:** a valid proof shows all ✓ (chain reads mocked as in `verify.test.ts`); a tampered amount shows ✗ on the Merkle line; the CLABE confirm passes and fails correctly; the ES toggle changes the headings.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the full gate and `pnpm build:web`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(web): /payee — a payee checks their own payout from a private link (EN/ES)`.

### Task 6: On-chain attestations (registry + web)

**Files:**
- Modify: `contracts/registry/src/lib.rs`, `contracts/registry/src/tests.rs`, `contracts/res/elivo_registry.wasm` (via `make wasm`), `apps/web/lib/verify.ts`, `apps/web/components/VerifyView.tsx`, `apps/web/app/rpc/route.ts` (allow the DAO account from config for the view `get_policy` only), `README.md` (one row in the at-a-glance table, one try-it step)
- Create: `apps/web/components/Attestations.tsx`, `apps/web/lib/attest.ts`, `scripts/upgrade-registry.sh` (redeploys the code to the existing registry account without an init call)
- Test: contract unit tests; `apps/web/test/attest.test.ts`, `apps/web/test/attestations.test.tsx`

**Interfaces:**
- Contract, with no migration: the new storage is opened on the fly with new prefixes and is NOT a field of the `Registry` struct, so the deployed state still deserialises.
  - `#[payable] attest(issuer: AccountId, receipt_id: String, receipt_hash: Base58CryptoHash)`. The caller is the attester. It requires:
    - the anchor exists (`"not_anchored"`);
    - the hash equals the anchor's (`"hash_mismatch"`);
    - the caller hasn't attested this receipt yet (`"already_attested"`);
    - fewer than 100 attestations exist on it (`"too_many_attestations"`).

    It stores the attester and `attested_at_ns`, emits `receipt_attested` `{issuer, receipt_id, attester}`, and charges storage via `settle_storage` (flush the new collections too).
  - `get_attestations(issuer: AccountId, receipt_id: String) -> Vec<AttestationView { attester: AccountId, attested_at_ns: U64 }>` in attestation order.
  - `ATTEST_DEPOSIT = 0.01 NEAR` in `packages/shared/src/direct-receipt.ts`.
- Web:
  - `/verify`, for any registry-anchored receipt (direct v1, v2, check report), shows an "Attestations" panel. It lists attester accounts with their time. An attester who holds a role in the DAO's policy (`get_policy` on `deployment.dao`; any role whose `kind.Group` contains the account) gets a "DAO <role>" chip.
  - Below the list, "Attest that you checked this receipt" connects the wallet and sends `attest` with `ATTEST_DEPOSIT`. It is shown only after the verification passed. Explanatory copy: "Your NEAR account is recorded as having checked this receipt. You're vouching that you ran the checks, not that the payments happened."
  - The handling after a wallet redirect follows the pattern in `DaoVote.tsx`.
- Deploy: `scripts/upgrade-registry.sh` runs `near contract deploy <registry> use-file contracts/res/elivo_registry.wasm without-init-call` with the network and sign flags from `scripts/lib/near-steps.sh`. The implementer runs it once on testnet. Then they check `get_receipt` on the existing payroll receipt still works and that `get_attestations` returns `[]`, and record both outputs in the report.

- [ ] **Step 1: Write failing contract tests** for each require-path, the happy path, ordering, and the storage charge. Write the web tests: the panel lists attesters with a DAO chip from a mocked policy, and the button builds the right tx.
- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement**, `make wasm`, and run the upgrade script.
- [ ] **Step 4: Run** `cargo test -p elivo-registry` and the full gate. Expected: PASS.
- [ ] **Step 5: Commit** `feat(registry,web): on-chain attestations — auditors and DAO members vouch for a receipt with their NEAR account`.
