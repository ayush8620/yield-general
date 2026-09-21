#!/usr/bin/env tsx
/**
 * YieldAnchor Protocol — Testnet deployment (TypeScript).
 *
 * The TypeScript counterpart to `deploy-yield-vault.sh`, and the path the
 * monorepo prefers: it deploys through `@yieldanchor/contract-clients`, so the
 * deployment exercises the same client, decoder, and validation code the indexer
 * and API use rather than a separate toolchain.
 *
 * Steps: verify the wasm build, load or create a funded Testnet deployer,
 * resolve the underlying asset, upload the wasm, create the contract, call
 * `initialize`, verify state by reading it back, and record the contract id.
 *
 * Run through the workspace so dependencies are resolved and built first:
 *   pnpm run contract:deploy:ts
 *
 * Environment overrides: NETWORK, RPC_URL, DEPLOYER_SECRET, ADMIN_ADDRESS,
 * ASSET_CONTRACT_ID, VAULT_NAME, VAULT_SYMBOL, VAULT_DECIMALS.
 *
 * WARNING: Phase 1 yield is a deterministic TESTNET SIMULATION keyed on ledger
 * time. It is NOT real T-Bill or RWA yield. This is not a production or audited
 * deployment.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { Asset, rpc } from '@stellar/stellar-sdk';

import { PRICE_SCALE, networkPassphrase } from '@yieldanchor/constants';
import {
  VaultClientError,
  YieldVaultClient,
  deployVaultContract,
  localSigner,
} from '@yieldanchor/contract-clients';

import {
  CONTRACT_ID_FILE,
  WASM_PATH,
  ensureFunded,
  loadDeployer,
  readSettings,
} from '../lib/testnet.js';

function loadWasm(): { wasm: Buffer; sha256: string } {
  if (!existsSync(WASM_PATH)) {
    throw new Error(
      `Contract wasm not found at ${WASM_PATH}. Build it first with:\n` +
        '  pnpm run contract:build',
    );
  }
  const wasm = readFileSync(WASM_PATH);
  return { wasm, sha256: createHash('sha256').update(wasm).digest('hex') };
}

async function main(): Promise<void> {
  const settings = readSettings();
  const { wasm, sha256 } = loadWasm();
  const server = new rpc.Server(settings.rpcUrl);
  const passphrase = networkPassphrase(settings.network);

  console.log(
    '\n── yield_vault deployment ──────────────────────────────────────',
  );
  console.log(`  network : ${settings.network} (${passphrase})`);
  console.log(`  rpc     : ${settings.rpcUrl}`);
  console.log(`  wasm    : ${wasm.length} bytes, sha256 ${sha256}`);

  console.log('\n[1/5] deployer');
  const deployer = loadDeployer();
  const admin = process.env.ADMIN_ADDRESS ?? deployer.publicKey();
  await ensureFunded(server, deployer);

  console.log('\n[2/5] underlying asset');
  // Default to the native XLM Stellar Asset Contract. A Stellar *account*
  // (`G...`) cannot serve as the token the vault moves, so the asset must be a
  // contract address (`C...`).
  const asset =
    process.env.ASSET_CONTRACT_ID ?? Asset.native().contractId(passphrase);
  if (!asset.startsWith('C')) {
    throw new Error(
      `ASSET_CONTRACT_ID must be a contract address (C...), got: ${asset}`,
    );
  }
  console.log(`  asset   : ${asset}`);

  console.log('\n[3/5] deploying');
  const deployed = await deployVaultContract({
    wasm,
    deployer,
    network: settings.network,
    rpcUrl: settings.rpcUrl,
  });
  console.log(`  upload  : ${deployed.uploadHash}`);
  console.log(`  create  : ${deployed.hash}`);
  console.log(`  contract: ${deployed.contractId}`);
  console.log(`  salt    : ${deployed.salt}`);

  console.log('\n[4/5] initialize');
  const client = new YieldVaultClient({
    contractId: deployed.contractId,
    network: settings.network,
    rpcUrl: settings.rpcUrl,
    publicKey: deployer.publicKey(),
    signTransaction: localSigner(deployer, passphrase),
  });

  if (await client.isInitialized()) {
    throw new Error(
      `${deployed.contractId} is already initialized; deployment did not create a fresh instance`,
    );
  }

  const initialized = await client
    .initialize({
      deployer: deployer.publicKey(),
      salt: deployed.salt,
      admin,
      asset,
      name: settings.name,
      symbol: settings.symbol,
      decimals: settings.decimals,
    })
    .then((transaction) => transaction.signAndSend());
  console.log(`  tx      : ${initialized.hash} (ledger ${initialized.ledger})`);

  console.log('\n[5/5] verifying');
  const state = await client.getVaultState();
  const checks: Array<[string, unknown, unknown]> = [
    ['is_initialized', await client.isInitialized(), true],
    ['admin', state.admin, admin],
    ['asset', state.asset, asset],
    ['name', state.name, settings.name],
    ['symbol', state.symbol, settings.symbol],
    ['decimals', state.decimals, settings.decimals],
    ['total_assets', state.assets, 0n],
    ['total_shares', state.shares, 0n],
    // An empty vault reports the unscaled price; see `price_from` in the
    // contract.
    ['share_price', state.price, PRICE_SCALE],
    ['paused', state.paused, false],
    // The vault must announce that its yield is simulated. If this ever reads
    // false, the deployment is not the Phase 1 simulation contract.
    ['simulation', state.simulation, true],
  ];

  let failed = 0;
  for (const [label, actual, expected] of checks) {
    const ok = String(actual) === String(expected);
    if (!ok) failed += 1;
    console.log(`  ${ok ? '✓' : '✗'} ${label.padEnd(14)} ${String(actual)}`);
  }
  if (failed > 0) {
    throw new Error(`${failed} post-deploy check(s) failed`);
  }

  writeFileSync(
    CONTRACT_ID_FILE,
    [
      `CONTRACT_ID=${deployed.contractId}`,
      `NETWORK=${settings.network}`,
      `ASSET_CONTRACT_ID=${asset}`,
      `ADMIN_ADDRESS=${admin}`,
      `WASM_SHA256=${sha256}`,
      '',
    ].join('\n'),
  );

  console.log(
    '\n── deployment complete ─────────────────────────────────────────',
  );
  console.log(`  CONTRACT_ID=${deployed.contractId}`);
  console.log(`  recorded in ${CONTRACT_ID_FILE}`);
  console.log(
    `  export it for the indexer:\n    CONTRACT_ID=${deployed.contractId}`,
  );
  console.log(
    '\n  Reminder: Phase 1 yield is TESTNET SIMULATION ONLY — not real\n' +
      '  T-Bill/RWA yield, and this deployment is neither production-ready\n' +
      '  nor audited.\n',
  );
}

main().catch((error: unknown) => {
  if (error instanceof VaultClientError) {
    console.error(`\nDeployment failed: ${error.message}`);
  } else {
    console.error(`\nDeployment failed: ${(error as Error).message ?? error}`);
  }
  process.exitCode = 1;
});
