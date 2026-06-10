/**
 * On-chain Mina payment-channel open — connector-parity.
 *
 * Opens (initializes) — and optionally deposits into — a REAL on-chain Mina
 * payment channel on the deployed `PaymentChannel` zkApp, so the connector's
 * `MinaPaymentChannelSDK.getChannelState(zkAppAddress)` finds a channel whose
 * on-chain `channelState == OPEN` (status `'opened'`) and the Mina claim
 * verifies + stores. This is the Mina analog of `openSolanaChannel`
 * (`solana-payment-channel.ts`, connector#105): the client opens its own
 * per-channel on-chain state rather than relying on a pre-initialized channel.
 *
 * ## Why this is separate from `mina-payment-channel.ts`
 *
 * `mina-payment-channel.ts` builds the OFF-chain balance-proof claim with
 * `mina-signer` (no o1js — keeps the client lightweight). But INITIALIZING a
 * zkApp channel requires producing a zkApp method proof, which is heavyweight
 * o1js WASM circuit work. So this module lazily imports `o1js` +
 * `@toon-protocol/mina-zkapp` ONLY when an on-chain open is actually requested
 * (the e2e client / Node settlement path), mirroring the connector's own
 * `getO1js()` lazy-require. Both are OPTIONAL dependencies and are kept out of
 * the bundle via `tsup` `external` so npm consumers that never open a Mina
 * channel don't pay the o1js cost.
 *
 * ## Contract call (must match the connector's `MinaPaymentChannelSDK.openChannel`)
 *
 * `PaymentChannel.initializeChannel(participantA, participantB, nonce, timeout, tokenId)`
 * sets `channelState = OPEN` (1). The deployed zkApp address IS the channel id
 * (`MinaClaimMessage.zkAppAddress`), identical to the claim's channel-hash
 * preimage in `mina-payment-channel.ts`. `deposit(amount, depositor)` then
 * bumps `depositTotal` (only valid while `channelState == OPEN`).
 *
 * The zkApp is deployed out-of-band (the operator/e2e harness deploys it
 * deterministically and advertises its B62 address); this module assumes the
 * account exists and only INITIALIZES the channel on it (idempotent — if the
 * channel is already `OPEN`, it returns without re-initializing).
 *
 * @module
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { hexToMinaBase58PrivateKey } from '@toon-protocol/core';

/** Result shape of o1js `fetchAccount` (the bits we read). */
interface FetchAccountResult {
  error?: unknown;
  account?: {
    zkapp?: { appState?: { toString(): string }[] };
  };
}

/** Minimal o1js surface this module uses (lazy-loaded). */
interface O1jsLike {
  Mina: any;
  PrivateKey: any;
  PublicKey: any;
  Field: any;
  AccountUpdate: any;
  fetchAccount: (args: { publicKey: any }) => Promise<FetchAccountResult>;
}

let cachedO1js: O1jsLike | null = null;
let cachedPaymentChannel: any | null = null;
let compiledContract: any | null = null;

/**
 * Test-only override for the o1js + contract loader. When set, `loadMinaRuntime`
 * returns this instead of doing the `createRequire` resolution — so unit tests
 * can inject fakes WITHOUT pulling the real o1js WASM runtime (vitest's
 * `vi.mock` cannot intercept the CJS `require` path the production loader uses).
 */
let runtimeOverride:
  | (() => Promise<{ o1js: O1jsLike; PaymentChannel: any }>)
  | null = null;

/** Test hook: inject a fake o1js + PaymentChannel runtime. */
export function _setMinaRuntimeForTests(
  loader: (() => Promise<{ o1js: O1jsLike; PaymentChannel: any }>) | null
): void {
  runtimeOverride = loader;
}

/**
 * Resolve `o1js` AND the `PaymentChannel` contract through ONE shared module
 * instance.
 *
 * ⚠️ o1js keeps its "active Mina instance" in a module-level closure
 * (`mina-instance.js`). `@toon-protocol/mina-zkapp` ships as CommonJS, so its
 * internal `import {Mina}` is emitted as `require('o1js')` → o1js's CJS build
 * (`dist/node/index.cjs`). A bare ESM `import('o1js')` from this module resolves
 * o1js's DIFFERENT ESM build (`dist/node/index.js`) — a SEPARATE module instance
 * with a SEPARATE `activeInstance` closure. Calling `setActiveInstance` on the
 * ESM instance while `PaymentChannel.initializeChannel` reads the CJS instance
 * throws `channelState.get() failed … Must call Mina.setActiveInstance first`
 * (observed in the local-HS Mina e2e on the FIRST publish). The connector's own
 * settlement path and `scripts/deploy-mina-zkapp.ts` both work around this by
 * requiring o1js through the same anchor the zkApp uses.
 *
 * Fix: anchor a `createRequire` at the `@toon-protocol/mina-zkapp` package and
 * `require('o1js')` + the contract from there, so both share the CJS o1js
 * instance and `setActiveInstance` is visible inside the contract method. Kept
 * lazy (and `external` in tsup) so the multi-hundred-MB WASM runtime is only
 * loaded when a Mina channel is actually opened.
 */
async function loadMinaRuntime(): Promise<{
  o1js: O1jsLike;
  PaymentChannel: any;
}> {
  if (cachedO1js && cachedPaymentChannel) {
    return { o1js: cachedO1js, PaymentChannel: cachedPaymentChannel };
  }
  if (runtimeOverride) {
    const injected = await runtimeOverride();
    cachedO1js = injected.o1js;
    cachedPaymentChannel = injected.PaymentChannel;
    return injected;
  }
  const { createRequire } = await import('node:module');
  const nodePath = await import('node:path');
  // Anchor resolution at this module so the consumer's node_modules graph (where
  // both o1js and @toon-protocol/mina-zkapp are installed) resolves them, then
  // re-anchor at the mina-zkapp package so its CJS `require('o1js')` and ours are
  // the SAME physical module instance (shared active-instance closure).
  const requireHere = createRequire(import.meta.url);
  const mzkPkgPath = requireHere.resolve(
    '@toon-protocol/mina-zkapp/package.json'
  );
  const requireFromMzk = createRequire(mzkPkgPath);
  // o1js resolved from the mina-zkapp anchor → the SAME (CJS) instance the
  // contract's `require('o1js')` uses.
  const o1js = requireFromMzk('o1js') as O1jsLike;
  // ⚠️ A pnpm workspace package has NO self-referential symlink, so
  // `requireFromMzk('@toon-protocol/mina-zkapp')` fails with MODULE_NOT_FOUND.
  // Load the contract by PATH from the package's own `main` entry instead (the
  // same approach scripts/deploy-mina-zkapp.ts uses). This works in both the
  // workspace (no self-symlink) and the flat consumer node_modules layouts.
  const mzkPkgJson: { main?: string } = requireFromMzk(mzkPkgPath);
  const mzkDir = nodePath.dirname(mzkPkgPath);
  const mzkEntry = nodePath.join(mzkDir, mzkPkgJson.main ?? 'dist/index.js');
  const mzk: any = requireFromMzk(mzkEntry);
  const PaymentChannel = mzk.PaymentChannel ?? mzk.default?.PaymentChannel;
  if (!PaymentChannel) {
    throw new Error(
      '@toon-protocol/mina-zkapp does not export PaymentChannel — cannot open a Mina channel'
    );
  }
  cachedO1js = o1js;
  cachedPaymentChannel = PaymentChannel;
  return { o1js, PaymentChannel };
}

/** Lazily resolve `o1js` (shared CJS instance with the contract). */
async function getO1js(): Promise<O1jsLike> {
  return (await loadMinaRuntime()).o1js;
}

/**
 * Lazily resolve + compile the `PaymentChannel` contract. Compilation is the
 * expensive o1js step; cache the compiled artifact so repeated opens in the
 * same process don't recompile.
 */
async function getCompiledPaymentChannel(): Promise<any> {
  const { PaymentChannel } = await loadMinaRuntime();
  if (!compiledContract) {
    await PaymentChannel.compile();
    compiledContract = PaymentChannel;
  }
  return compiledContract;
}

/** Test hook: reset the cached o1js + compiled-contract state. */
export function _resetMinaChannelOpenCache(): void {
  cachedO1js = null;
  cachedPaymentChannel = null;
  compiledContract = null;
}

/** CHANNEL_STATE.OPEN from `@toon-protocol/mina-zkapp` constants. */
const MINA_CHANNEL_STATE_OPEN = 1n;
/** CHANNEL_STATE.UNINITIALIZED. */
const MINA_CHANNEL_STATE_UNINITIALIZED = 0n;

export interface OpenMinaChannelParams {
  /** Mina GraphQL endpoint of the network the zkApp is deployed on. */
  graphqlUrl: string;
  /** Deployed payment-channel zkApp B62 address (the channel id). */
  zkAppAddress: string;
  /**
   * Fee-payer / participantA `EK…` base58 private key — the client's Mina key
   * (same key the off-chain claim is signed with). Pays the Mina tx fee and
   * authorizes the `initializeChannel` (+ `deposit`) transaction.
   */
  payerPrivateKey: string;
  /**
   * participantB B62 public key — the apex's Mina settlement address. When
   * omitted, the payer is used for both participants (single-party dev channel).
   */
  peerPublicKey?: string;
  /** Channel settlement timeout in slots. Default 86400. */
  timeout?: bigint;
  /** Mina token id field (decimal string). Default '1' (native MINA). */
  tokenId?: string;
  /** Optional on-chain deposit amount (base units) after initialization. */
  deposit?: { amount: bigint };
  /** Per-call network id for the Schnorr/account prefix. Default 'devnet'. */
  networkId?: 'devnet' | 'mainnet';
  /**
   * Transaction fee in nanomina for the `initializeChannel` + `deposit` zkApp
   * method calls. Lightnet/devnet REJECTS fee-less zkApp commands with
   * "Insufficient fee", so a non-zero fee is REQUIRED. Default 100_000_000
   * (0.1 MINA), matching scripts/deploy-mina-zkapp.ts.
   */
  feeNanomina?: bigint;
}

export interface OpenMinaChannelResult {
  /** The zkApp address (channel id) — echoed for parity with the Solana opener. */
  zkAppAddress: string;
  /** True when a fresh `initializeChannel` tx was submitted this call. */
  opened: boolean;
  /** `initializeChannel` tx hash (absent when the channel was already OPEN). */
  initTxHash?: string;
  /** `deposit` tx hash, when a deposit was requested + submitted. */
  depositTxHash?: string;
  /** On-chain channelState after the call (0=UNINIT,1=OPEN,2=CLOSING,3=SETTLED). */
  channelState: number;
}

/**
 * Open (initialize) — and optionally deposit into — a real on-chain Mina
 * payment channel on the already-deployed `PaymentChannel` zkApp.
 *
 * Idempotent: if the on-chain `channelState` is already `OPEN`, returns without
 * re-initializing (mirrors `openSolanaChannel`'s "channel already exists" path).
 * Throws if the zkApp account does not exist on-chain.
 */
export async function openMinaChannelOnChain(
  params: OpenMinaChannelParams
): Promise<OpenMinaChannelResult> {
  const { Mina, PrivateKey, PublicKey, Field, AccountUpdate, fetchAccount } =
    await getO1js();

  // Use the plain-string `Mina.Network(graphqlUrl)` form (matching the
  // connector's MinaPaymentChannelSDK._setNetwork). The object form
  // (`{ networkId, mina }`) behaves inconsistently across o1js versions and left
  // the active-instance ledger unable to resolve fetched accounts
  // (`channelState.get()` → "we can't find this zkapp account"). The Schnorr
  // network prefix is governed by the off-chain signer (`networkId`), not this
  // on-chain endpoint binding.
  const network = Mina.Network(params.graphqlUrl);
  Mina.setActiveInstance(network);

  // zkApp method txs MUST carry a fee on lightnet/devnet ("Insufficient fee"
  // otherwise). 0.1 MINA matches scripts/deploy-mina-zkapp.ts.
  const txFee = params.feeNanomina ?? 100_000_000n;

  // The client's mnemonic-derived Mina key is a big-endian hex scalar (the form
  // `deriveFullIdentity()` emits); o1js `PrivateKey.fromBase58` needs the Mina
  // `EK…` base58check form. Convert (idempotent — passes an already-`EK…` key
  // through unchanged), matching what the off-chain MinaSigner does.
  const payerKeyBase58 = hexToMinaBase58PrivateKey(params.payerPrivateKey);
  const payerPrivateKey = PrivateKey.fromBase58(payerKeyBase58);
  const payerPublicKey = payerPrivateKey.toPublicKey();
  const zkAppPublicKey = PublicKey.fromBase58(params.zkAppAddress);

  // Read channelState (appState index 3) straight from the `fetchAccount`
  // result rather than `zkApp.channelState.get()`. `.get()` outside a
  // transaction is fragile here (it can throw "Must call Mina.setActiveInstance
  // first" / "can't find this zkapp account" even right after a successful
  // fetch); the network-fetched appState array is the reliable source. A
  // missing account is a hard error — the zkApp must be deployed out-of-band.
  const readChannelState = async (): Promise<bigint> => {
    const res = await fetchAccount({ publicKey: zkAppPublicKey });
    if (res.error || !res.account) {
      throw new Error(
        `Mina zkApp account ${params.zkAppAddress} not found on-chain (${String(
          res.error
        )}) — deploy the PaymentChannel zkApp before opening a channel`
      );
    }
    // PaymentChannel state field order: [channelHash, balanceCommitment,
    // nonceField, channelState, depositTotal, ...] → channelState is index 3.
    const appState = res.account.zkapp?.appState;
    const raw = appState?.[3]?.toString() ?? '0';
    return BigInt(raw);
  };

  const currentState = await readChannelState();
  await fetchAccount({ publicKey: payerPublicKey });
  let opened = false;
  let initTxHash: string | undefined;
  let zkApp: any;
  const getZkApp = async () => {
    if (!zkApp) {
      const PaymentChannel = await getCompiledPaymentChannel();
      zkApp = new PaymentChannel(zkAppPublicKey);
    }
    return zkApp;
  };

  if (currentState === MINA_CHANNEL_STATE_UNINITIALIZED) {
    const channel = await getZkApp();
    const participantA = payerPublicKey;
    const participantB = params.peerPublicKey
      ? PublicKey.fromBase58(params.peerPublicKey)
      : payerPublicKey;
    const nonce = Field(0);
    const timeoutField = Field((params.timeout ?? 86400n).toString());
    const tokenIdField = Field(params.tokenId ?? '1');

    // `initializeChannel` reads `this.channelState.getAndRequireEquals()` as a
    // precondition, which needs the zkApp account in o1js's active-instance
    // cache. Re-fetch BOTH the zkApp and the fee-payer immediately before
    // building the transaction so the precondition read resolves (a stale or
    // missing cache surfaces as "channelState.get() failed / Must call
    // setActiveInstance first" — even though the network IS set).
    await fetchAccount({ publicKey: zkAppPublicKey });
    await fetchAccount({ publicKey: payerPublicKey });

    const initTx = await Mina.transaction(
      { sender: payerPublicKey, fee: Number(txFee) },
      async () => {
        await channel.initializeChannel(
          participantA,
          participantB,
          nonce,
          timeoutField,
          tokenIdField
        );
      }
    );
    await initTx.prove();
    const sentInit = await initTx.sign([payerPrivateKey]).send();
    initTxHash = sentInit.hash ?? undefined;
    opened = true;
    // ALWAYS wait for the init tx to be INCLUDED in a block (and re-fetch the
    // account) before returning — NOT only when a deposit follows.
    //
    // Why this matters (issue #158): the two-party `channelHash =
    // Poseidon([client.x, apex.x, 0])` is only written to the zkApp's on-chain
    // state once `initializeChannel` is included in a block. If we fire-and-forget
    // the init tx, the publish proceeds immediately and the connector reads the
    // STILL-BARE zkApp (channelState=0, channelHash empty → `participants:["",""]`)
    // before the init lands, so its participant-form balance-proof reconstruction
    // mismatches → `mina_claim_verification_failed: "Invalid balance proof
    // signature"`. The EVM (`waitForTransactionReceipt`) and Solana
    // (`waitForConfirmation`) openers both confirm their open tx before returning;
    // Mina must do the same for parity. `.wait()` blocks until inclusion (lightnet
    // block time can be a few minutes).
    await sentInit.wait();
    await fetchAccount({ publicKey: zkAppPublicKey });
    await fetchAccount({ publicKey: payerPublicKey });
  } else if (currentState !== MINA_CHANNEL_STATE_OPEN) {
    // CLOSING (2) or SETTLED (3): cannot (re)open. Surface clearly.
    throw new Error(
      `Mina channel ${params.zkAppAddress} is in state ${currentState} (not UNINITIALIZED/OPEN) — cannot open`
    );
  }

  // Optional deposit (only valid while OPEN — which it now is).
  let depositTxHash: string | undefined;
  if (params.deposit && params.deposit.amount > 0n) {
    const channel = await getZkApp();
    // Re-fetch so the deposit tx sees the post-init state.
    await fetchAccount({ publicKey: zkAppPublicKey });
    const amountField = Field(params.deposit.amount.toString());
    const depositTx = await Mina.transaction(
      { sender: payerPublicKey, fee: Number(txFee) },
      async () => {
        await channel.deposit(amountField, payerPublicKey);
      }
    );
    await depositTx.prove();
    const sentDeposit = await depositTx.sign([payerPrivateKey]).send();
    depositTxHash = sentDeposit.hash ?? undefined;
  }

  // Read the resulting state from the network-fetched appState (best-effort —
  // may still reflect the pre-confirmation value on a slow node; the connector
  // re-reads at verification time). If we just opened, optimistically report
  // OPEN even if the node hasn't surfaced the new state yet.
  let finalState: number;
  try {
    finalState = Number(await readChannelState());
  } catch {
    finalState = opened
      ? Number(MINA_CHANNEL_STATE_OPEN)
      : Number(currentState);
  }
  if (opened && finalState === Number(MINA_CHANNEL_STATE_UNINITIALIZED)) {
    finalState = Number(MINA_CHANNEL_STATE_OPEN);
  }

  // Touch AccountUpdate so the (lazy) import is retained even if a future
  // refactor stops referencing it directly above; harmless no-op.
  void AccountUpdate;

  return {
    zkAppAddress: params.zkAppAddress,
    opened,
    initTxHash,
    depositTxHash,
    channelState: finalState,
  };
}
