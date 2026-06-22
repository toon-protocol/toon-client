import type { ViewSpec } from '@toon-protocol/views';
import type { ChannelsResponse, SwapRequest, SwapResponse } from '../control-api.js';
import type { JourneyPlan } from './types.js';

export interface DeFiJourneyOpts {
  /** ILP destination used for both channel open and the swap (e.g. mill peer). */
  destination: string;
  /** Total source-asset amount to swap, in source micro-units. */
  amount: string;
  /** Mill's 64-char lowercase hex Nostr pubkey (gift-wrap recipient). */
  millPubkey: string;
  /** Swap pair from kind:10032 discovery or operator-supplied. */
  pair: SwapRequest['pair'];
  /** Sender's payout address on the target chain. */
  chainRecipient: string;
  /** Split the swap into N equal packets (default 1). */
  packetCount?: number;
}

/**
 * DeFi journey: pre-open payment channel → tiny testnet swap → settlement receipt.
 *
 * Step 3's settlement-receipt panel is built by joining the swap result
 * (captured from step 2's renderPanel via closure) with the toon_channels
 * watermark — no non-existent toon_settle tool is involved.
 */
export function deFiJourney(opts: DeFiJourneyOpts): JourneyPlan {
  let capturedSwap: SwapResponse | undefined;

  return {
    id: 'defi',
    title: 'DeFi Journey: Open Channel → Swap → Settlement Receipt',
    steps: [
      {
        id: 'open-channel',
        toolName: 'toon_open_channel',
        buildInput: (_state) => ({ destination: opts.destination }),
        renderPanel: (data): ViewSpec => {
          const { channelId } = data as { channelId: string };
          return {
            title: 'Payment Channel',
            root: {
              atom: 'stack',
              children: [{ atom: 'channel-card', props: { channelId } }],
            },
          };
        },
      },
      {
        id: 'swap',
        toolName: 'toon_swap',
        buildInput: (_state): Record<string, unknown> => {
          const args: Record<string, unknown> = {
            destination: opts.destination,
            amount: opts.amount,
            millPubkey: opts.millPubkey,
            pair: opts.pair,
            chainRecipient: opts.chainRecipient,
          };
          if (opts.packetCount !== undefined) {
            args['packetCount'] = opts.packetCount;
          }
          return args;
        },
        renderPanel: (data): ViewSpec => {
          capturedSwap = data as SwapResponse;
          return {
            title: 'Swap',
            root: {
              atom: 'stack',
              children: [
                {
                  atom: 'swap-form',
                  props: {
                    accepted: capturedSwap.accepted,
                    packetsAccepted: capturedSwap.packetsAccepted,
                    cumulativeSource: capturedSwap.cumulativeSource,
                    cumulativeTarget: capturedSwap.cumulativeTarget,
                    state: capturedSwap.state,
                    claims: capturedSwap.claims,
                  },
                },
              ],
            },
          };
        },
      },
      {
        id: 'settlement-receipt',
        toolName: 'toon_channels',
        buildInput: (_state) => ({}),
        renderPanel: (data): ViewSpec => {
          const { channels } = data as ChannelsResponse;
          const swap = capturedSwap;
          return {
            title: 'Settlement Receipt',
            root: {
              atom: 'stack',
              children: [
                {
                  atom: 'settlement-receipt',
                  props: {
                    accepted: swap?.accepted,
                    cumulativeSource: swap?.cumulativeSource,
                    cumulativeTarget: swap?.cumulativeTarget,
                    claims: swap?.claims ?? [],
                    channels,
                  },
                },
              ],
            },
          };
        },
      },
    ],
  };
}
