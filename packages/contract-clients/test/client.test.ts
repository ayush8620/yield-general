import {
  Account,
  Keypair,
  Operation,
  SorobanDataBuilder,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from '@stellar/stellar-sdk';
import { networkPassphrase, VAULT_ERROR_CODES } from '@yieldanchor/constants';
import { StrKey } from '@stellar/stellar-sdk';
import { describe, expect, it } from 'vitest';

import {
  VaultClientError,
  VaultSimulationError,
  VaultSubmissionError,
  YieldVaultClient,
  type SorobanServer,
} from '../src/index.js';

const NETWORK = 'testnet' as const;
const PASSPHRASE = networkPassphrase(NETWORK);
const VAULT = StrKey.encodeContract(Buffer.alloc(32, 4));
const USER_KEYPAIR = Keypair.random();
const USER = USER_KEYPAIR.publicKey();
const ASSET = StrKey.encodeContract(Buffer.alloc(32, 3));
const ADMIN = Keypair.random().publicKey();

/** Build a simulation success response the way RPC would serialise it. */
function simulationSuccess(retval: xdr.ScVal) {
  return rpc.parseRawSimulation({
    id: '1',
    latestLedger: 100,
    transactionData: new SorobanDataBuilder().build().toXDR('base64'),
    minResourceFee: '100',
    events: [],
    results: [{ auth: [], xdr: retval.toXDR('base64') }],
  });
}

function simulationFailure(error: string) {
  return rpc.parseRawSimulation({ id: '1', latestLedger: 100, error });
}

function confirmationSuccess(returnValue?: xdr.ScVal) {
  return {
    status: rpc.Api.GetTransactionStatus.SUCCESS,
    txHash: 'deadbeef',
    latestLedger: 101,
    latestLedgerCloseTime: 1_700_000_005,
    oldestLedger: 1,
    oldestLedgerCloseTime: 1_700_000_000,
    ledger: 101,
    createdAt: 1_700_000_005,
    applicationOrder: 1,
    feeBump: false,
    returnValue,
    events: { contractEventsXdr: [], diagnosticEventsXdr: [] },
  } as unknown as rpc.Api.GetTransactionResponse;
}

interface StubOptions {
  simulation: rpc.Api.SimulateTransactionResponse;
  sendStatus?: 'PENDING' | 'ERROR';
  confirmation?: rpc.Api.GetTransactionResponse;
}

class StubServer implements SorobanServer {
  readonly simulated: Transaction[] = [];
  readonly sent: Transaction[] = [];
  polls = 0;

  constructor(private readonly options: StubOptions) {}

  async getAccount(address: string): Promise<Account> {
    return new Account(address, '1234');
  }

  async simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    this.simulated.push(tx);
    return this.options.simulation;
  }

  async sendTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    this.sent.push(tx);
    return {
      status: this.options.sendStatus ?? 'PENDING',
      hash: 'deadbeef',
      latestLedger: 100,
      latestLedgerCloseTime: 1_700_000_000,
    };
  }

  async getTransaction(): Promise<rpc.Api.GetTransactionResponse> {
    this.polls += 1;
    return (this.options.confirmation ?? {
      status: rpc.Api.GetTransactionStatus.NOT_FOUND,
    }) as rpc.Api.GetTransactionResponse;
  }
}

function clientWith(
  server: SorobanServer,
  overrides: Partial<{ publicKey: string }> = {},
) {
  return new YieldVaultClient({
    contractId: VAULT,
    network: NETWORK,
    server,
    publicKey: overrides.publicKey ?? USER,
    pollIntervalMs: 0,
    pollAttempts: 2,
  });
}

/** The method name a built transaction invokes. */
function invokedMethod(tx: Transaction): string {
  const [operation] = tx.operations;
  if (!operation || operation.type !== 'invokeHostFunction') {
    throw new Error(
      `Expected an invokeHostFunction operation, got ${operation?.type}`,
    );
  }
  return String(
    (operation as Operation.InvokeHostFunction).func
      .invokeContract()
      .functionName(),
  );
}

function invokedArgs(tx: Transaction): xdr.ScVal[] {
  const [operation] = tx.operations;
  if (!operation || operation.type !== 'invokeHostFunction') {
    throw new Error('Expected an invokeHostFunction operation');
  }
  return (operation as Operation.InvokeHostFunction).func
    .invokeContract()
    .args();
}

describe('YieldVaultClient construction', () => {
  it('rejects a malformed contract id', () => {
    expect(() => new YieldVaultClient({ contractId: 'CABC' })).toThrow();
  });

  it('rejects a malformed source account', () => {
    expect(
      () => new YieldVaultClient({ contractId: VAULT, publicKey: 'GABC' }),
    ).toThrow();
  });

  it('refuses a network with no configured RPC endpoint', () => {
    expect(
      () => new YieldVaultClient({ contractId: VAULT, network: 'mainnet' }),
    ).toThrow(VaultClientError);
    expect(
      () => new YieldVaultClient({ contractId: VAULT, network: 'mainnet' }),
    ).toThrow(/No Soroban RPC URL/);
  });

  it('exposes the configured network passphrase', () => {
    const server = new StubServer({
      simulation: simulationSuccess(nativeToScVal(0n, { type: 'i128' })),
    });

    expect(clientWith(server).networkPassphrase).toBe(PASSPHRASE);
  });
});

describe('read methods', () => {
  it('simulates total_assets and decodes an exact integer', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(
        nativeToScVal(1_012_345n, { type: 'i128' }),
      ),
    });
    const client = clientWith(server);

    await expect(client.totalAssets()).resolves.toBe(1_012_345n);
    expect(server.simulated).toHaveLength(1);
    expect(invokedMethod(server.simulated[0])).toBe('total_assets');
  });

  it('decodes get_vault_state into the domain shape', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(
        nativeToScVal({
          admin: ADMIN,
          asset: ASSET,
          name: 'YieldAnchor Vault',
          symbol: 'yVAULT',
          decimals: 6,
          simulation: true,
          principal: 1_000_000n,
          accrued: 12_345n,
          assets: 1_012_345n,
          shares: 1_000_000n,
          price: 1_000_000_000_000_000_000n,
          last_ts: 1_700_000_000n,
          paused: false,
        }),
      ),
    });

    const state = await clientWith(server).getVaultState();

    expect(state.admin).toBe(ADMIN);
    expect(state.assets).toBe(1_012_345n);
    expect(state.lastTs).toBe(1_700_000_000);
    expect(state.paused).toBe(false);
  });

  it('derives vault metadata from a single call', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(
        nativeToScVal({
          admin: ADMIN,
          asset: ASSET,
          name: 'YieldAnchor Vault',
          symbol: 'yVAULT',
          decimals: 6,
          simulation: true,
          principal: 0n,
          accrued: 0n,
          assets: 0n,
          shares: 0n,
          price: 0n,
          last_ts: 0n,
          paused: false,
        }),
      ),
    });

    await expect(clientWith(server).getMetadata()).resolves.toMatchObject({
      contractId: VAULT,
      simulatedYield: true,
      decimals: 6,
    });
    expect(server.simulated).toHaveLength(1);
  });

  it('passes the user address to balance_of', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(nativeToScVal(495n, { type: 'i128' })),
    });

    await expect(clientWith(server).balanceOf(USER)).resolves.toBe(495n);
    expect(scValToNative(invokedArgs(server.simulated[0])[0])).toBe(USER);
  });

  it('decodes boolean views', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(nativeToScVal(true)),
    });

    await expect(clientWith(server).isPaused()).resolves.toBe(true);
    expect(invokedMethod(server.simulated[0])).toBe('is_paused');
  });

  it('previews a conversion', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(nativeToScVal(990n, { type: 'i128' })),
    });

    await expect(clientWith(server).convertToShares(1_000n)).resolves.toBe(
      990n,
    );
  });

  it('does not need a configured source account for a read', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(nativeToScVal(0n, { type: 'i128' })),
    });
    const client = new YieldVaultClient({
      contractId: VAULT,
      network: NETWORK,
      server,
    });

    await expect(client.totalAssets()).resolves.toBe(0n);
  });

  it('validates the address before simulating', async () => {
    const server = new StubServer({
      simulation: simulationSuccess(nativeToScVal(0n, { type: 'i128' })),
    });

    await expect(clientWith(server).balanceOf('GABC')).rejects.toThrow();
    expect(server.simulated).toHaveLength(0);
  });

  it('raises a typed error when the contract rejects the call', async () => {
    const server = new StubServer({
      simulation: simulationFailure('HostError: Error(Contract, #2)'),
    });

    const failure = clientWith(server).getVaultState();

    await expect(failure).rejects.toBeInstanceOf(VaultSimulationError);
    await expect(failure).rejects.toMatchObject({
      method: 'get_vault_state',
      contractError: { code: 2, errorName: 'NotInit' },
    });
  });

  it('raises when a simulation returns no value', async () => {
    const server = new StubServer({
      simulation: rpc.parseRawSimulation({
        id: '1',
        latestLedger: 100,
        transactionData: new SorobanDataBuilder().build().toXDR('base64'),
        minResourceFee: '100',
        events: [],
      }),
    });

    await expect(clientWith(server).totalAssets()).rejects.toThrow(
      /returned no value/,
    );
  });
});

describe('transaction builders', () => {
  const server = () =>
    new StubServer({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
    });

  it('builds a submittable deposit transaction without signing it', async () => {
    const stub = server();
    const built = await clientWith(stub).deposit({
      vaultId: VAULT,
      user: USER,
      assets: 500n,
    });

    expect(invokedMethod(built.transaction)).toBe('deposit');
    expect(scValToNative(invokedArgs(built.transaction)[0])).toBe(USER);
    expect(scValToNative(invokedArgs(built.transaction)[1])).toBe(500n);

    const reparsed = TransactionBuilder.fromXDR(built.toXDR(), PASSPHRASE);
    expect(invokedMethod(reparsed as Transaction)).toBe('deposit');
    expect(stub.sent).toHaveLength(0);
  });

  it('accepts an amount written as an integer string', async () => {
    const built = await clientWith(server()).deposit({
      vaultId: VAULT,
      user: USER,
      assets: '500',
    });

    expect(scValToNative(invokedArgs(built.transaction)[1])).toBe(500n);
  });

  it('rejects a zero or negative amount before touching the network', async () => {
    const stub = server();
    const client = clientWith(stub);

    await expect(
      client.deposit({ vaultId: VAULT, user: USER, assets: 0n }),
    ).rejects.toThrow(/greater than zero/);
    expect(stub.simulated).toHaveLength(0);
  });

  it('refuses to build a call for a different vault', async () => {
    const other = StrKey.encodeContract(Buffer.alloc(32, 5));

    await expect(
      clientWith(server()).redeem({ vaultId: other, user: USER, shares: 1n }),
    ).rejects.toThrow(/bound to/);
  });

  it('requires a source account', async () => {
    const client = new YieldVaultClient({
      contractId: VAULT,
      network: NETWORK,
      server: server(),
    });

    await expect(
      client.deposit({ vaultId: VAULT, user: USER, assets: 1n }),
    ).rejects.toThrow(/requires a source account/);
  });

  it('builds redeem, withdraw, pause, unpause and accrue_yield', async () => {
    const client = clientWith(server());

    expect(
      invokedMethod(
        (await client.redeem({ vaultId: VAULT, user: USER, shares: 100n }))
          .transaction,
      ),
    ).toBe('redeem');
    expect(
      invokedMethod(
        (await client.withdraw({ vaultId: VAULT, user: USER, assets: 100n }))
          .transaction,
      ),
    ).toBe('withdraw');
    expect(invokedMethod((await client.pause()).transaction)).toBe('pause');
    expect(invokedMethod((await client.unpause()).transaction)).toBe('unpause');
    expect(invokedMethod((await client.accrueYield()).transaction)).toBe(
      'accrue_yield',
    );
  });

  it('builds initialize with the configured metadata', async () => {
    const built = await clientWith(server()).initialize({
      deployer: ADMIN,
      salt: '0a'.repeat(32),
      admin: ADMIN,
      asset: ASSET,
      name: 'YieldAnchor Vault',
      symbol: 'yVAULT',
      decimals: 6,
    });

    expect(invokedMethod(built.transaction)).toBe('initialize');
    const args = invokedArgs(built.transaction);
    expect(scValToNative(args[0])).toBe(ADMIN);
    expect(Buffer.from(scValToNative(args[1])).toString('hex')).toBe(
      '0a'.repeat(32),
    );
    expect(scValToNative(args[4])).toBe('YieldAnchor Vault');
    expect(scValToNative(args[6])).toBe(6);
  });

  it('surfaces a contract rejection raised during simulation', async () => {
    const stub = new StubServer({
      simulation: simulationFailure('HostError: Error(Contract, #14)'),
    });

    await expect(
      clientWith(stub).deposit({ vaultId: VAULT, user: USER, assets: 1n }),
    ).rejects.toMatchObject({
      contractError: { code: VAULT_ERROR_CODES.Paused, errorName: 'Paused' },
    });
  });
});

describe('sign and send', () => {
  const signer = async (unsigned: string) => {
    const tx = TransactionBuilder.fromXDR(unsigned, PASSPHRASE) as Transaction;
    tx.sign(USER_KEYPAIR);
    return { signedTxXdr: tx.toXDR(), signerAddress: USER };
  };

  async function builtDeposit(options: StubOptions) {
    const stub = new StubServer(options);
    const client = clientWith(stub);
    const built = await client.deposit({
      vaultId: VAULT,
      user: USER,
      assets: 500n,
    });
    return { stub, built };
  }

  it('signs through the injected signer and returns the decoded result', async () => {
    const { stub, built } = await builtDeposit({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
      confirmation: confirmationSuccess(nativeToScVal(495n, { type: 'i128' })),
    });

    const result = await built.signAndSend(signer);

    expect(result).toEqual({
      hash: 'deadbeef',
      ledger: 101,
      status: 'SUCCESS',
      value: 495n,
    });
    expect(stub.sent).toHaveLength(1);
    expect(stub.sent[0].signatures.length).toBeGreaterThan(0);
  });

  it('does not swallow a rejected submission', async () => {
    const { built } = await builtDeposit({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
      sendStatus: 'ERROR',
    });

    await expect(built.signAndSend(signer)).rejects.toBeInstanceOf(
      VaultSubmissionError,
    );
    await expect(built.signAndSend(signer)).rejects.toMatchObject({
      hash: 'deadbeef',
      status: 'ERROR',
    });
  });

  it('does not swallow an on-chain failure', async () => {
    const { built } = await builtDeposit({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
      confirmation: {
        status: rpc.Api.GetTransactionStatus.FAILED,
      } as rpc.Api.GetTransactionResponse,
    });

    await expect(built.signAndSend(signer)).rejects.toMatchObject({
      status: 'FAILED',
    });
  });

  it('gives up when the network never confirms the transaction', async () => {
    const { stub, built } = await builtDeposit({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
    });

    await expect(built.signAndSend(signer)).rejects.toThrow(/did not confirm/);
    expect(stub.polls).toBe(2);
  });

  it('reports a null value for a method that returns nothing', async () => {
    const stub = new StubServer({
      simulation: simulationSuccess(xdr.ScVal.scvVec([])),
      confirmation: confirmationSuccess(),
    });
    const built = await clientWith(stub).pause();

    const result = await built.signAndSend(signer);

    expect(result.value).toBeNull();
  });

  it('requires a signer rather than accepting a secret key', async () => {
    const { built } = await builtDeposit({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
    });

    await expect(built.signAndSend()).rejects.toThrow(/signTransaction/);
  });

  it('uses the client-level signer when none is passed', async () => {
    const stub = new StubServer({
      simulation: simulationSuccess(nativeToScVal(500n, { type: 'i128' })),
      confirmation: confirmationSuccess(nativeToScVal(495n, { type: 'i128' })),
    });
    const client = new YieldVaultClient({
      contractId: VAULT,
      network: NETWORK,
      server: stub,
      publicKey: USER,
      signTransaction: signer,
      pollIntervalMs: 0,
      pollAttempts: 2,
    });

    const result = await (
      await client.deposit({ vaultId: VAULT, user: USER, assets: 500n })
    ).signAndSend();

    expect(result.value).toBe(495n);
  });
});
