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
    /** Account MINA balance (o1js `UInt64`) — the preflight reads its total. */
    balance?: { toString(): string };
  };
}

/** Minimal o1js surface this module uses (lazy-loaded). */
export interface O1jsLike {
  Mina: any;
  PrivateKey: any;
  PublicKey: any;
  Field: any;
  AccountUpdate: any;
  /** Present on the real o1js; the deploy/ownership path uses it. */
  Poseidon?: any;
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
export async function loadMinaRuntime(): Promise<{
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

let compiledVerificationKeyHash: string | undefined;

/**
 * Lazily resolve + compile the `PaymentChannel` contract. Compilation is the
 * expensive o1js step; cache the compiled artifact so repeated opens in the
 * same process don't recompile.
 */
export async function getCompiledPaymentChannel(): Promise<any> {
  const { PaymentChannel } = await loadMinaRuntime();
  if (!compiledContract) {
    const compiled = await PaymentChannel.compile();
    // Record the vk hash for the deploy path's provenance record (drift
    // debugging: the deployed vk IS this locally compiled one by
    // construction, but keeping the hash makes that checkable later).
    compiledVerificationKeyHash =
      compiled?.verificationKey?.hash?.toString() ?? undefined;
    compiledContract = PaymentChannel;
  }
  return compiledContract;
}

/** The vk hash of the last {@link getCompiledPaymentChannel} compile, if any. */
export function getCompiledVerificationKeyHash(): string | undefined {
  return compiledVerificationKeyHash;
}

/** Test hook: reset the cached o1js + compiled-contract state. */
export function _resetMinaChannelOpenCache(): void {
  cachedO1js = null;
  cachedPaymentChannel = null;
  compiledContract = null;
  compiledVerificationKeyHash = undefined;
}

// ---------------------------------------------------------------------------
// Transaction-nesting safety (o1js currentTransaction leak)
// ---------------------------------------------------------------------------

/**
 * o1js tracks the "current transaction" in a module-level stack
 * (`Mina.currentTransaction`). `Mina.transaction(feePayer, f)` ENTERS that
 * context, runs the circuit `f`, then LEAVES it — but the fee-payer nonce read
 * (`getAccount(sender)`) happens AFTER the enter and OUTSIDE the try/finally
 * that would leave it. So when the fee payer's account is not in the cache
 * (e.g. an unfunded / nonexistent wallet — `getAccount: Could not find account
 * for public key …`), that read THROWS with the context still entered: the
 * transaction is leaked. The very next `Mina.transaction` anywhere in the
 * SAME process then hits `if (currentTransaction.has()) throw 'Cannot start
 * new transaction within another transaction'` — which is exactly what the
 * cache-invalidation retry path re-triggered after a first failed deploy.
 *
 * This pops any leaked contexts so a subsequent transaction (a retry, or the
 * next zkApp tx) starts clean. Best-effort and defensive: unknown/absent
 * context shapes are ignored.
 */
export function abandonLeakedMinaTransaction(o1js: O1jsLike): void {
  const ctx = (o1js.Mina as { currentTransaction?: unknown })
    .currentTransaction;
  const c = ctx as
    | { has?: () => boolean; id?: () => unknown; leave?: (id: unknown) => void }
    | undefined;
  if (!c || typeof c.has !== 'function' || typeof c.leave !== 'function')
    return;
  // Bounded loop — never spin if leave() does not shrink the stack.
  for (let i = 0; i < 64 && c.has(); i += 1) {
    try {
      const id = typeof c.id === 'function' ? c.id() : undefined;
      c.leave(id);
    } catch {
      break; // inconsistent context — stop rather than throw over the caller's error
    }
  }
}

/**
 * `Mina.transaction(feePayer, f)` that cannot leak the o1js currentTransaction
 * context on failure (see {@link abandonLeakedMinaTransaction}). Every Mina tx
 * this package builds goes through here so ONE failed build (unfunded fee
 * payer, prove error, …) can never poison the next attempt in the process.
 */
export async function buildMinaTransaction(
  o1js: O1jsLike,
  feePayer: unknown,
  f: () => Promise<void>
): Promise<any> {
  try {
    return await o1js.Mina.transaction(feePayer, f);
  } catch (err) {
    abandonLeakedMinaTransaction(o1js);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Fee-payer preflight (fail fast BEFORE the multi-minute circuit compile)
// ---------------------------------------------------------------------------

/** The protocol's account-creation fee for a brand-new Mina account (1 MINA). */
export const MINA_ACCOUNT_CREATION_FEE_NANOMINA = 1_000_000_000n;

/**
 * The Mina fee payer cannot fund an on-chain operation: either the account
 * does not exist on-chain yet (never received MINA) or its balance is below
 * the required minimum. Carries the address, the shortfall and the network so
 * the message is directly actionable ("send N MINA to <addr> on <network>").
 */
export class MinaFeePayerUnfundedError extends Error {
  constructor(
    readonly address: string,
    readonly requiredNanomina: bigint,
    readonly haveNanomina: bigint | undefined,
    readonly graphqlUrl: string
  ) {
    const mina = (n: bigint) => `${(Number(n) / 1e9).toFixed(3)} MINA`;
    const state =
      haveNanomina === undefined
        ? `does not exist on-chain (0 MINA)`
        : `holds only ${mina(haveNanomina)}`;
    super(
      `Mina fee-payer wallet ${address} ${state} but needs ~${mina(
        requiredNanomina
      )} to open a payment channel (≈1 MINA account-creation fee + tx fees) ` +
        `on ${graphqlUrl}. Fund ${address} and retry — no circuit was ` +
        `compiled (this check runs before the ~1-3 min compile).`
    );
    this.name = 'MinaFeePayerUnfundedError';
  }
}

/**
 * Read the fee payer's on-chain MINA balance and throw
 * {@link MinaFeePayerUnfundedError} when the account is missing or under
 * `requiredNanomina`. Runs BEFORE any circuit compile / zkApp deploy so an
 * unfunded wallet fails in seconds, not after minutes of wasted compilation.
 * The active o1js Mina instance must already be set to `graphqlUrl`.
 */
export async function assertMinaFeePayerFunded(params: {
  o1js: O1jsLike;
  payerPublicKey: { toBase58(): string };
  requiredNanomina: bigint;
  graphqlUrl: string;
}): Promise<void> {
  const { o1js, payerPublicKey, requiredNanomina, graphqlUrl } = params;
  const address = payerPublicKey.toBase58();
  const res = await o1js.fetchAccount({ publicKey: payerPublicKey });
  if (res.error || !res.account) {
    // No account on-chain → 0 MINA, cannot even pay the account-creation fee.
    throw new MinaFeePayerUnfundedError(
      address,
      requiredNanomina,
      undefined,
      graphqlUrl
    );
  }
  const raw = res.account.balance?.toString();
  const have = raw !== undefined ? BigInt(raw) : 0n;
  if (have < requiredNanomina) {
    throw new MinaFeePayerUnfundedError(
      address,
      requiredNanomina,
      have,
      graphqlUrl
    );
  }
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
  /**
   * On-chain `depositTotal` (base units), read from the zkApp appState after the
   * open/deposit settled. The Mina balance-proof signer needs this so it can bind
   * `balanceB = depositTotal − balanceA` (toon-protocol/connector#133). A channel
   * can be re-deposited, so this is the CURRENT on-chain value, not a config one.
   */
  depositTotal: bigint;
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

  // Read the on-chain `depositTotal` (appState index 4). The signer must bind
  // `balanceB = depositTotal − balanceA` against this CURRENT on-chain value
  // (connector#133); a channel can be re-deposited, so a stale config value
  // would fail the signatureA verification on settle. A missing account is a
  // hard error (same as readChannelState).
  const readDepositTotal = async (): Promise<bigint> => {
    const res = await fetchAccount({ publicKey: zkAppPublicKey });
    if (res.error || !res.account) {
      throw new Error(
        `Mina zkApp account ${params.zkAppAddress} not found on-chain (${String(
          res.error
        )}) — deploy the PaymentChannel zkApp before opening a channel`
      );
    }
    const appState = res.account.zkapp?.appState;
    const raw = appState?.[4]?.toString() ?? '0';
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

    const initTx = await buildMinaTransaction(
      await getO1js(),
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
    const depositTx = await buildMinaTransaction(
      await getO1js(),
      { sender: payerPublicKey, fee: Number(txFee) },
      async () => {
        await channel.deposit(amountField, payerPublicKey);
      }
    );
    await depositTx.prove();
    const sentDeposit = await depositTx.sign([payerPrivateKey]).send();
    depositTxHash = sentDeposit.hash ?? undefined;
    // ALWAYS wait for the deposit tx to be INCLUDED before returning — same
    // confirmation discipline as initializeChannel above (issue #158). The
    // connector's claimFromChannel runs a #126 balance-conservation gate that
    // reads the on-chain `depositTotal`; if we fire-and-forget the deposit, the
    // publish + claim race ahead and the connector reads depositTotal=0 (deposit
    // not yet in a block) → `PROOF_GENERATION_FAILED: Claim violates balance
    // conservation` and the settle aborts non-retryably. Blocking on inclusion
    // (and re-fetching) guarantees the funded depositTotal is on-chain before any
    // claim settles against it.
    await sentDeposit.wait();
    await fetchAccount({ publicKey: zkAppPublicKey });
    await fetchAccount({ publicKey: payerPublicKey });
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

  // Read the resulting on-chain depositTotal (post init+deposit confirmation, so
  // a fresh re-deposit is reflected). Best-effort: fall back to 0n if the read
  // throws on a slow node — the connector re-reads at verification time.
  let depositTotal: bigint;
  try {
    depositTotal = await readDepositTotal();
  } catch {
    depositTotal = 0n;
  }

  return {
    zkAppAddress: params.zkAppAddress,
    opened,
    initTxHash,
    depositTxHash,
    channelState: finalState,
    depositTotal,
  };
}
