import {
  VAULT_ERROR_CODES,
  type VaultErrorCode,
  type VaultErrorName,
} from '@yieldanchor/constants';

export type { VaultErrorCode, VaultErrorName };

/**
 * Vault domain types, mirroring the Phase 1 `YieldVault` contract.
 *
 * Amounts are `bigint`: the contract accounts in `i128` base units, and a
 * JavaScript `number` silently loses precision above 2^53. Anything that leaves
 * this process (HTTP, JSON, a database column) must convert to a decimal string
 * first — see `@yieldanchor/stellar-utils`.
 */

/** A signed integer amount in the underlying asset's base units. */
export type Amount = bigint;

/** A signed integer amount encoded as a decimal string for transport. */
export type AmountString = string;

/** Stellar account (`G...`) or contract (`C...`) address. */
export type StellarAddress = string;

/** Immutable vault configuration, set once at initialization. */
export interface VaultConfig {
  admin: StellarAddress;
  asset: StellarAddress;
  name: string;
  symbol: string;
  decimals: number;
  /**
   * Mirrors `Config.simulation`. Always `true` in Phase 1: the accrued yield is
   * a Testnet simulation, not real RWA yield.
   */
  simulation: boolean;
}

/** Full vault state, as returned by `get_vault_state`. */
export interface VaultState {
  admin: StellarAddress;
  asset: StellarAddress;
  name: string;
  symbol: string;
  decimals: number;
  simulation: boolean;
  /** Deposited principal, excluding accrued simulated yield. */
  principal: Amount;
  /** Crystallized simulated yield. Not real RWA yield. */
  accrued: Amount;
  /** `principal + accrued`: total assets under management. */
  assets: Amount;
  /** Outstanding vault shares. */
  shares: Amount;
  /** Share price scaled by `PRICE_SCALE`, rounded down. */
  price: Amount;
  /** Ledger timestamp of the last accrual. */
  lastTs: number;
  paused: boolean;
}

/** Vault metadata as projected into the `vaults` table. */
export interface VaultMetadata {
  contractId: StellarAddress;
  admin: StellarAddress;
  asset: StellarAddress;
  name: string;
  symbol: string;
  decimals: number;
  /** Mirrors `Config.simulation`: always true for the Phase 1 simulation. */
  simulatedYield: boolean;
}

/**
 * Human-readable explanation for each contract error.
 *
 * These are for operator and user messages only. Nothing here should be
 * presented as a guarantee about protocol behavior.
 */
export const VAULT_ERROR_MESSAGES: Record<VaultErrorName, string> = {
  AlreadyInit: 'The vault has already been initialized.',
  NotInit: 'The vault has not been initialized yet.',
  BadAdmin: 'The supplied admin address is not acceptable.',
  BadAsset: 'The supplied underlying asset address is not acceptable.',
  BadName: 'The vault name is empty or longer than the allowed length.',
  BadSymbol: 'The vault symbol is empty or longer than the allowed length.',
  BadDecimal: 'The supplied decimals exceed the maximum the vault accepts.',
  BadAmount: 'The amount must be greater than zero.',
  NoShares: 'The account does not hold enough vault shares.',
  NoLiquidity: 'The vault does not hold enough underlying assets to pay out.',
  NoAssets: 'The redemption would round down to zero assets.',
  ZeroShares: 'The operation would mint or burn zero shares.',
  Overflow: 'The calculation exceeded the supported integer range.',
  Paused: 'The vault is paused; deposits and redemptions are disabled.',
  NotPaused: 'The vault is not paused.',
  RoundEmpty: 'The calculation rounded to zero, which the vault refuses.',
  BadDeployer: 'The caller is not the account that deployed this vault.',
};

/** Describe a contract error code for display, tolerating unknown codes. */
export function describeVaultError(code: number): string {
  const entry = Object.entries(VAULT_ERROR_CODES).find(
    ([, value]) => value === code,
  );
  if (!entry) {
    return `The contract rejected the call with unknown error code ${code}.`;
  }
  return VAULT_ERROR_MESSAGES[entry[0] as VaultErrorName];
}

/** Narrow a numeric code to a known error name. */
export function isKnownVaultErrorCode(code: number): code is VaultErrorCode {
  return Object.values(VAULT_ERROR_CODES).includes(code as VaultErrorCode);
}
