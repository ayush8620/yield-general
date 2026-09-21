import {
  Account,
  BASE_FEE,
  Contract,
  Keypair,
  Transaction,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  xdr,
} from '@stellar/stellar-sdk';
import type { SignTransaction } from '@stellar/stellar-sdk/contract';

import {
  DEFAULT_NETWORK,
  DEFAULT_SOROBAN_RPC_URLS,
  networkPassphrase as passphraseFor,
  type StellarNetworkName,
} from '@yieldanchor/constants';
import type {
  Amount,
  StellarAddress,
  VaultMetadata,
  VaultState,
} from '@yieldanchor/shared-types';
import { scValToNativeSafe } from '@yieldanchor/stellar-utils';
import {
  contractIdSchema,
  depositInputSchema,
  initializeVaultInputSchema,
  redeemInputSchema,
  stellarAccountIdSchema,
  withdrawInputSchema,
  type DepositInput,
  type InitializeVaultInput,
  type RedeemInput,
  type WithdrawInput,
} from '@yieldanchor/validation';

import {
  decodeAddress,
  decodeAmount,
  decodeBoolean,
  decodeDecimals,
  decodeText,
  decodeVaultState,
} from './decode.js';
import {
  VaultClientError,
  VaultSimulationError,
  VaultSubmissionError,
} from './errors.js';
import { VAULT_METHODS } from './methods.js';
import { hexToBytes } from './salt.js';

/**
 * Typed client for the Phase 1 `YieldVault` contract.
 *
 * Three layers, deliberately separable:
 *
 * 1. **Reads** simulate a call and decode the return value. They need no
 *    signer and no funded account.
 * 2. **Builders** produce an unsigned, simulated, assembled transaction. They
 *    need a funded source account and nothing else, so a caller can inspect or
 *    sign the XDR itself.
 * 3. **Sign and send** submits through an injected `signTransaction` — the
 *    shape Freighter exposes. No secret key is ever read or accepted here.
 *
 * The RPC surface is injectable so the whole client can be exercised without a
 * network. Note that this client does not replace the contract: every rule it
 * checks locally is re-enforced on-chain.
 */

/** The subset of `rpc.Server` the client depends on. */
export interface SorobanServer {
  getAccount(address: string): Promise<Account>;
  simulateTransaction(
    tx: Transaction,
  ): Promise<rpc.Api.SimulateTransactionResponse>;
  sendTransaction(tx: Transaction): Promise<rpc.Api.SendTransactionResponse>;
  getTransaction(hash: string): Promise<rpc.Api.GetTransactionResponse>;
}

export interface YieldVaultClientOptions {
  /** Vault contract id (`C...`); validated on construction. */
  contractId: string;
  /** Named network; ignored when `networkPassphrase` is given. */
  network?: StellarNetworkName;
  networkPassphrase?: string;
  /** Soroban RPC endpoint; ignored when `server` is given. */
  rpcUrl?: string;
  server?: SorobanServer;
  /** Source account for built and simulated transactions. */
  publicKey?: string;
  /** Freighter-shaped signer. Never a secret key. */
  signTransaction?: SignTransaction;
  fee?: string;
  /** Polling applied while waiting for a submitted transaction. */
  pollIntervalMs?: number;
  pollAttempts?: number;
}

/** Result of a submitted transaction. */
export interface VaultSubmission<T> {
  hash: string;
  ledger: number | null;
  status: 'SUCCESS' | 'FAILED';
  /** Decoded return value. `null` for methods that return nothing. */
  value: T | null;
}

type Decoder<T> = (native: unknown) => T;

const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_POLL_ATTEMPTS = 30;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * An assembled, simulated transaction that has not been signed or submitted.
 *
 * Holding this object is the boundary the architecture expects between "prepare
 * an action" and "user approves an action".
 */
export class VaultTransaction<T> {
  readonly method: string;
  readonly transaction: Transaction;
  /** Decodes this method's return value; also used for the submitted result. */
  readonly decode: Decoder<T>;
  private readonly client: YieldVaultClient;

  constructor(
    transaction: Transaction,
    method: string,
    decode: Decoder<T>,
    client: YieldVaultClient,
  ) {
    this.transaction = transaction;
    this.method = method;
    this.decode = decode;
    this.client = client;
  }

  /** Base64 transaction envelope, ready to hand to a wallet. */
  toXDR(): string {
    return this.transaction.toXDR();
  }

  /**
   * Sign through the supplied (or client-configured) signer and submit.
   *
   * The signer receives only the unsigned XDR, matching Freighter's
   * `signTransaction`. A `FAILED` or rejected submission raises rather than
   * returning a partial result.
   */
  async signAndSend(
    signTransaction?: SignTransaction,
  ): Promise<VaultSubmission<T>> {
    return this.client.submit(this, signTransaction);
  }
}

export class YieldVaultClient {
  readonly contractId: string;
  readonly networkPassphrase: string;
  readonly publicKey: string | null;
  readonly signTransaction: SignTransaction | null;

  private readonly server: SorobanServer;
  private readonly contract: Contract;
  private readonly fee: string;
  private readonly pollIntervalMs: number;
  private readonly pollAttempts: number;

  constructor(options: YieldVaultClientOptions) {
    this.contractId = contractIdSchema.parse(options.contractId);

    const network = options.network ?? DEFAULT_NETWORK;
    const fallbackUrl = DEFAULT_SOROBAN_RPC_URLS[network];
    const rpcUrl = options.rpcUrl ?? fallbackUrl;
    if (!options.server && !rpcUrl) {
      throw new VaultClientError(
        `No Soroban RPC URL is configured for ${network}; pass rpcUrl or server`,
      );
    }

    this.networkPassphrase =
      options.networkPassphrase ?? passphraseFor(network);
    this.publicKey = options.publicKey
      ? stellarAccountIdSchema.parse(options.publicKey)
      : null;
    this.signTransaction = options.signTransaction ?? null;
    this.server = options.server ?? new rpc.Server(rpcUrl as string);
    this.contract = new Contract(this.contractId);
    this.fee = options.fee ?? BASE_FEE;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.pollAttempts = options.pollAttempts ?? DEFAULT_POLL_ATTEMPTS;
  }

  // --- Reads ---------------------------------------------------------------

  async getVaultState(): Promise<VaultState> {
    return decodeVaultState(await this.read(VAULT_METHODS.getVaultState, []));
  }

  /** Vault metadata derived from a single `get_vault_state` call. */
  async getMetadata(): Promise<VaultMetadata> {
    const state = await this.getVaultState();
    return {
      contractId: this.contractId,
      admin: state.admin,
      asset: state.asset,
      name: state.name,
      symbol: state.symbol,
      decimals: state.decimals,
      simulatedYield: state.simulation,
    };
  }

  async admin(): Promise<StellarAddress> {
    return decodeAddress(await this.read(VAULT_METHODS.admin, []), 'admin');
  }

  async asset(): Promise<StellarAddress> {
    return decodeAddress(await this.read(VAULT_METHODS.asset, []), 'asset');
  }

  async name(): Promise<string> {
    return decodeText(await this.read(VAULT_METHODS.name, []), 'name');
  }

  async symbol(): Promise<string> {
    return decodeText(await this.read(VAULT_METHODS.symbol, []), 'symbol');
  }

  async decimals(): Promise<number> {
    return decodeDecimals(
      await this.read(VAULT_METHODS.decimals, []),
      'decimals',
    );
  }

  async totalAssets(): Promise<Amount> {
    return decodeAmount(
      await this.read(VAULT_METHODS.totalAssets, []),
      'total assets',
    );
  }

  async totalShares(): Promise<Amount> {
    return decodeAmount(
      await this.read(VAULT_METHODS.totalShares, []),
      'total shares',
    );
  }

  async sharePrice(): Promise<Amount> {
    return decodeAmount(
      await this.read(VAULT_METHODS.sharePrice, []),
      'share price',
    );
  }

  async availableLiquidity(): Promise<Amount> {
    return decodeAmount(
      await this.read(VAULT_METHODS.availableLiquidity, []),
      'available liquidity',
    );
  }

  async balanceOf(user: StellarAddress): Promise<Amount> {
    const account = stellarAccountIdSchema.parse(user);
    return decodeAmount(
      await this.read(VAULT_METHODS.balanceOf, [this.addressArg(account)]),
      'share balance',
    );
  }

  async underlyingBalanceOf(user: StellarAddress): Promise<Amount> {
    const account = stellarAccountIdSchema.parse(user);
    return decodeAmount(
      await this.read(VAULT_METHODS.underlyingBalanceOf, [
        this.addressArg(account),
      ]),
      'underlying balance',
    );
  }

  async convertToShares(assets: bigint): Promise<Amount> {
    return decodeAmount(
      await this.read(VAULT_METHODS.convertToShares, [this.i128Arg(assets)]),
      'converted shares',
    );
  }

  async convertToAssets(shares: bigint): Promise<Amount> {
    return decodeAmount(
      await this.read(VAULT_METHODS.convertToAssets, [this.i128Arg(shares)]),
      'converted assets',
    );
  }

  async isPaused(): Promise<boolean> {
    return decodeBoolean(
      await this.read(VAULT_METHODS.isPaused, []),
      'paused flag',
    );
  }

  async isInitialized(): Promise<boolean> {
    return decodeBoolean(
      await this.read(VAULT_METHODS.isInitialized, []),
      'initialized flag',
    );
  }

  // --- Transaction builders ------------------------------------------------

  async initialize(
    input: InitializeVaultInput,
  ): Promise<VaultTransaction<null>> {
    const parsed = initializeVaultInputSchema.parse(input);
    return this.build(
      VAULT_METHODS.initialize,
      [
        this.addressArg(parsed.deployer),
        nativeToScVal(hexToBytes(parsed.salt), { type: 'bytes' }),
        this.addressArg(parsed.admin),
        this.addressArg(parsed.asset),
        nativeToScVal(parsed.name, { type: 'string' }),
        nativeToScVal(parsed.symbol, { type: 'string' }),
        nativeToScVal(parsed.decimals, { type: 'u32' }),
      ],
      () => null,
    );
  }

  async deposit(input: DepositInput): Promise<VaultTransaction<Amount>> {
    const parsed = this.assertSameVault(depositInputSchema.parse(input));
    return this.build(
      VAULT_METHODS.deposit,
      [this.addressArg(parsed.user), this.i128Arg(parsed.assets)],
      (native) => decodeAmount(native, 'minted shares'),
    );
  }

  async redeem(input: RedeemInput): Promise<VaultTransaction<Amount>> {
    const parsed = this.assertSameVault(redeemInputSchema.parse(input));
    return this.build(
      VAULT_METHODS.redeem,
      [this.addressArg(parsed.user), this.i128Arg(parsed.shares)],
      (native) => decodeAmount(native, 'redeemed assets'),
    );
  }

  async withdraw(input: WithdrawInput): Promise<VaultTransaction<Amount>> {
    const parsed = this.assertSameVault(withdrawInputSchema.parse(input));
    return this.build(
      VAULT_METHODS.withdraw,
      [this.addressArg(parsed.user), this.i128Arg(parsed.assets)],
      (native) => decodeAmount(native, 'withdrawn assets'),
    );
  }

  /** Crystallize simulated yield. Anyone may call it; it accrues monotonically. */
  async accrueYield(): Promise<VaultTransaction<Amount>> {
    return this.build(VAULT_METHODS.accrueYield, [], (native) =>
      decodeAmount(native, 'accrued yield'),
    );
  }

  async pause(): Promise<VaultTransaction<null>> {
    return this.build(VAULT_METHODS.pause, [], () => null);
  }

  async unpause(): Promise<VaultTransaction<null>> {
    return this.build(VAULT_METHODS.unpause, [], () => null);
  }

  // --- Internals -----------------------------------------------------------

  /**
   * Simulate a read-only call and return its decoded native value.
   *
   * With no configured source account a throwaway one is used, exactly as the
   * SDK's own contract client does: read functions require no authorization, so
   * nothing needs to exist on-chain.
   */
  private async read(method: string, args: xdr.ScVal[]): Promise<unknown> {
    const account = this.publicKey
      ? await this.server.getAccount(this.publicKey)
      : new Account(Keypair.random().publicKey(), '0');

    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new VaultSimulationError(method, simulation.error);
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new VaultClientError(
        `Simulating "${method}" requires a ledger-entry restoration before it can be read`,
        method,
      );
    }

    const retval = simulation.result?.retval;
    if (!retval) {
      throw new VaultClientError(
        `Simulating "${method}" returned no value`,
        method,
      );
    }
    return scValToNativeSafe(retval);
  }

  /** Build, simulate, and assemble a state-changing call. */
  private async build<T>(
    method: string,
    args: xdr.ScVal[],
    decode: Decoder<T>,
  ): Promise<VaultTransaction<T>> {
    if (!this.publicKey) {
      throw new VaultClientError(
        `Building "${method}" requires a source account; pass publicKey to the client`,
        method,
      );
    }
    const account = await this.server.getAccount(this.publicKey);
    const transaction = new TransactionBuilder(account, {
      fee: this.fee,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(this.contract.call(method, ...args))
      .setTimeout(30)
      .build();

    const simulation = await this.server.simulateTransaction(transaction);
    if (rpc.Api.isSimulationError(simulation)) {
      throw new VaultSimulationError(method, simulation.error);
    }
    if (rpc.Api.isSimulationRestore(simulation)) {
      throw new VaultClientError(
        `"${method}" requires a ledger-entry restoration before it can be submitted`,
        method,
      );
    }

    // Assemble applies the simulated footprint, resource fees and auth entries.
    const prepared = rpc
      .assembleTransaction(transaction, simulation)
      .build() as Transaction;

    return new VaultTransaction(prepared, method, decode, this);
  }

  /** @internal Called by {@link VaultTransaction.signAndSend}. */
  async submit<T>(
    vaultTransaction: VaultTransaction<T>,
    signTransaction?: SignTransaction,
  ): Promise<VaultSubmission<T>> {
    const signer = signTransaction ?? this.signTransaction;
    if (!signer) {
      throw new VaultClientError(
        `Submitting "${vaultTransaction.method}" requires a signTransaction function`,
        vaultTransaction.method,
      );
    }

    const signed = await signer(vaultTransaction.toXDR(), {
      networkPassphrase: this.networkPassphrase,
      address: this.publicKey ?? undefined,
      submit: false,
    });
    const signedTransaction = TransactionBuilder.fromXDR(
      signed.signedTxXdr,
      this.networkPassphrase,
    ) as Transaction;

    const sent = await this.server.sendTransaction(signedTransaction);
    if (sent.status === 'ERROR') {
      throw new VaultSubmissionError(
        vaultTransaction.method,
        sent.hash,
        sent.status,
        'the network rejected the transaction',
      );
    }

    const confirmation = await this.awaitConfirmation(
      vaultTransaction.method,
      sent.hash,
    );
    if (confirmation.status === 'FAILED') {
      throw new VaultSubmissionError(
        vaultTransaction.method,
        sent.hash,
        confirmation.status,
        'the transaction failed on-chain',
      );
    }

    return {
      hash: sent.hash,
      ledger: confirmation.ledger,
      status: 'SUCCESS',
      value:
        confirmation.returnValue === undefined
          ? null
          : vaultTransaction.decode(
              scValToNativeSafe(confirmation.returnValue),
            ),
    };
  }

  private async awaitConfirmation(
    method: string,
    hash: string,
  ): Promise<
    | rpc.Api.GetSuccessfulTransactionResponse
    | rpc.Api.GetFailedTransactionResponse
  > {
    for (let attempt = 0; attempt < this.pollAttempts; attempt += 1) {
      const response = await this.server.getTransaction(hash);
      if (response.status !== rpc.Api.GetTransactionStatus.NOT_FOUND) {
        return response;
      }
      await sleep(this.pollIntervalMs);
    }
    throw new VaultSubmissionError(
      method,
      hash,
      'NOT_FOUND',
      `the network did not confirm it within ${this.pollAttempts} polls`,
    );
  }

  private assertSameVault<T extends { vaultId: string }>(input: T): T {
    if (input.vaultId !== this.contractId) {
      throw new VaultClientError(
        `Input targets vault ${input.vaultId} but this client is bound to ${this.contractId}`,
      );
    }
    return input;
  }

  private addressArg(address: string): xdr.ScVal {
    return nativeToScVal(address, { type: 'address' });
  }

  private i128Arg(value: bigint): xdr.ScVal {
    return nativeToScVal(value, { type: 'i128' });
  }
}
