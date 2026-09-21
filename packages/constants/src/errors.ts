/**
 * Error codes returned by the `YieldVault` contract.
 *
 * Soroban surfaces a failed contract call as a numeric code, so off-chain
 * callers need this mapping to turn a simulation failure back into something
 * readable. The numbering mirrors the `VaultError` enum in
 * `contracts/yield_vault/src/lib.rs`; it is part of the contract ABI and must
 * not be renumbered.
 */
export const VAULT_ERROR_CODES = {
  AlreadyInit: 1,
  NotInit: 2,
  BadAdmin: 3,
  BadAsset: 4,
  BadName: 5,
  BadSymbol: 6,
  BadDecimal: 7,
  BadAmount: 8,
  NoShares: 9,
  NoLiquidity: 10,
  NoAssets: 11,
  ZeroShares: 12,
  Overflow: 13,
  Paused: 14,
  NotPaused: 15,
  RoundEmpty: 16,
  BadDeployer: 17,
} as const;

export type VaultErrorName = keyof typeof VAULT_ERROR_CODES;

export type VaultErrorCode = (typeof VAULT_ERROR_CODES)[VaultErrorName];

const VAULT_ERROR_NAMES_BY_CODE: Record<number, VaultErrorName> =
  Object.fromEntries(
    Object.entries(VAULT_ERROR_CODES).map(([name, code]) => [code, name]),
  ) as Record<number, VaultErrorName>;

/** Resolve a contract error code, or `null` when it is unknown to this version. */
export function vaultErrorName(code: number): VaultErrorName | null {
  return VAULT_ERROR_NAMES_BY_CODE[code] ?? null;
}
