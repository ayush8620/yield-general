import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  depositInputSchema,
  initializeVaultInputSchema,
  redeemInputSchema,
  vaultEventQuerySchema,
  withdrawInputSchema,
} from '../src/index.js';

const ADMIN = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 1));
const USER = StrKey.encodeEd25519PublicKey(Buffer.alloc(32, 2));
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 3));
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 4));
const SALT = '0a'.repeat(32);

describe('initializeVaultInputSchema', () => {
  const valid = {
    deployer: ADMIN,
    salt: SALT,
    admin: ADMIN,
    asset: ASSET,
    name: 'YieldAnchor Vault',
    symbol: 'yVAULT',
    decimals: 6,
  };

  it('accepts a well-formed initialization', () => {
    expect(initializeVaultInputSchema.parse(valid)).toEqual(valid);
  });

  it('rejects an empty name or symbol', () => {
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, name: '' }).success,
    ).toBe(false);
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, symbol: '' }).success,
    ).toBe(false);
  });

  it('rejects an over-long name or symbol', () => {
    expect(
      initializeVaultInputSchema.safeParse({
        ...valid,
        name: 'x'.repeat(33),
      }).success,
    ).toBe(false);
    expect(
      initializeVaultInputSchema.safeParse({
        ...valid,
        symbol: 'x'.repeat(33),
      }).success,
    ).toBe(false);
  });

  it('rejects decimals beyond the contract maximum', () => {
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, decimals: 19 }).success,
    ).toBe(false);
  });

  it('rejects an asset that is not a contract id', () => {
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, asset: ADMIN }).success,
    ).toBe(false);
  });

  it('rejects a salt that is not 32 bytes of hex', () => {
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, salt: '0a' }).success,
    ).toBe(false);
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, salt: 'zz'.repeat(32) })
        .success,
    ).toBe(false);
  });

  it('rejects a deployer that is not an account address', () => {
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, deployer: ASSET })
        .success,
    ).toBe(false);
  });

  it('rejects an admin that is not an account address', () => {
    expect(
      initializeVaultInputSchema.safeParse({ ...valid, admin: ASSET }).success,
    ).toBe(false);
  });
});

describe('depositInputSchema', () => {
  it('normalises the amount to base units', () => {
    expect(
      depositInputSchema.parse({ vaultId: VAULT, user: USER, assets: '500' })
        .assets,
    ).toBe(500n);
  });

  it('rejects a zero or negative deposit', () => {
    expect(
      depositInputSchema.safeParse({ vaultId: VAULT, user: USER, assets: '0' })
        .success,
    ).toBe(false);
    expect(
      depositInputSchema.safeParse({ vaultId: VAULT, user: USER, assets: '-5' })
        .success,
    ).toBe(false);
  });

  it('rejects a malformed vault id', () => {
    expect(
      depositInputSchema.safeParse({ vaultId: 'CABC', user: USER, assets: '1' })
        .success,
    ).toBe(false);
  });
});

describe('redeemInputSchema and withdrawInputSchema', () => {
  it('accept standalone shares and assets', () => {
    expect(
      redeemInputSchema.safeParse({ vaultId: VAULT, user: USER, shares: '1' })
        .success,
    ).toBe(true);
    expect(
      withdrawInputSchema.safeParse({ vaultId: VAULT, user: USER, assets: '1' })
        .success,
    ).toBe(true);
  });

  it('refuse zero input', () => {
    expect(
      redeemInputSchema.safeParse({ vaultId: VAULT, user: USER, shares: '0' })
        .success,
    ).toBe(false);
    expect(
      withdrawInputSchema.safeParse({
        vaultId: VAULT,
        user: USER,
        assets: '0',
      }).success,
    ).toBe(false);
  });
});

describe('vaultEventQuerySchema', () => {
  it('defaults the page size', () => {
    expect(vaultEventQuerySchema.parse({ vaultId: VAULT }).limit).toBe(100);
  });

  it('rejects an out-of-range page size', () => {
    expect(
      vaultEventQuerySchema.safeParse({ vaultId: VAULT, limit: 0 }).success,
    ).toBe(false);
    expect(
      vaultEventQuerySchema.safeParse({ vaultId: VAULT, limit: 500 }).success,
    ).toBe(false);
  });
});
