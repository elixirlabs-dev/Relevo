#!/usr/bin/env bash
# Redeploys the registry code to the existing registry account without an init call, so the stored
# keys and anchors stay as they are. Run after `make wasm`. Testnet prototype. Contract unaudited.
#
# Requires: near-cli-rs (`near`), node 22+, and the registry account's key in ~/.near-credentials.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.cargo/bin:$PATH"
source scripts/lib/near-steps.sh

REGISTRY=$(node -e "console.log(require('./deployments/testnet.json').registry)")
[ -n "$REGISTRY" ] && [ "$REGISTRY" != "undefined" ] || { echo "no registry in deployments/testnet.json"; exit 1; }
[ -f contracts/res/elivo_registry.wasm ] || { echo "missing wasm: run make wasm"; exit 1; }

say "Upgrading the registry code on $REGISTRY (state kept, no init call)"
retry near contract deploy "$REGISTRY" use-file contracts/res/elivo_registry.wasm without-init-call $NET $SIGN

say "Done: https://testnet.nearblocks.io/address/$REGISTRY"
