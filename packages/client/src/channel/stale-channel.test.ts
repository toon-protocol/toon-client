/**
 * The `F01` discrimination (toon-client#581). The whole value of this module is
 * in what it REFUSES to match: the connector uses `F01` both for "I have no
 * record of that channel" (evict) and for a claim whose nonce did not advance
 * (leave alone — the channel is healthy and evicting it would strand its
 * collateral in a second on-chain open).
 */

import { describe, it, expect } from 'vitest';
import { isUnknownChannelReject, rejectNamesChannel } from './stale-channel.js';

/** The message the live devnet connector actually returns (issue #581). */
const LIVE_MESSAGE =
  'claim rejected: names a channel this connector has no record of, so ' +
  'there is no counterparty to verify its signature against';

const CHANNEL_ID = `0x${'cc'.repeat(32)}`;
const OTHER_CHANNEL_ID = `0x${'ab'.repeat(32)}`;

describe('isUnknownChannelReject', () => {
  it('matches the live "no record of" F01', () => {
    expect(
      isUnknownChannelReject({
        accepted: false,
        code: 'F01',
        message: LIVE_MESSAGE,
      })
    ).toBe(true);
  });

  it('matches the other connector generations’ phrasings', () => {
    for (const message of [
      'unknown channel',
      'Channel not found',
      'no such channel for this peer',
      'the claim names something that is not a known channel here',
    ]) {
      expect(
        isUnknownChannelReject({ accepted: false, code: 'F01', message })
      ).toBe(true);
    }
  });

  it('does NOT match a nonce-race F01 — that channel is healthy', () => {
    // Evicting here would supersede a live binding and open a SECOND on-chain
    // channel while the first still holds collateral.
    expect(
      isUnknownChannelReject({
        accepted: false,
        code: 'F01',
        message: 'claim rejected: NonceNotAdvancing (expected > 41, got 41)',
      })
    ).toBe(false);
  });

  it('lets a nonce mention veto an otherwise-matching message', () => {
    expect(
      isUnknownChannelReject({
        accepted: false,
        code: 'F01',
        message: 'no record of a claim at that nonce',
      })
    ).toBe(false);
  });

  it('does not match other reject codes, however phrased', () => {
    expect(
      isUnknownChannelReject({
        accepted: false,
        code: 'F02',
        message: 'no record of that route',
      })
    ).toBe(false);
  });

  it('does not match an accepted packet or an unrecognised F01', () => {
    expect(isUnknownChannelReject({ accepted: true, code: 'F01' })).toBe(false);
    expect(
      isUnknownChannelReject({
        accepted: false,
        code: 'F01',
        message: 'claim rejected: signature invalid',
      })
    ).toBe(false);
    expect(isUnknownChannelReject({ accepted: false, code: 'F01' })).toBe(
      false
    );
  });
});

describe('rejectNamesChannel', () => {
  it('attributes a message that names no channel to the one just used', () => {
    // The live message carries no channel id, and exactly one claim rides on
    // each packet — so the channel that produced it is the only candidate.
    expect(rejectNamesChannel(LIVE_MESSAGE, CHANNEL_ID)).toBe(true);
  });

  it('attributes a message that names this channel', () => {
    expect(
      rejectNamesChannel(`no record of channel ${CHANNEL_ID}`, CHANNEL_ID)
    ).toBe(true);
  });

  it('refuses a message that names a DIFFERENT channel', () => {
    expect(
      rejectNamesChannel(`no record of channel ${OTHER_CHANNEL_ID}`, CHANNEL_ID)
    ).toBe(false);
  });

  it('refuses a message naming a different Solana channel account', () => {
    expect(
      rejectNamesChannel(
        'no record of channel 9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM',
        'FhRg8p2LzMcE4Wn3Kq7YvJb5TxUa6DsVcNmQrZ1oPiXk'
      )
    ).toBe(false);
  });
});
