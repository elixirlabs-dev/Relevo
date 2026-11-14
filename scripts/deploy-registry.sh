#!/usr/bin/env bash
# Adds the receipt registry (receipts for payouts made outside the escrow) to the testnet deployment in
# deployments/testnet.json, plus a sample issuer account. Resumable: completed steps are skipped.
# Testnet prototype. Payout firms and SPEI receipts are simulated. Contract unaudited.
#
# Requires: near-cli-rs (`near`), node 22+, and the deployment root's key in ~/.near-credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
source scripts/lib/near-steps.sh

ROOT=$(node -e "console.log(require('./deployments/testnet.json').root)")
REGISTRY="registry.$ROOT"
ISSUER="payroll.$ROOT"
DONE=".data/registry-$ROOT.done"; mkdir -p .data; touch "$DONE"
[ -f contracts/res/elivo_registry.wasm ] || { echo "missing wasm: run make wasm"; exit 1; }

subacct() { step "subacct:$1" near account create-account fund-myself "$1" "$2" autogenerate-new-keypair save-to-legacy-keychain sign-as "$ROOT" $NET $SIGN; }

say "Creating $REGISTRY and the sample issuer $ISSUER"
subacct "$REGISTRY" '2.5 NEAR'
subacct "$ISSUER" '0.5 NEAR'

say "Deploying the registry"
step "deploy:registry" near contract deploy "$REGISTRY" use-file contracts/res/elivo_registry.wasm with-init-call new \
  json-args '{}' prepaid-gas '100.0 Tgas' attached-deposit '0 NEAR' $NET $SIGN

node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('deployments/testnet.json', 'utf8'));
d.registry = '$REGISTRY';
fs.writeFileSync('deployments/testnet.json', JSON.stringify(d, null, 2) + '\n');
"
say "Done: https://testnet.nearblocks.io/address/$REGISTRY"
