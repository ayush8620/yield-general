import { randomBytes } from 'node:crypto';

import {
  Account,
  Address,
  BASE_FEE,
  Keypair,
  Operation,
  Transaction,
  TransactionBuilder,
  rpc,
} from '@stellar/stellar-sdk';
import type { SignTransaction } from '@stellar/stellar-sdk/contract';

import {
  DEFAULT_NETWORK,
  DEFAULT_SOROBAN_RPC_URLS,
  networkPassphrase as passphraseFor,
  type StellarNetworkName,
} from '@yieldanchor/constants';
import { scValToNativeSafe } from '@yieldanchor/stellar-utils';
import { contractIdSchema } from '@yieldanchor/validation';

import {
  VaultClientError,
  VaultSimulationError,
  VaultSubmissionError,
} from './errors.js';

/**
 * Contract deployment helpers.
 *
 * Deploying is a two-step Soroban lifecycle — upload the wasm, then create a
 * contract instance from its hash — followed by the ordinary `initialize` call
 * that {@link YieldVaultClient} already builds. This module owns the first two
 * steps so the same code path serves the deploy script, CI, and any future
 * tooling; nothing here is vault-specific beyond the naming.
 *
 * The `YieldVaultClient` deliberately refuses to hold a secret key. Deployment
 * is the one place that cannot avoid one, so it is kept separate, explicitly
 * named, and never reused for user-facing flows. See {@link localSigner} for the
 * bridge between a secret key and the wallet-shaped signer the client expects.
 */

/** The subset of `rpc.Server` the deploy helpers depend on. */
export interface DeployServer {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

/** Connection and signing context shared by the deploy helpers. */
export interface DeployContext {
  /** The account that pays for and authorizes each deployment step. */
  deployer: Keypair;
  /** Named network; ignored when `networkPassphrase` is given. */
  network?: StellarNetworkName;
  networkPassphrase?: string;
  /** Soroban RPC endpoint; ignored when `server` is given. */
  rpcUrl?: string;
  server?: DeployServer;
  fee?: string;
  pollIntervalMs?: number;
  pollAttempts?: number;
}

export interface UploadedWasm {
  /** 32-byte wasm hash, the input to contract creation. */
  wasmHash: Buffer;
  /** Transaction hash of the upload. */
  hash: string;
  ledger: number | null;
}

export interface CreatedContract {
  /** The new contract's `C...` address. */
  contractId: string;
  /** Transaction hash of the creation. */
  hash: string;
  ledger: number | null;
  /**
   * Hex-encoded salt the contract was created with. `initialize` needs it: the
   * vault proves the caller is the deployer by re-deriving its own address
   * from the deployer and this salt.
   */
  salt: string;
}

export interface DeployedVault extends CreatedContract {
  /** Hex-encoded wasm hash, for records and for `getContractWasmByHash`. */
  wasmHash: string;
  /**
   * Transaction hash of the preceding wasm upload. The inherited `hash` is the
   * creation transaction, so both steps stay attributable.
   */
  uploadHash: string;
}

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_ATTEMPTS = 30;
const WASM_HASH_LENGTH = 32;
const SALT_LENGTH = 32;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Wrap a secret key in the wallet-shaped signer the client and deploy helpers
 * consume.
 *
 * This exists so deployment tooling can reuse the exact same signing path as a
 * browser wallet, rather than a second parallel implementation. It deliberately
 * lives beside the deploy code: anything that calls it has already accepted
 * custody of a secret key, which the `YieldVaultClient` never does.
 *
 * The passphrase is a required argument rather than being read from the
 * wallet-supplied options: this signer is the one thing that can bind a
 * signature to the wrong network, so it states its network up front instead of
 * trusting whatever the caller passes at signing time.
 */
export function localSigner(
  keypair: Keypair,
  networkPassphrase: string,
): SignTransaction {
  return async (transactionXdr) => {
    const transaction = TransactionBuilder.fromXDR(
      transactionXdr,
      networkPassphrase,
    ) as Transaction;
    transaction.sign(keypair);
    return {
      signedTxXdr: transaction.toXDR(),
      signerAddress: keypair.publicKey(),
    };
  };
}

interface ResolvedContext {
  server: DeployServer;
  networkPassphrase: string;
  source: string;
  fee: string;
  pollIntervalMs: number;
  pollAttempts: number;
  signer: (transaction: Transaction) => void;
}

function resolveContext(context: DeployContext): ResolvedContext {
  const network = context.network ?? DEFAULT_NETWORK;
  const fallbackUrl = DEFAULT_SOROBAN_RPC_URLS[network];
  const rpcUrl = context.rpcUrl ?? fallbackUrl;
  if (!context.server && !rpcUrl) {
    throw new VaultClientError(
      `No Soroban RPC URL is configured for ${network}; pass rpcUrl or server`,
    );
  }

  return {
    server: context.server ?? new rpc.Server(rpcUrl as string),
    networkPassphrase: context.networkPassphrase ?? passphraseFor(network),
    source: context.deployer.publicKey(),
    fee: context.fee ?? BASE_FEE,
    pollIntervalMs: context.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    pollAttempts: context.pollAttempts ?? DEFAULT_POLL_ATTEMPTS,
    signer: (transaction) => transaction.sign(context.deployer),
  };
}

/**
 * Build, simulate, assemble, sign, and submit a single operation.
 *
 * Mirrors the submission path in `YieldVaultClient`, which cannot be reused
 * directly because these operations target the deploy lifecycle rather than the
 * vault contract.
 */
async function submitOperation(
  context: ResolvedContext,
  method: string,
  operation: Parameters<TransactionBuilder['addOperation']>[0],
): Promise<{ hash: string; ledger: number | null; value: unknown }> {
  const account = await context.server.getAccount(context.source);
  const transaction = new TransactionBuilder(account, {
    fee: context.fee,
    networkPassphrase: context.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simulation = await context.server.simulateTransaction(transaction);
  if (rpc.Api.isSimulationError(simulation)) {
    // Same error taxonomy as `YieldVaultClient`, so a caller can branch on a
    // contract error code regardless of which path produced it.
    throw new VaultSimulationError(method, simulation.error);
  }
  if (rpc.Api.isSimulationRestore(simulation)) {
    throw new VaultClientError(
      `${method} requires a ledger-entry restoration before it can be submitted`,
      method,
    );
  }

  // Assemble applies the simulated footprint, resource fees, and auth entries.
  const prepared = rpc
    .assembleTransaction(transaction, simulation)
    .build() as Transaction;
  context.signer(prepared);

  const sent = await context.server.sendTransaction(prepared);
  if (sent.status === 'ERROR') {
    throw new VaultSubmissionError(
      method,
      sent.hash,
      sent.status,
      'the network rejected the transaction',
    );
  }

  for (let attempt = 0; attempt < context.pollAttempts; attempt += 1) {
    const confirmation = await context.server.getTransaction(sent.hash);
    if (confirmation.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
      if (confirmation.status === 'FAILED') {
        throw new VaultSubmissionError(
          method,
          sent.hash,
          confirmation.status,
          'the transaction failed on-chain',
        );
      }
      const returnValue = (
        confirmation as rpc.Api.GetSuccessfulTransactionResponse
      ).returnValue;
      return {
        hash: sent.hash,
        ledger: confirmation.ledger,
        value:
          returnValue === undefined ? null : scValToNativeSafe(returnValue),
      };
    }
    await sleep(context.pollIntervalMs);
  }

  throw new VaultSubmissionError(
    method,
    sent.hash,
    'NOT_FOUND',
    `the network did not confirm it within ${context.pollAttempts} polls`,
  );
}

/**
 * Upload contract wasm to the network, returning the hash used to instantiate
 * it.
 *
 * Uploading is idempotent: re-uploading identical bytes is a no-op on-chain, so
 * redeploying the same build only costs the create step.
 */
export async function uploadContractWasm(
  context: DeployContext & { wasm: Buffer | Uint8Array },
): Promise<UploadedWasm> {
  const resolved = resolveContext(context);
  const { hash, ledger, value } = await submitOperation(
    resolved,
    'upload_contract_wasm',
    Operation.uploadContractWasm({ wasm: Buffer.from(context.wasm) }),
  );

  if (!(value instanceof Uint8Array) || value.length !== WASM_HASH_LENGTH) {
    throw new VaultClientError(
      `Upload returned an unexpected wasm hash: ${String(value)}`,
      'upload_contract_wasm',
    );
  }
  return { wasmHash: Buffer.from(value), hash, ledger };
}

/**
 * Create a contract instance from an uploaded wasm hash.
 *
 * The address is derived from the deployer plus the salt, so passing a fixed
 * `salt` yields a predictable contract address.
 */
export async function createVaultContract(
  context: DeployContext & {
    wasmHash: Buffer | Uint8Array;
    salt?: Buffer | Uint8Array;
  },
): Promise<CreatedContract> {
  const resolved = resolveContext(context);
  const wasmHash = Buffer.from(context.wasmHash);
  if (wasmHash.length !== WASM_HASH_LENGTH) {
    throw new VaultClientError(
      `Expected a ${WASM_HASH_LENGTH}-byte wasm hash, got ${wasmHash.length} bytes`,
      'create_contract',
    );
  }
  if (
    context.salt !== undefined &&
    Buffer.from(context.salt).length !== SALT_LENGTH
  ) {
    throw new VaultClientError(
      `Expected a ${SALT_LENGTH}-byte salt, got ${Buffer.from(context.salt).length} bytes`,
      'create_contract',
    );
  }

  const salt =
    context.salt === undefined
      ? randomBytes(SALT_LENGTH)
      : Buffer.from(context.salt);

  const { hash, ledger, value } = await submitOperation(
    resolved,
    'create_contract',
    Operation.createCustomContract({
      address: Address.fromString(resolved.source),
      wasmHash,
      salt,
    }),
  );

  return {
    contractId: contractIdSchema.parse(value),
    hash,
    ledger,
    salt: salt.toString('hex'),
  };
}

/**
 * Upload and instantiate in one step — the deploy lifecycle minus
 * `initialize`, which is an ordinary vault call.
 */
export async function deployVaultContract(
  context: DeployContext & {
    wasm: Buffer | Uint8Array;
    salt?: Buffer | Uint8Array;
  },
): Promise<DeployedVault> {
  const uploaded = await uploadContractWasm(context);
  const created = await createVaultContract({
    ...context,
    wasmHash: uploaded.wasmHash,
  });

  return {
    ...created,
    wasmHash: uploaded.wasmHash.toString('hex'),
    uploadHash: uploaded.hash,
  };
}
