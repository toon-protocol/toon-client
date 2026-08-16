/**
 * Recognising the connector's own answer to a stale peer→channel binding
 * (toon-client#581).
 *
 * #578/#580 added a counterparty check: a cached binding whose recorded
 * counterparty disagrees with what the destination announces TODAY is
 * superseded before it is resumed. That check is a PREDICTION — it catches a
 * record that visibly disagrees with the announce. It cannot catch a record
 * whose recorded counterparty happens to look current: a node that keeps its
 * settlement address but loses its channel state (a wiped connector, a
 * restored-from-backup box, a redeployed contract) still answers every paid
 * write with
 *
 *   F01 - claim rejected: names a channel this connector has no record of
 *
 * and the only recovery, until this module existed, was hand-editing JSON.
 *
 * That reject is GROUND TRUTH rather than inference, so it is the better
 * trigger — but only for the "no record of this channel" flavour. `F01` is
 * also how the connector reports a claim whose NONCE did not advance (two
 * writes racing on one channel; see `BtpPaidWriteTransport`'s module docs).
 * Evicting a binding on a nonce race would be actively destructive: the
 * channel is fine, and re-resolving would open and fund a SECOND one while the
 * first still holds collateral. So the discrimination below is deliberately
 * conservative — a marker must positively say "unknown channel", and any
 * mention of a nonce vetoes the match. An unrecognised `F01` is left alone.
 */

/** The ILP reject code the connector uses for a refused claim. */
export const CLAIM_REJECT_CODE = 'F01';

/**
 * Phrases that mean "the claim named a channel I hold no record of". The live
 * devnet connector emits the first; the others cover the same condition as
 * phrased by the other connector generations (the TS edge, the Rust edge) so a
 * fleet upgrade does not silently turn this guard off.
 */
const UNKNOWN_CHANNEL_MARKERS = [
  'no record of',
  'unknown channel',
  'channel not found',
  'no such channel',
  'not a known channel',
];

/**
 * Phrases that mean the channel is FINE and the claim was not — a nonce that
 * did not advance, an amount below the watermark. Evicting here would strand
 * collateral in a healthy channel, so any of these vetoes the match even when
 * an unknown-channel marker is also present.
 */
const HEALTHY_CHANNEL_MARKERS = ['nonce', 'not advancing', 'watermark'];

/**
 * True when `result` is the connector reporting that the claim just sent named
 * a channel it holds no record of — the signal to evict that binding and
 * re-resolve.
 *
 * Fail-closed in the safe direction: anything that is not unambiguously an
 * unknown-channel reject returns `false` and the write fails as it does today.
 * A false negative costs one failed write; a false positive costs an on-chain
 * channel.
 */
export function isUnknownChannelReject(result: {
  accepted: boolean;
  code?: string;
  message?: string;
}): boolean {
  if (result.accepted) return false;
  if (result.code !== CLAIM_REJECT_CODE) return false;
  const message = (result.message ?? '').toLowerCase();
  if (HEALTHY_CHANNEL_MARKERS.some((m) => message.includes(m))) return false;
  return UNKNOWN_CHANNEL_MARKERS.some((m) => message.includes(m));
}

/**
 * True when the reject can be attributed to `channelId` — either because the
 * message names it, or because it names no channel at all (the live message
 * does not, and this client attaches exactly ONE claim per packet, so the
 * channel that produced that claim is the only candidate).
 *
 * The point of the check is the negative case: a message that names a
 * DIFFERENT channel is somebody else's problem and must not evict this
 * binding.
 */
export function rejectNamesChannel(
  message: string | undefined,
  channelId: string
): boolean {
  if (!message || channelId === '') return true;
  if (message.toLowerCase().includes(channelId.toLowerCase())) return true;
  return !mentionsAnyChannelId(message);
}

/**
 * Channel-id shapes across the three settlement chains: an EVM `bytes32`
 * (`0x` + 64 hex), or a base58 Solana account / Mina public key long enough
 * not to be an ordinary word.
 */
const CHANNEL_ID_SHAPES = [
  /0x[0-9a-fA-F]{64}/,
  /\b[1-9a-km-zA-HJ-NP-Z]{32,44}\b/,
];

function mentionsAnyChannelId(message: string): boolean {
  return CHANNEL_ID_SHAPES.some((shape) => shape.test(message));
}
