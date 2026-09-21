import {
  MAX_VAULT_NAME_LENGTH,
  MAX_VAULT_SYMBOL_LENGTH,
} from '@yieldanchor/constants';
import { z } from 'zod';

import {
  contractIdSchema,
  decimalsSchema,
  positiveBaseUnitAmountSchema,
  stellarAccountIdSchema,
} from './stellar.js';

/**
 * Input schemas for the vault's state-changing entry points.
 *
 * These mirror the contract's own checks so a malformed call fails locally with
 * a useful message instead of costing a simulation round trip and a rejected
 * transaction. They are a convenience, not a security boundary: the contract
 * re-enforces every one of these conditions on-chain.
 */

export const vaultNameSchema = z
  .string()
  .min(1, 'Vault name cannot be empty')
  .max(
    MAX_VAULT_NAME_LENGTH,
    `Vault name cannot exceed ${MAX_VAULT_NAME_LENGTH} characters`,
  );

export const vaultSymbolSchema = z
  .string()
  .min(1, 'Vault symbol cannot be empty')
  .max(
    MAX_VAULT_SYMBOL_LENGTH,
    `Vault symbol cannot exceed ${MAX_VAULT_SYMBOL_LENGTH} characters`,
  );

export const vaultMetadataSchema = z.object({
  name: vaultNameSchema,
  symbol: vaultSymbolSchema,
  decimals: decimalsSchema,
});

/**
 * A 32-byte contract-creation salt as 64 hex characters. `initialize` proves
 * the caller is the deployer by re-deriving the contract address from the
 * deployer and this salt.
 */
const contractSaltSchema = z
  .string()
  .regex(/^[0-9a-fA-F]{64}$/, 'Salt must be 32 bytes as 64 hex characters');

/** `initialize(deployer, salt, admin, asset, name, symbol, decimals)`. */
export const initializeVaultInputSchema = vaultMetadataSchema.extend({
  deployer: stellarAccountIdSchema,
  salt: contractSaltSchema,
  admin: stellarAccountIdSchema,
  asset: contractIdSchema,
});

/** `deposit(user, assets)`. */
export const depositInputSchema = z.object({
  vaultId: contractIdSchema,
  user: stellarAccountIdSchema,
  assets: positiveBaseUnitAmountSchema,
});

/** `redeem(user, shares)`. */
export const redeemInputSchema = z.object({
  vaultId: contractIdSchema,
  user: stellarAccountIdSchema,
  shares: positiveBaseUnitAmountSchema,
});

/** `withdraw(user, assets)`. */
export const withdrawInputSchema = z.object({
  vaultId: contractIdSchema,
  user: stellarAccountIdSchema,
  assets: positiveBaseUnitAmountSchema,
});

/** Admin-only calls that change vault control state. */
export const vaultControlInputSchema = z.object({
  vaultId: contractIdSchema,
});

/** A query for a vault's projected events. */
export const vaultEventQuerySchema = z.object({
  vaultId: contractIdSchema,
  limit: z.number().int().min(1).max(200).default(100),
});

/**
 * Caller-facing input types (`z.input`).
 *
 * Amounts are transformed to `bigint` by the schema, so the *parsed* type is
 * `bigint` while the accepted input is a `bigint` or an integer string. These
 * aliases describe what a caller may pass.
 */
export type InitializeVaultInput = z.input<typeof initializeVaultInputSchema>;
export type DepositInput = z.input<typeof depositInputSchema>;
export type RedeemInput = z.input<typeof redeemInputSchema>;
export type WithdrawInput = z.input<typeof withdrawInputSchema>;
export type VaultEventQuery = z.input<typeof vaultEventQuerySchema>;

/** Parsed shapes: what the schemas produce after transformation. */
export type ParsedDepositInput = z.output<typeof depositInputSchema>;
export type ParsedRedeemInput = z.output<typeof redeemInputSchema>;
export type ParsedWithdrawInput = z.output<typeof withdrawInputSchema>;
