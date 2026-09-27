/**
 * A voucher as it rides the wire: a client-edge claim under `scheme:
 * "batch-settlement"` (connector ADR 0074 decision 4, pinned by the vectors'
 * `claim_voucher.*.json`).
 *
 * It rides exactly where a `toon-channel` claim rides — the
 * `ILP-Payment-Channel-Claim` header on `POST /ilp`, and the
 * `payment-channel-claim` protocolData entry on BTP — and the carriages
 * serialize it the same way, so all that is new is the object itself.
 *
 * Keys are written in the vectors' order (sorted) and EVM hex in lowercase, so
 * `JSON.stringify` of a claim built from a vector's fields reproduces that
 * vector's `json` byte for byte. The connector parses JSON, so neither is load
 * bearing on the wire; matching the vector is what makes the replay exact.
 */

import type { BatchChannelConfig, BatchVoucher } from './evm.js';
import type { SvmBatchVoucher } from './svm.js';

/** The envelope fields every client-edge claim carries. Drawn fresh unless given. */
export interface VoucherClaimEnvelope {
  messageId?: string;
  timestamp?: string;
}

/**
 * An EVM voucher claim. `channelConfig` is carried on every voucher: the
 * connector needs it on the first one it sees for a channel, because the
 * contract stores channels by id and never gives the config back, and carrying
 * it always costs a few hundred bytes and survives a connector that lost its
 * journal.
 */
export function evmVoucherClaim(
  voucher: BatchVoucher,
  config: BatchChannelConfig,
  envelope: VoucherClaimEnvelope = {}
): Record<string, unknown> {
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
    channelId: voucher.channelId.toLowerCase(),
    maxClaimableAmount: voucher.maxClaimableAmount,
    messageId: envelope.messageId ?? crypto.randomUUID(),
    scheme: 'batch-settlement',
    senderId: config.payerAuthorizer.toLowerCase(),
    signature: voucher.signature.toLowerCase(),
    timestamp: envelope.timestamp ?? claimTimestamp(),
    version: '1.0',
  };
}

/**
 * A Solana voucher claim. `senderId` is the voucher signer — the channel's
 * `authorized_signer` — in base58, as the connector's vector names it.
 */
export function solanaVoucherClaim(
  voucher: SvmBatchVoucher,
  signer: string,
  envelope: VoucherClaimEnvelope = {}
): Record<string, unknown> {
  return {
    blockchain: 'solana',
    channelId: voucher.channelId,
    expiresAt: voucher.expiresAt,
    maxClaimableAmount: voucher.maxClaimableAmount,
    messageId: envelope.messageId ?? crypto.randomUUID(),
    scheme: 'batch-settlement',
    senderId: signer,
    signature: voucher.signature,
    timestamp: envelope.timestamp ?? claimTimestamp(),
    version: '1.0',
  };
}

/**
 * The cumulative amount the next voucher on a channel signs for, given what
 * this client has signed on it so far and the packet's charge — or `undefined`
 * when the packet should carry no voucher at all.
 *
 * A voucher has no nonce, so the connector accepts one only if its amount
 * strictly exceeds the channel's watermark, and by at least the route's charge
 * (ADR 0074 decision 3). Hence:
 *
 *   - a charge of zero sends **no** voucher. An explicitly free route admits an
 *     unpaid packet, and a voucher that did not advance would be refused as
 *     `amount_not_advancing`;
 *   - otherwise the voucher is exactly `signedSoFar + charge`: advancing by
 *     more pays more than the route asked, and by less is underpayment.
 */
export function nextVoucherAmount(
  signedSoFar: bigint,
  charge: bigint
): bigint | undefined {
  if (charge < 0n)
    throw new RangeError(`a charge cannot be negative, got ${charge}`);
  return charge === 0n ? undefined : signedSoFar + charge;
}

/** The claim envelope's timestamp: ISO-8601, milliseconds zeroed, as `EvmSigner` writes it. */
function claimTimestamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, '.000Z');
}
