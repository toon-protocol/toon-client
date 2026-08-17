/**
 * Receive-side swap settlement (toon-client#352): turn persisted
 * {@link ReceivedClaimEntry} watermarks into on-chain settlement submissions.
 *
 * Building is pure and chain-agnostic — `buildSettlementTx` (sdk) re-verifies
 * the stored claim's signature and produces one {@link SettlementBundle} per
 * `(chain, channelId)` with the FINAL watermark, so N received advances net to
 * one on-chain close per channel (spec §9). Submission is chain-gated:
 *
 * - **EVM** — implemented here ({@link submitEvmSettlement}): the bundle's
 *   unsigned RLP is decoded for `to`/calldata, gas is estimated against the
 *   configured RPC, and the tx is signed by the client's EVM account (the
 *   claim recipient) and broadcast. Real submission is therefore env-gated on
 *   `chainRpcUrls[chain]` — absent RPC config yields a built-not-submitted
 *   result, never a throw.
 * - **Solana** — implemented in `./solana-settlement.ts`
 *   (`submitSolanaSettlement`, toon-client#604): the bundle is a compiled legacy
 *   Message with an all-zero recent-blockhash placeholder, so submission patches
 *   in a live blockhash, adds the ONE signature the transaction needs (the
 *   recipient's — it is also the fee payer) and broadcasts. Env-gated on a Solana
 *   RPC url; absent config yields built-not-submitted, never a throw.
 * - **Mina** — receive-side redemption needs a co-sign (`claimFromChannel`
 *   takes `signatureA` AND `signatureB`) plus o1js proof generation; the
 *   client has no receive-side co-sign path. Explicitly out of scope for #352
 *   (documented gap; follow-up: toon-client#357).
 */

import type { AccumulatedClaim } from '@toon-protocol/sdk/swap';
import {
  buildSettlementTx,
  SettlementTxError,
  type MinaSignerClientLike,
  type SettlementBundle,
  type SwapSignerConfig,
} from '@toon-protocol/sdk';
import {
  createPublicClient,
  defineChain,
  fromRlp,
  http,
  type Hex,
  type PrivateKeyAccount,
} from 'viem';
import type { ReceivedClaimEntry } from '../channel/ReceivedClaimStore.js';

/** One per-channel settlement build outcome (result-shaped, never thrown). */
export interface SwapSettlementBuild {
  chain: string;
  channelId: string;
  /** The bundle, when the claim verified and the chain config sufficed. */
  bundle?: SettlementBundle;
  /** Why no bundle was produced (missing config, failed re-verification, …). */
  error?: { code: string; message: string };
}

export interface BuildSwapSettlementsParams {
  /** Persisted watermarks to settle (typically `store.list()`, filtered). */
  entries: readonly ReceivedClaimEntry[];
  /**
   * The daemon config's leg-A `TokenNetwork` map, keyed by the FULL chain key.
   *
   * **Accepted and never read.** It is kept on this interface only so callers
   * that pass it — and the guard tests that assert doing so changes nothing —
   * keep compiling. `tokenNetworks` is the leg-A `TokenNetwork` this client pays
   * the maker *through*; no settlement on any chain is addressed to it:
   *
   * - EVM settles on the maker's leg-B `RollingSwapChannel`
   *   (toon-client#583) — see {@link swapVerifyingContracts}.
   * - Solana settles on the payment-channel program that owns the channel PDA
   *   (toon-client#604) — see {@link solanaProgramId}. Until #604 this branch
   *   DID read `tokenNetworks`, which is why Solana settlement could not be
   *   configured at all: no maker publishes a `tokenNetworks["solana:*"]`, and a
   *   `TokenNetwork` address would have been the wrong value if one did.
   *
   * @deprecated Nothing reads this. Stop passing it.
   */
  tokenNetworks?: Record<string, string>;
  /**
   * The **Solana payment-channel program** that owns the claim's channel PDA —
   * `ToonClientConfig.solanaChannel.programId`, the same program this client
   * opened the channel on.
   *
   * This is what the sdk's `signer.programId` must be: the program whose
   * `ClaimFromChannel` instruction the settlement transaction invokes and whose
   * Ed25519 precompile check authorizes the claimer. An entry that carries its
   * own pinned `verifyingContract` wins over this, exactly as for EVM.
   *
   * Absent, a Solana entry reports `MISSING_CHAIN_CONFIG` rather than settling
   * against a guess (toon-client#604).
   */
  solanaProgramId?: string;
  /**
   * Per-chain **leg-B** `RollingSwapChannel` addresses (the EIP-712
   * `verifyingContract`), keyed by the FULL chain key (e.g. `evm:base:8453`).
   *
   * FALLBACK only, for EVM entries persisted before #572: an entry that
   * carries its own `verifyingContract` (pinned at receive-verify time)
   * settles against THAT, never this map — see {@link buildSwapSettlements}.
   */
  swapVerifyingContracts?: Record<string, string>;
  /** Pre-loaded `mina-signer` client for `mina:*` re-verification. */
  minaSignerClient?: MinaSignerClientLike;
  /**
   * Re-verify the stored claim's signature at settle time (defense in depth
   * over the store file). Default `true` — the published **v2** sdk
   * (`@toon-protocol/sdk@^3`, connector#324 finding #1) verifies EVM claims
   * against the **v2** EIP-712 domain-separated balance-proof digest, the SAME
   * digest the receive-side used (`ingestReceivedClaims`). Reconstructing that
   * EIP-712 domain needs `chainId` + `verifyingContract`, which this builder
   * threads into the sdk signer config from the entry's own pinned
   * `verifyingContract` (else `swapVerifyingContracts`) — so a claim verified at
   * receipt re-verifies correctly here.
   *
   * Set `false` only to skip the settle-time re-verify entirely (e.g. when the
   * receive-side verify is treated as the sole authoritative gate); the sdk is
   * then used only to BUILD the settlement calldata.
   */
  verifySignatures?: boolean;
}

/** Rebuild the sdk `AccumulatedClaim` shape from a persisted entry. */
export function entryToAccumulatedClaim(
  entry: ReceivedClaimEntry
): AccumulatedClaim {
  return {
    packetIndex: 0,
    sourceAmount: 0n,
    targetAmount: entry.cumulativeAmount,
    claimBytes: entry.claimBytes,
    swapEphemeralPubkey: '',
    ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
    pair: entry.pair,
    receivedAt: entry.receivedAt,
    channelId: entry.channelId,
    nonce: entry.nonce.toString(),
    cumulativeAmount: entry.cumulativeAmount.toString(),
    recipient: entry.recipient,
    swapSignerAddress: entry.swapSignerAddress,
  };
}

/**
 * Parse the numeric chain id off an `evm:{network}:{chainId}` / `evm:{chainId}`
 * chain key. Returns undefined for malformed keys (reported result-shaped).
 */
export function parseEvmChainId(chain: string): number | undefined {
  const parts = chain.split(':');
  const raw = parts.length >= 3 ? parts[2] : parts[1];
  const chainId = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(chainId) && chainId > 0 ? chainId : undefined;
}

/**
 * Build one settlement bundle per persisted entry via the sdk's
 * `buildSettlementTx` (signature re-verified at settle time — a tampered
 * store never reaches a submission). Per-entry isolation: one bad channel
 * cannot block the others.
 */
export function buildSwapSettlements(
  params: BuildSwapSettlementsParams
): SwapSettlementBuild[] {
  return params.entries.map((entry) => {
    const base = { chain: entry.chain, channelId: entry.channelId };
    const signer: SwapSignerConfig = { address: entry.swapSignerAddress };
    if (entry.chain.startsWith('evm')) {
      // The contract this claim was ACTUALLY verified against (issue #572
      // pin-on-first-use) wins over the config map, so two makers with
      // different RollingSwapChannel deployments each settle against the
      // contract they were verified with. The fallback is the leg-B
      // `swapVerifyingContracts` map — NEVER `tokenNetworks` (leg A, #583).
      const contract =
        entry.verifyingContract ?? params.swapVerifyingContracts?.[entry.chain];
      const chainId = parseEvmChainId(entry.chain);
      if (!contract) {
        return {
          ...base,
          error: {
            code: 'MISSING_SWAP_VERIFYING_CONTRACT',
            message:
              `EVM settlement for ${entry.chain} needs the maker's leg-B RollingSwapChannel ` +
              `address (the EIP-712 verifyingContract). The stored watermark pinned none, and ` +
              `no swapVerifyingContracts["${entry.chain}"] is configured. This is NOT ` +
              `tokenNetworks["${entry.chain}"] — that is the leg-A TokenNetwork this client pays ` +
              `the maker through, a different contract.`,
          },
        };
      }
      if (chainId === undefined) {
        return {
          ...base,
          error: {
            code: 'MISSING_CHAIN_CONFIG',
            message:
              `EVM settlement for ${entry.chain} needs a numeric chain id in the chain key ` +
              `(e.g. "evm:84532" / "evm:base:8453").`,
          },
        };
      }
      // The sdk's settlement-tx input validation requires a lowercase 0x+40
      // hex address; the receive-side verifier accepts either case (#572).
      signer.contractAddress = contract.toLowerCase();
      signer.chainId = chainId;
    } else if (entry.chain.startsWith('solana')) {
      // The payment-channel program that OWNS this channel's PDA — the program
      // whose `ClaimFromChannel` the settlement tx invokes. An entry-pinned
      // value wins over config, as for EVM. Before #604 this read
      // `tokenNetworks` (leg A, EVM-only by its own documentation), which no
      // maker publishes for a `solana:*` key — so Solana settlement was
      // unconfigurable, and would have been addressed to the wrong contract had
      // anyone configured it.
      const programId = entry.verifyingContract ?? params.solanaProgramId;
      if (!programId) {
        return {
          ...base,
          error: {
            code: 'MISSING_CHAIN_CONFIG',
            message:
              `Solana settlement for ${entry.chain} needs the payment-channel programId that ` +
              `owns the channel PDA — configure solanaChannel.programId. This is NOT ` +
              `tokenNetworks["${entry.chain}"]: that map is the leg-A TokenNetwork this client ` +
              `pays the maker through, and is EVM-only.`,
          },
        };
      }
      signer.programId = programId;
    }
    try {
      const result = buildSettlementTx({
        claims: [entryToAccumulatedClaim(entry)],
        signers: { [entry.chain]: signer },
        recipients: { [entry.chain]: entry.recipient },
        ...(params.verifySignatures !== undefined
          ? { verifySignatures: params.verifySignatures }
          : {}),
        ...(params.minaSignerClient
          ? { minaSignerClient: params.minaSignerClient }
          : {}),
      });
      const firstRejected = result.rejected[0];
      if (firstRejected) {
        return {
          ...base,
          error: {
            code: firstRejected.reason,
            message:
              firstRejected.details ??
              `stored claim for ${entry.chain}/${entry.channelId} failed settlement re-verification`,
          },
        };
      }
      const bundle = result.bundles[0];
      if (!bundle) {
        return {
          ...base,
          error: {
            code: 'NO_BUNDLE',
            message: `buildSettlementTx produced no bundle for ${entry.chain}/${entry.channelId}`,
          },
        };
      }
      return { ...base, bundle };
    } catch (err) {
      const code = err instanceof SettlementTxError ? err.code : 'BUILD_FAILED';
      return {
        ...base,
        error: {
          code,
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  });
}

export interface SubmitEvmSettlementParams {
  /** JSON-RPC endpoint of the bundle's chain (`chainRpcUrls[bundle.chain]`). */
  rpcUrl: string;
  /** The claim recipient's EVM account (signs + pays gas for the redeem). */
  account: PrivateKeyAccount;
  /** Receipt wait bound, ms (default 60_000). */
  timeoutMs?: number;
}

export interface SubmitEvmSettlementResult {
  txHash: string;
  /** Receipt status when the wait succeeded within the bound. */
  status?: 'success' | 'reverted';
}

/**
 * Decode the unsigned legacy-RLP tx a settlement bundle carries.
 * Layout (EIP-155 unsigned): [nonce, gasPrice, gasLimit, to, value, data, chainId, 0, 0].
 */
export function decodeEvmSettlementTx(bundle: SettlementBundle): {
  to: Hex;
  data: Hex;
  chainId: number;
} {
  const fields = fromRlp(bundle.unsignedTxBytes, 'hex');
  if (!Array.isArray(fields) || fields.length !== 9) {
    throw new Error(
      `settlement bundle RLP is not a 9-field unsigned EVM tx (got ${Array.isArray(fields) ? fields.length : typeof fields})`
    );
  }
  const to = fields[3] as Hex;
  const data = fields[5] as Hex;
  const chainIdHex = fields[6] as Hex;
  const chainId = Number.parseInt(chainIdHex === '0x' ? '0x0' : chainIdHex, 16);
  if (typeof to !== 'string' || to.length !== 42) {
    throw new Error(
      `settlement tx "to" is not a 20-byte address: ${String(to)}`
    );
  }
  return { to, data: (data === '0x' ? '0x' : data) as Hex, chainId };
}

/**
 * Sign + broadcast an EVM settlement bundle from the recipient's account.
 * Gas/nonce are read from the RPC; the tx is signed locally (non-custodial)
 * and sent as a raw transaction, then awaited to a receipt (bounded).
 */
export async function submitEvmSettlement(
  bundle: SettlementBundle,
  params: SubmitEvmSettlementParams
): Promise<SubmitEvmSettlementResult> {
  if (bundle.chainKind !== 'evm') {
    throw new Error(
      `submitEvmSettlement only submits evm bundles (got ${bundle.chainKind} for ${bundle.chain})`
    );
  }
  const { to, data, chainId } = decodeEvmSettlementTx(bundle);
  const chain = defineChain({
    id: chainId,
    name: bundle.chain,
    nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [params.rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(params.rpcUrl),
  });

  const [nonce, gasPrice, gas] = await Promise.all([
    publicClient.getTransactionCount({
      address: params.account.address,
      blockTag: 'pending',
    }),
    publicClient.getGasPrice(),
    publicClient.estimateGas({ account: params.account.address, to, data }),
  ]);

  const signed = await params.account.signTransaction({
    type: 'legacy',
    chainId,
    nonce,
    gasPrice,
    gas,
    to,
    value: 0n,
    data,
  });
  const txHash = await publicClient.sendRawTransaction({
    serializedTransaction: signed,
  });
  try {
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: txHash,
      timeout: params.timeoutMs ?? 60_000,
    });
    return { txHash, status: receipt.status };
  } catch {
    // The tx is broadcast; a slow chain just means the caller re-checks later.
    return { txHash };
  }
}
