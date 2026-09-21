# YieldAnchor YieldVault — Phase 1

This crate contains the Phase 1 core YieldVault contract.

## Scope

Implemented in this phase:

- One-time initialization with admin, arbitrary underlying token, name, symbol, and decimals.
- Initialization guarantee: `initialize` requires the chosen admin's own signature (`admin.require_auth()`). A caller may propose any admin, but only that admin can authorize installing itself, so a front-runner cannot capture a fresh instance with an admin it does not control. Re-initialization still returns `AlreadyInit`. Self-installation by a signer who authorizes themselves remains possible until initialization completes — initialize in the same transaction as creation when that window matters.
- Asset deposits with proportional vault-share minting.
- Share redemption and asset withdrawal.
- Integer-only accounting with checked arithmetic and explicit floor/ceiling rounding.
- Admin pause/unpause controls.
- Soroban address authorization for initialization, user operations, and admin operations.
- Vault state, initialization, pause, balance, conversion, share-price, and liquidity read methods.
- Initialization, deposit, withdrawal, share mint/burn, yield, and pause events.

## Simulated yield warning

The contract includes a deterministic simple-interest simulation at `8.00%` APR, derived only from Soroban ledger timestamps. This is enabled solely to support Phase 1 Testnet development and is exposed through the `simulation` field in `VaultState`.

It is **not** a Treasury Bill integration, RWA integration, oracle, strategy, reserve proof, NAV calculation, or real yield source. Simulated accounting yield does not mint underlying tokens; Testnet redemption tests must explicitly provide any additional token liquidity. Do not deploy this simulation for production funds or mainnet use.

## Accounting model

- `principal` tracks assets deposited through the vault.
- `accrued` tracks crystallized simulated yield.
- `rem` preserves fractional integer yield between accruals.
- `total_assets = principal + accrued` plus pending ledger-time simulation in read-only views.
- Initial deposits mint one share per underlying unit.
- Later deposits use floor rounding: `assets * total_shares / total_assets`.
- Redemptions use floor rounding for assets.
- Asset-targeted withdrawals use ceiling rounding for shares and transfer exactly the requested assets.
- Share price is returned at `1e18` precision.

## Verification

Run from the repository root:

```bash
cargo fmt --all -- --check
cargo check -p yield_vault
cargo test -p yield_vault
cargo clippy -p yield_vault --all-targets -- -D warnings
```
