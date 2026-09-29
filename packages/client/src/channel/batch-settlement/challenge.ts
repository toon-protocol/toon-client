/**
 * The voucher claim-state challenge: a read-only "I control this channel's
 * voucher signer, until `expires`", distinct from a voucher (connector
 * `connector-signer`'s `claim_state_challenge`, ADR 0075; pinned by the
 * vectors' `voucher_claim_state_challenge` and `client_auth_channel_challenge`).
 *
 * One message serves every place a client proves control without moving value:
 *
 *   - `POST /ilp/claim-state`, which answers with the connector's own watermark
 *     for the channel;
 *   - the BTP `auth` frame's `channelChallenge`, which binds the session to the
 *     channel before it has presented a voucher.
 *
 * It must never verify as a voucher, so it signs a domain-separated message:
 *
 *   - **EVM** — `ClaimStateChallenge(bytes32 channelId,uint256 expires)` under
 *     `x402BatchSettlement`'s EIP-712 domain: the voucher's domain, a
 *     different type hash;
 *   - **Solana** — Ed25519 over `"toon-voucher-claim-state-challenge-v1" ‖
 *     channel account ‖ expires u64 LE`, which does not begin with a
 *     voucher's `0x56 0x01`.
 *
 * Replay protection is `expires` alone, so a challenge is signed fresh each
 * time and never lives long: BTP auth refuses one more than 300 s ahead.
 */

import { hashTypedData, type Hex } from 'viem';
import { ed25519 } from '@noble/curves/ed25519.js';
import { base58Decode } from '../../utils/base58.js';
import { encodeUtf8, toBase64 } from '../../utils/binary.js';
import type { Signer } from '../solana/payment-channel.js';
import {
  X402_BATCH_SETTLEMENT_ADDRESS,
  type BatchChannelConfig,
  type TypedDataSigner,
} from './evm.js';

const CLAIM_STATE_CHALLENGE_TYPES = {
  ClaimStateChallenge: [
    { name: 'channelId', type: 'bytes32' },
    { name: 'expires', type: 'uint256' },
  ],
} as const;

const SOLANA_CHALLENGE_TAG = encodeUtf8(
  'toon-voucher-claim-state-challenge-v1'
);

/** How far ahead a BTP `channelChallenge` may expire and still bind a session. */
export const CHANNEL_CHALLENGE_MAX_LIFETIME_SECONDS = 300;

function domain(chainId: number) {
  return {
    name: 'x402 Batch Settlement',
    version: '1',
    chainId,
    verifyingContract: X402_BATCH_SETTLEMENT_ADDRESS as Hex,
  } as const;
}

/** The EIP-712 digest an EVM voucher signer signs to prove control of `channelId`. */
export function evmChallengeDigest(
  chainId: number,
  channelId: Hex,
  expires: bigint
): Hex {
  return hashTypedData({
    domain: domain(chainId),
    types: CLAIM_STATE_CHALLENGE_TYPES,
    primaryType: 'ClaimStateChallenge',
    message: { channelId, expires },
  });
}

/** The bytes a Solana `authorized_signer` signs to prove control of `channelAccount`. */
export function solanaChallengeMessage(
  channelAccount: string,
  expires: bigint
): Uint8Array {
  const out = new Uint8Array(SOLANA_CHALLENGE_TAG.length + 32 + 8);
  out.set(SOLANA_CHALLENGE_TAG, 0);
  out.set(base58Decode(channelAccount), SOLANA_CHALLENGE_TAG.length);
  new DataView(out.buffer).setBigUint64(
    SOLANA_CHALLENGE_TAG.length + 32,
    expires,
    true
  );
  return out;
}

/**
 * An EVM challenge entry, in the vectors' key order. It carries the channel's
 * `channelConfig`, so a connector that has not yet seen a voucher on the
 * channel can still resolve its signer.
 */
export async function signEvmChallenge(
  signer: TypedDataSigner,
  chainId: number,
  config: BatchChannelConfig,
  channelId: Hex,
  expires: bigint
): Promise<Record<string, unknown>> {
  const signature = await signer.signTypedData({
    domain: domain(chainId),
    types: CLAIM_STATE_CHALLENGE_TYPES,
    primaryType: 'ClaimStateChallenge',
    message: { channelId, expires },
  } as never);
  return {
    blockchain: 'evm',
    channelConfig: {
      payer: config.payer.toLowerCase(),
      payerAuthorizer: config.payerAuthorizer.toLowerCase(),
      receiver: config.receiver.toLowerCase(),
      receiverAuthorizer: config.receiverAuthorizer.toLowerCase(),
      salt: config.salt.toLowerCase(),
      token: config.token.toLowerCase(),
      withdrawDelay: config.withdrawDelay,
    },
    channelId: channelId.toLowerCase(),
    expires: Number(expires),
    scheme: 'batch-settlement',
    signature: signature.toLowerCase(),
  };
}

/** A Solana challenge entry, in the vectors' key order; the signature is base64. */
export function signSolanaChallenge(
  signer: Signer,
  channelAccount: string,
  expires: bigint
): Record<string, unknown> {
  const signature = ed25519.sign(
    solanaChallengeMessage(channelAccount, expires),
    signer.privateKey
  );
  return {
    blockchain: 'solana',
    channelAccount,
    expires: Number(expires),
    scheme: 'batch-settlement',
    signature: toBase64(signature),
  };
}
