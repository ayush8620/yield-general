#!/usr/bin/env bash
set -euo pipefail

###############################################################################
# YieldAnchor Protocol — Soroban YieldVault Testnet Deployment
# -----------------------------------------------------------------
# Builds the Rust `yield_vault` contract, deploys it to Stellar Testnet,
# initializes it against the native XLM Stellar Asset Contract, verifies the
# deployment by reading state back, and records the Contract ID so the indexer
# and API can pick it up via the CONTRACT_ID env variable.
#
# This is the shell path. `scripts/deploy/deploy-yield-vault.ts`
# (`pnpm run contract:deploy:ts`) does the same thing through
# @yieldanchor/contract-clients and needs no stellar CLI; prefer it unless you
# are working with the CLI directly.
#
# Prerequisites:
#   1. Rust toolchain with the wasm32-unknown-unknown target
#      (rustup target add wasm32-unknown-unknown)
#   2. stellar-cli installed and on PATH
#   3. A funded Testnet identity. If DEPLOYER_IDENTITY does not exist, this
#      script generates one and funds it through Friendbot.
#
# Overridable environment variables:
#   NETWORK              Stellar network name            (default: testnet)
#   RPC_URL              Soroban RPC endpoint            (default: testnet)
#   NETWORK_PASSPHRASE   Signing passphrase              (default: per NETWORK)
#   DEPLOYER_IDENTITY    stellar-cli identity to sign    (default: deployer)
#   ADMIN_ADDRESS        vault admin address             (default: deployer)
#   ASSET_CONTRACT_ID    underlying asset contract       (default: native XLM SAC)
#   ASSET_SPEC           asset to wrap when resolving    (default: native)
#   VAULT_NAME           vault metadata name             (default: YieldAnchor Vault)
#   VAULT_SYMBOL         vault metadata symbol           (default: yVAULT)
#   VAULT_DECIMALS       vault metadata decimals         (default: 7)
#
# WARNING: The Phase 1 yield source is a deterministic TESTNET SIMULATION
# keyed on ledger time. It is NOT real T-Bill or RWA yield and must never be
# presented as such.
###############################################################################

# ─── Configuration ───────────────────────────────────────────────────────────
NETWORK="${NETWORK:-testnet}"
RPC_URL="${RPC_URL:-https://soroban-testnet.stellar.org:443}"

# The identity that signs the deploy + initialize transactions.
DEPLOYER_IDENTITY="${DEPLOYER_IDENTITY:-deployer}"

# Left empty to select the native XLM Stellar Asset Contract, which is the only
# asset a fresh testnet identity is guaranteed to hold. Override with any
# asset contract address to deploy an asset-agnostic vault against something
# else (for example testnet USDC).
ASSET_CONTRACT_ID="${ASSET_CONTRACT_ID:-}"
ASSET_SPEC="${ASSET_SPEC:-native}"

VAULT_NAME="${VAULT_NAME:-YieldAnchor Vault}"
VAULT_SYMBOL="${VAULT_SYMBOL:-yVAULT}"
VAULT_DECIMALS="${VAULT_DECIMALS:-7}"

# ─── Network arguments ───────────────────────────────────────────────────────
# Passing `--rpc-url` makes the CLI require an explicit passphrase, so the
# passphrase is always paired with it here rather than left to the CLI's own
# network resolution.
case "$NETWORK" in
  testnet) DEFAULT_PASSPHRASE="Test SDF Network ; September 2015" ;;
  mainnet) DEFAULT_PASSPHRASE="Public Global Stellar Network ; September 2015" ;;
  *) DEFAULT_PASSPHRASE="" ;;
esac
NETWORK_PASSPHRASE="${NETWORK_PASSPHRASE:-$DEFAULT_PASSPHRASE}"

NET_ARGS=(--network "$NETWORK")
if [ -n "$NETWORK_PASSPHRASE" ]; then
  NET_ARGS+=(--network-passphrase "$NETWORK_PASSPHRASE")
else
  echo "WARNING: no passphrase known for network '$NETWORK'; relying on the CLI config" >&2
fi
if [ -n "$RPC_URL" ]; then
  NET_ARGS+=(--rpc-url "$RPC_URL")
fi

# ─── Paths ───────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(realpath "$SCRIPT_DIR/../..")"
MANIFEST="$ROOT_DIR/contracts/yield_vault/Cargo.toml"
CONTRACT_ID_FILE="$ROOT_DIR/scripts/.contract_id"

# The workspace target directory lives at the repository root: the contract is
# a workspace member, so `contracts/yield_vault/target/` is never populated.
# This path previously pointed there and made `make deploy` fail.
WASM_OUT="$ROOT_DIR/target/wasm32-unknown-unknown/release/yield_vault.wasm"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  STEP 1: Compiling yield_vault contract (Rust -> WASM)"
echo "════════════════════════════════════════════════════════════════════"

if ! command -v stellar >/dev/null 2>&1; then
  echo "ERROR: the stellar CLI is not on PATH."
  echo "       Install it with: cargo install stellar-cli --locked"
  exit 1
fi
echo "  stellar-cli: $(stellar --version | head -1)"

# Build directly through cargo rather than `stellar contract build`: the
# contract pins soroban-sdk 21.7 and `make contract-build` is already the
# canonical local build, so both paths produce byte-identical wasm.
cargo build --manifest-path "$MANIFEST" --target wasm32-unknown-unknown --release

if [ ! -f "$WASM_OUT" ]; then
  echo "ERROR: Compiled WASM not found at $WASM_OUT"
  exit 1
fi
echo "  ✓ WASM compiled: $(wc -c <"$WASM_OUT" | tr -d ' ') bytes at $WASM_OUT"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  STEP 2: Resolving the deployer identity"
echo "════════════════════════════════════════════════════════════════════"

if ! stellar keys address "$DEPLOYER_IDENTITY" >/dev/null 2>&1; then
  echo "  identity '$DEPLOYER_IDENTITY' not found; generating and funding it"
  stellar keys generate "$DEPLOYER_IDENTITY" "${NET_ARGS[@]}" --fund
fi

DEPLOYER_ADDRESS="$(stellar keys address "$DEPLOYER_IDENTITY")"
ADMIN_ADDRESS="${ADMIN_ADDRESS:-$DEPLOYER_ADDRESS}"
echo "  ✓ deployer=$DEPLOYER_ADDRESS"
echo "  ✓ admin=$ADMIN_ADDRESS"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  STEP 3: Resolving the underlying asset"
echo "════════════════════════════════════════════════════════════════════"

if [ -z "$ASSET_CONTRACT_ID" ]; then
  ASSET_CONTRACT_ID="$(stellar contract id asset \
    --asset "$ASSET_SPEC" \
    "${NET_ARGS[@]}" | grep -oE 'C[A-Z0-9]{55}' | head -1 || true)"

  if [ -z "$ASSET_CONTRACT_ID" ]; then
    echo "ERROR: could not resolve a Stellar Asset Contract for '$ASSET_SPEC'."
    exit 1
  fi
  echo "  using the native asset SAC for '$ASSET_SPEC'"
else
  echo "  using ASSET_CONTRACT_ID from the environment"
fi

# A Stellar *account* (G...) is not a token. The vault transfers the underlying
# asset through the Stellar Asset Contract interface, which only exists at a
# contract address (C...). The previous default was a G... account address,
# which deployed cleanly but could never settle a deposit.
case "$ASSET_CONTRACT_ID" in
  C*) ;;
  *)
    echo "ERROR: the vault asset must be a contract address (C...), got:"
    echo "       $ASSET_CONTRACT_ID"
    echo "       A G... account address cannot serve as the token the vault"
    echo "       moves. Resolve one with:"
    echo "         stellar contract id asset --asset native --network $NETWORK"
    exit 1
    ;;
esac
echo "  ✓ asset=$ASSET_CONTRACT_ID"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  STEP 4: Deploying WASM to Stellar $NETWORK"
echo "════════════════════════════════════════════════════════════════════"

# The contract address is derived from the deployer and this salt, and
# `initialize` re-derives it to prove the caller is the deployer, so the same
# salt must be passed to both steps.
SALT="${SALT:-$(head -c 32 /dev/urandom | od -An -vtx1 | tr -d ' \n')}"

DEPLOY_OUTPUT="$(stellar contract deploy \
  --wasm "$WASM_OUT" \
  --source "$DEPLOYER_IDENTITY" \
  --salt "$SALT" \
  "${NET_ARGS[@]}" 2>/tmp/deploy_stderr.log)"

# Portable extraction (-oE rather than -oP): Testnet contract IDs are 56
# characters and start with 'C'.
CONTRACT_ID="$(echo "$DEPLOY_OUTPUT" | grep -oE 'C[A-Z0-9]{55}' | head -1 || true)"

if [ -z "$CONTRACT_ID" ]; then
  echo "ERROR: Failed to extract a Contract ID from the deploy output."
  echo "Raw output:"
  echo "$DEPLOY_OUTPUT"
  echo "stderr:"
  cat /tmp/deploy_stderr.log || true
  exit 1
fi
echo "  ✓ deployed: $CONTRACT_ID"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  STEP 5: Initializing the vault"
echo "════════════════════════════════════════════════════════════════════"

stellar contract invoke \
  --id "$CONTRACT_ID" \
  --source "$DEPLOYER_IDENTITY" \
  "${NET_ARGS[@]}" \
  -- \
  initialize \
  --deployer "$DEPLOYER_ADDRESS" \
  --salt "$SALT" \
  --admin "$ADMIN_ADDRESS" \
  --asset "$ASSET_CONTRACT_ID" \
  --name "$VAULT_NAME" \
  --symbol "$VAULT_SYMBOL" \
  --decimals "$VAULT_DECIMALS"

echo "  ✓ initialize() accepted"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  STEP 6: Verifying the deployment"
echo "════════════════════════════════════════════════════════════════════"

invoke_read() {
  stellar contract invoke \
    --id "$CONTRACT_ID" \
    --source "$DEPLOYER_IDENTITY" \
    "${NET_ARGS[@]}" \
    --send no \
    -- "$@" 2>/dev/null
}

if [ "$(invoke_read is_initialized)" != "true" ]; then
  echo "ERROR: is_initialized() did not report true after initialize()."
  exit 1
fi
echo "  ✓ is_initialized() = true"
echo "  is_paused()        = $(invoke_read is_paused)"
echo "  admin()            = $(invoke_read admin)"
echo "  asset()            = $(invoke_read asset)"
echo "  total_assets()     = $(invoke_read total_assets)"

echo ""
echo "════════════════════════════════════════════════════════════════════"
echo "  DEPLOYMENT COMPLETE"
echo "════════════════════════════════════════════════════════════════════"
echo ""
echo "  Contract ID: $CONTRACT_ID"
echo ""
echo "  Add this to your .env file:"
echo "    CONTRACT_ID=$CONTRACT_ID"
echo "    SOROBAN_RPC=$RPC_URL"
echo ""

printf 'CONTRACT_ID=%s\n' "$CONTRACT_ID" >"$CONTRACT_ID_FILE"
printf 'NETWORK=%s\n' "$NETWORK" >>"$CONTRACT_ID_FILE"
printf 'ASSET_CONTRACT_ID=%s\n' "$ASSET_CONTRACT_ID" >>"$CONTRACT_ID_FILE"
printf 'ADMIN_ADDRESS=%s\n' "$ADMIN_ADDRESS" >>"$CONTRACT_ID_FILE"
printf 'WASM_SHA256=%s\n' "$(sha256sum "$WASM_OUT" | cut -d' ' -f1)" >>"$CONTRACT_ID_FILE"
echo "  Recorded in scripts/.contract_id"
echo ""
echo "  Reminder: Phase 1 yield is TESTNET SIMULATION ONLY — not real RWA yield."
