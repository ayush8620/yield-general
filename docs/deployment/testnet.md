# Testnet deployment record

The Phase 1 `YieldVault` deployed to Stellar Testnet, and what has actually been
verified against it.

**This is not production-ready and has not been audited.** The yield it reports is a
deterministic ledger-time simulation, not real T-Bill or RWA yield. Read
[Phase 1 limitations](#phase-1-limitations) before drawing conclusions from any value
below.

## Current deployment

|                    |                                                                                              |
| ------------------ | -------------------------------------------------------------------------------------------- |
| Contract           | `CB4RKPI55DQOZUPQGVOO4ZUGZ7EPVUZZTR6D7F7F7CYM5OFWOMC3J2IA`                                   |
| Network            | Testnet (`Test SDF Network ; September 2015`), protocol 28                                   |
| RPC                | `https://soroban-testnet.stellar.org:443`                                                    |
| Deployed           | 2026-09-16, initialized in ledger 4,706,400                                                  |
| Underlying asset   | Native XLM Stellar Asset Contract `CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC` |
| Vault metadata     | name `YieldAnchor Vault`, symbol `yVAULT`, decimals `7`                                      |
| Admin / deployer   | `GD6WQ2NHO5OPDPUFBM3FX5K2FFZUSYBLFBSTBOSOXK2FUQUIMU7UTAWO`                                   |
| Wasm               | 19,570 bytes, sha256 `54c5ed1375a8257565b2784be0ddf6b82691660174e8472376af25eed64e710a`      |
| Exported functions | 23                                                                                           |

Deployed from `scripts/deploy/deploy-yield-vault.ts`. The contract id is recorded in
`scripts/.contract_id` and mirrored into `.env.example`:

| Step            | Transaction                                                        |
| --------------- | ------------------------------------------------------------------ |
| Upload wasm     | `89a1b21f9b68cc0936b052071023698eef6c6f8e395a18f5fe81760ae3e12b1a` |
| Create contract | `ce5c857944a40f16e73f3b9c10520724adc1af899516605218feb88e00dbfda5` |
| Initialize      | `4589b359c68f668b610107a919a38f9ec9d3e2a4190139b42129ab879b584e31` |

### It supersedes a stale deployment

An earlier contract, `CCUVKZGWKYDIB7L3DT4KSFGAIPUOXZRMML2QTHBDLHSOHCYD5ZXK6PPK`, was
deployed 2026-07-12 from the pre-Phase-1 scaffold. It is still on Testnet and is **not**
the vault described here. Its published interface contains four functions —
`initialize`, `deposit`, `withdraw`, `get_total_deposits` — against this contract's
twenty-three, and it stores an _account_ address as its asset, which cannot serve as
the token the vault transfers. Anything pointed at it will fail.

Two defects in the shell deploy script caused that: it built the wasm from
`contracts/yield_vault/target/`, a path Cargo never populates (the workspace target
directory is the repository root), and it defaulted the asset to a `G...` account
address. Both are fixed.

### The shell path is verified too

`scripts/deploy/deploy-yield-vault.sh` was run end to end after the fix. It deployed and
initialized its own instance at `CBMWEB3SYIMDHUVNDAQCCCHSACAERNAZUAZP3VJEKZGYZGRKOFUL5SMV`
(initialize tx `08997e7a7b58404896277f41d440e45899e93e7db11a9ad76f300b6742700d7b`),
confirming both paths work. The TypeScript deployment above remains the recorded
contract: it is the one this document describes and the one the round trip was run
against, and `scripts/.contract_id` points at it.

## What has been verified against it

- **Deployment**: all eleven post-deploy reads matched the requested configuration,
  including `simulation = true` (the vault advertises that its yield is simulated) and
  `share_price = PRICE_SCALE` on an empty vault.
- **State reads through the `stellar` CLI** — `is_initialized`, `admin`, `asset`,
  `name`, `symbol`, `decimals`, `total_assets`, `total_shares`, `share_price`,
  `available_liquidity`, `is_paused`. These are the exact calls that fail against the
  stale contract above.
- **The `@yieldanchor/contract-clients` read path and `signAndSend`** against live
  Testnet, not just a stubbed RPC.
- **A deposit / accrual / redemption round trip** (`pnpm run testnet:round-trip`),
  checking the underlying asset actually moved by reading the asset contract's own
  balance rather than trusting the vault's accounting:

| Check                   | Observed                                                             |
| ----------------------- | -------------------------------------------------------------------- |
| Deposit of 1000 XLM     | vault's asset-contract balance rose by exactly the deposit           |
| Accrual over 35s        | `+2663`, against `~2663` predicted from the simulated rate           |
| Second accrual over 20s | `+1523`, against `~1522` — only the new interval, no double counting |
| Accounting identity     | `total_assets == principal + accrued` held                           |
| Redemption              | paid `29999976578` for shares whose floor value was `29999976198`    |
| Residual after draining | `23422`, matching the contract's own `available_liquidity`           |

## Phase 1 limitations

**The simulated yield is not backed by tokens.** Deposits move real assets into the
vault, but accrued yield is conjured from ledger time and no tokens are ever added to
cover it. The vault therefore owes `principal + accrued` while holding only
`principal`. Consequences, all observed on Testnet:

- **A redemption of every share is refused** with `NoLiquidity` (code 10). The round
  trip asserts this rather than working around it. After the run above, the holder
  retained 68,702 shares representing yield that has no tokens behind it and can never
  be withdrawn.
- **Sizing a redemption to exactly the current liquidity races the ledger.** Every
  state-changing call crystallizes pending yield _before_ computing the payout, so the
  assets owed for a fixed share count grow with time. A redemption simulated at exactly
  the current balance passed simulation and then **failed on-chain** because the payout
  grew past the balance before the transaction landed. The smoke test now leaves a
  margin; the underlying contract behaviour is unchanged.
- **The reported `share_price` is therefore optimistic.** It divides by a total that
  includes yield the vault cannot pay. `available_liquidity` is the honest number for
  what a redemption can actually settle.
- **`VaultError::NoAssets`/`NoLiquidity` are the expected failure modes**, not
  exceptional states, whenever an operator tries to withdraw simulated earnings.

The deposit side is unaffected: principal is fully backed, and a depositor can always
withdraw up to what the vault holds.

Beyond the yield simulation, the vault has no NAV source, no oracle, no reserve proof,
no fees, no per-user withdrawal queue, and no compliance model. `initialize` requires
the chosen admin's own signature via `admin.require_auth()`: a caller may propose any
admin address, but only that admin can authorize installing itself, so a front-runner
cannot take control of a freshly deployed instance with an admin it does not control.
Self-installation by a caller who signs for themselves is still possible until the
vault is initialized, so initializing in the same breath as creation — as this
deployment was — remains good practice.

## Reproducing

```bash
pnpm run contract:deploy:ts    # builds packages + wasm, deploys, initializes, verifies
pnpm run testnet:round-trip    # live deposit -> accrual -> redemption smoke test
```

The TypeScript path needs only Node and the repo's dependencies; the shell path
(`pnpm run contract:deploy`) additionally needs the `stellar` CLI on `PATH`. Both
record their result in `scripts/.contract_id`.

Testnet is the only supported network. There is no Mainnet deployment and no plan for
one until a real yield source and an audit exist.
