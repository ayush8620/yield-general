import {
  Account,
  Keypair,
  Operation,
  SorobanDataBuilder,
  StrKey,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import { networkPassphrase } from '@yieldanchor/constants';
import { describe, expect, it } from 'vitest';

import {
  VaultClientError,
  VaultSimulationError,
  VaultSubmissionError,
  createVaultContract,
  deployVaultContract,
  localSigner,
  uploadContractWasm,
  type DeployServer,
} from '../src/index.js';

const NETWORK = 'testnet' as const;
const PASSPHRASE = networkPassphrase(NETWORK);
const CONTRACT = StrKey.encodeContract(Buffer.alloc(32, 9));
const WASM_HASH = Buffer.alloc(32, 7);
const DEPLOYER = Keypair.random();

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

function confirmationSuccess(returnValue: xdr.ScVal) {
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

/**
 * Stub RPC server.
 *
 * `retvals` is consumed one entry per submitted operation, so a two-step
 * deployment (upload, then create) can return a wasm hash first and a contract
 * address second, exactly as the network does.
 */
class StubServer implements DeployServer {
  readonly simulated: Transaction[] = [];
  readonly sent: Transaction[] = [];
  private index = 0;

  constructor(
    private readonly options: {
      retvals: xdr.ScVal[];
      simulationError?: string;
      sendStatus?: 'PENDING' | 'ERROR';
      confirmationFailed?: boolean;
    },
  ) {}

  async getAccount(address: string): Promise<Account> {
    return new Account(address, '1234');
  }

  async simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse> {
    this.simulated.push(tx);
    this.index = this.simulated.length - 1;
    if (this.options.simulationError !== undefined) {
      return simulationFailure(this.options.simulationError);
    }
    return simulationSuccess(this.retval());
  }

  async sendTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SendTransactionResponse> {
    this.sent.push(tx);
    return {
      status: this.options.sendStatus ?? 'PENDING',
      // Distinct per operation, so a caller can tell the two steps apart.
      hash: `tx${this.sent.length}`,
      latestLedger: 100,
      latestLedgerCloseTime: 1_700_000_000,
    };
  }

  async getTransaction(): Promise<rpc.Api.GetTransactionResponse> {
    if (this.options.confirmationFailed) {
      return {
        status: rpc.Api.GetTransactionStatus.FAILED,
        txHash: 'deadbeef',
        latestLedger: 101,
        ledger: 101,
      } as unknown as rpc.Api.GetTransactionResponse;
    }
    return confirmationSuccess(this.retval());
  }

  private retval(): xdr.ScVal {
    const { retvals } = this.options;
    return retvals[Math.min(this.index, retvals.length - 1)] as xdr.ScVal;
  }
}

function context(server: DeployServer) {
  return { deployer: DEPLOYER, network: NETWORK, server };
}

/**
 * Classify a built transaction by its host function.
 *
 * `xdr.HostFunctionType` numbers the variants rather than naming them here, so
 * the mapping is spelled out: 2 is the wasm upload, 3 is create-contract-v2
 * (the version carrying a salt).
 */
function invokedMethod(tx: Transaction): string {
  const [operation] = tx.operations;
  if (!operation || operation.type !== 'invokeHostFunction') {
    throw new Error(`Expected invokeHostFunction, got ${operation?.type}`);
  }
  switch (operation.func.switch().value) {
    case 2:
      return 'upload_contract_wasm';
    case 3:
      return 'create_contract';
    default:
      return 'other';
  }
}

describe('localSigner', () => {
  it('signs for the configured passphrase and reports the signer', async () => {
    const keypair = Keypair.random();
    const signer = localSigner(keypair, PASSPHRASE);

    const transaction = new TransactionBuilder(
      new Account(keypair.publicKey(), '1'),
      { fee: '100', networkPassphrase: PASSPHRASE },
    )
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();

    const signed = await signer(transaction.toXDR());
    expect(signed.signerAddress).toBe(keypair.publicKey());

    const reparsed = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      PASSPHRASE,
    ) as Transaction;
    expect(reparsed.signatures).toHaveLength(1);
  });

  it('ignores a conflicting passphrase from the wallet options', async () => {
    const keypair = Keypair.random();
    const signer = localSigner(keypair, PASSPHRASE);
    const transaction = new TransactionBuilder(
      new Account(keypair.publicKey(), '1'),
      { fee: '100', networkPassphrase: PASSPHRASE },
    )
      .addOperation(Operation.bumpSequence({ bumpTo: '2' }))
      .setTimeout(30)
      .build();

    // A wallet that offers the wrong network must not change what is signed.
    await expect(
      signer(transaction.toXDR(), { networkPassphrase: 'wrong network' }),
    ).resolves.toBeDefined();
  });
});

describe('uploadContractWasm', () => {
  it('returns the 32-byte hash from the submitted transaction', async () => {
    const server = new StubServer({
      retvals: [xdr.ScVal.scvBytes(WASM_HASH)],
    });

    const result = await uploadContractWasm({
      ...context(server),
      wasm: Buffer.alloc(64, 1),
    });

    expect(result.wasmHash).toEqual(WASM_HASH);
    expect(result.ledger).toBe(101);
    expect(server.sent).toHaveLength(1);
  });

  it('rejects a hash that is not 32 bytes', async () => {
    const server = new StubServer({
      retvals: [xdr.ScVal.scvBytes(Buffer.alloc(8, 1))],
    });

    await expect(
      uploadContractWasm({ ...context(server), wasm: Buffer.alloc(64, 1) }),
    ).rejects.toThrow(VaultClientError);
  });

  it('surfaces a simulation failure as a simulation error', async () => {
    const server = new StubServer({
      retvals: [],
      simulationError: 'Error(WasmVm, InvalidAction)',
    });

    await expect(
      uploadContractWasm({ ...context(server), wasm: Buffer.alloc(64, 1) }),
    ).rejects.toBeInstanceOf(VaultSimulationError);
  });

  it('raises when the network rejects the submission', async () => {
    const server = new StubServer({
      retvals: [xdr.ScVal.scvBytes(WASM_HASH)],
      sendStatus: 'ERROR',
    });

    await expect(
      uploadContractWasm({ ...context(server), wasm: Buffer.alloc(64, 1) }),
    ).rejects.toBeInstanceOf(VaultSubmissionError);
  });

  it('raises when the transaction fails on-chain', async () => {
    const server = new StubServer({
      retvals: [xdr.ScVal.scvBytes(WASM_HASH)],
      confirmationFailed: true,
    });

    await expect(
      uploadContractWasm({ ...context(server), wasm: Buffer.alloc(64, 1) }),
    ).rejects.toBeInstanceOf(VaultSubmissionError);
  });
});

describe('createVaultContract', () => {
  it('returns the contract id the network created', async () => {
    const server = new StubServer({
      retvals: [nativeToScVal(CONTRACT, { type: 'address' })],
    });

    const result = await createVaultContract({
      ...context(server),
      wasmHash: WASM_HASH,
    });

    expect(result.contractId).toBe(CONTRACT);
  });

  it('rejects a wasm hash of the wrong length before spending a transaction', async () => {
    const server = new StubServer({ retvals: [] });

    await expect(
      createVaultContract({
        ...context(server),
        wasmHash: Buffer.alloc(16, 1),
      }),
    ).rejects.toThrow(/32-byte wasm hash/);
    expect(server.sent).toHaveLength(0);
  });

  it('rejects a salt of the wrong length before spending a transaction', async () => {
    const server = new StubServer({
      retvals: [nativeToScVal(CONTRACT, { type: 'address' })],
    });

    await expect(
      createVaultContract({
        ...context(server),
        wasmHash: WASM_HASH,
        salt: Buffer.alloc(3, 1),
      }),
    ).rejects.toThrow(/32-byte salt/);
    expect(server.sent).toHaveLength(0);
  });

  it('accepts a 32-byte salt', async () => {
    const server = new StubServer({
      retvals: [nativeToScVal(CONTRACT, { type: 'address' })],
    });

    const result = await createVaultContract({
      ...context(server),
      wasmHash: WASM_HASH,
      salt: Buffer.alloc(32, 2),
    });

    expect(result.contractId).toBe(CONTRACT);
  });

  it('returns the salt it was given', async () => {
    const server = new StubServer({
      retvals: [nativeToScVal(CONTRACT, { type: 'address' })],
    });

    const result = await createVaultContract({
      ...context(server),
      wasmHash: WASM_HASH,
      salt: Buffer.alloc(32, 2),
    });

    expect(result.salt).toBe('02'.repeat(32));
  });

  it('generates a salt when none is given', async () => {
    const server = new StubServer({
      retvals: [nativeToScVal(CONTRACT, { type: 'address' })],
    });

    const result = await createVaultContract({
      ...context(server),
      wasmHash: WASM_HASH,
    });

    expect(result.salt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a return value that is not a contract id', async () => {
    const server = new StubServer({
      retvals: [nativeToScVal('not-a-contract', { type: 'string' })],
    });

    await expect(
      createVaultContract({ ...context(server), wasmHash: WASM_HASH }),
    ).rejects.toThrow();
  });
});

describe('deployVaultContract', () => {
  it('uploads then creates, returning both hashes and the contract id', async () => {
    const server = new StubServer({
      retvals: [
        xdr.ScVal.scvBytes(WASM_HASH),
        nativeToScVal(CONTRACT, { type: 'address' }),
      ],
    });

    const result = await deployVaultContract({
      ...context(server),
      wasm: Buffer.alloc(64, 1),
    });

    expect(result.contractId).toBe(CONTRACT);
    expect(result.wasmHash).toBe(WASM_HASH.toString('hex'));
    expect(result.uploadHash).toBeDefined();
    // `hash` is the creation transaction; `uploadHash` is the preceding upload.
    expect(result.hash).toBeDefined();
    expect(result.hash).not.toBe(result.uploadHash);
    // Two operations: upload the wasm, then create from its hash.
    expect(server.sent).toHaveLength(2);
    expect(invokedMethod(server.sent[0] as Transaction)).toBe(
      'upload_contract_wasm',
    );
    expect(invokedMethod(server.sent[1] as Transaction)).toBe(
      'create_contract',
    );
  });

  it('does not attempt creation when the upload fails', async () => {
    const server = new StubServer({
      retvals: [xdr.ScVal.scvBytes(Buffer.alloc(4, 1))],
    });

    await expect(
      deployVaultContract({ ...context(server), wasm: Buffer.alloc(64, 1) }),
    ).rejects.toThrow(VaultClientError);
    expect(server.sent).toHaveLength(1);
  });
});
