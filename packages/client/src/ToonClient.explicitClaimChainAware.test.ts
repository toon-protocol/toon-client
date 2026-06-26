/**
 * Unit tests for the CHAIN-AWARE explicit-claim path
 * (fix/client-explicit-claim-chain-aware).
 *
 * Root cause: when a caller pre-signs a balance proof and supplies it via
 * `publishEvent(event, { claim })`, ToonClient used to hardcode
 * `EvmSigner.buildClaimMessage(...)`. A Solana `SignedBalanceProof` (signed
 * correctly via `SolanaSigner`) was therefore wrapped as an EVM
 * `BTPClaimMessage` — no `blockchain:'solana'` discriminator, and the base58
 * channel PDA placed in the EVM `channelId` field. The connector's inbound
 * validator classifies by `msg.blockchain === 'solana'`; with the EVM envelope
 * it falls to EVM validation and rejects with F06 ("Invalid channelId format").
 *
 * The fix builds the claim with the chain-appropriate signer when the claim's
 * channelId is tracked by the ChannelManager, falling back to EVM only when no
 * signer is tracked (backward-compat for lightweight/EVM-only callers).
 *
 * These tests assert at the `publishEvent` surface that:
 *   - a tracked Solana channel produces a `blockchain:'solana'` claim with the
 *     base58 `channelAccount` (NOT an EVM `channelId` claim);
 *   - a tracked EVM channel still produces the EVM claim;
 *   - an untracked channel still falls back to the EVM claim.
 */

import { describe, it, expect, vi } from 'vitest';
import { ToonClient } from './ToonClient.js';
import { ChannelManager } from './channel/ChannelManager.js';
import { EvmSigner } from './signing/evm-signer.js';
import { SolanaSigner } from './signing/solana-signer.js';
import type { NostrEvent } from 'nostr-tools/pure';
import type { SignedBalanceProof } from './types.js';

const SECRET_KEY = new Uint8Array(32).fill(7);

// base58 channel PDA + signer pubkey (deterministic) for the Solana case.
const SOLANA_CHANNEL_PDA = 'EdJxYPDxGvaJuu57DSUptf4soLv8enpdyQJJhHDLiydG';
const SOLANA_PROGRAM_ID = '11111111111111111111111111111111';
const SOLANA_RECIPIENT = '74J6hWqWcfDQqnrfmgvCpdF3xfNXKj9PRiPmZdrhdz1z';
const SOLANA_SIGNER_PUBKEY = 'So11111111111111111111111111111111111111112';

const EVM_CHANNEL_ID =
  '0xdff44167e826f9f85e5f046f2358c79c8354691b44a89cac0e7f584612258d2d';

function baseConfig() {
  return {
    secretKey: SECRET_KEY,
    connectorUrl: 'http://localhost:9999',
    destinationAddress: 'g.proxy',
    ilpInfo: {
      pubkey: '0'.repeat(64),
      ilpAddress: 'g.toon.test',
    },
    toonEncoder: (_e: unknown) => new Uint8Array([1, 2, 3, 4]),
    toonDecoder: (_t: string) => ({}) as never,
  } as unknown as ConstructorParameters<typeof ToonClient>[0];
}

function makeEvent(): NostrEvent {
  return {
    id: 'a'.repeat(64),
    pubkey: '0'.repeat(64),
    created_at: 1_700_000_000,
    kind: 1,
    tags: [],
    content: 'hello relay',
    sig: 'b'.repeat(128),
  } as unknown as NostrEvent;
}

function makeSolanaProof(): SignedBalanceProof {
  return {
    // channelId IS the base58 Solana channel PDA.
    channelId: SOLANA_CHANNEL_PDA,
    nonce: 1,
    transferredAmount: 1_000_000n,
    lockedAmount: 0n,
    locksRoot: '0x' + '0'.repeat(64),
    // 64-byte Ed25519 signature as 0x-prefixed hex (SolanaSigner output shape).
    signature: '0x' + 'c'.repeat(128),
    signerAddress: SOLANA_SIGNER_PUBKEY,
    chainId: 0,
    tokenNetworkAddress: SOLANA_PROGRAM_ID,
    recipient: SOLANA_RECIPIENT,
  } as unknown as SignedBalanceProof;
}

function makeEvmProof(): SignedBalanceProof {
  return {
    channelId: EVM_CHANNEL_ID,
    nonce: 1,
    transferredAmount: 1_000_000n,
    lockedAmount: 0n,
    locksRoot: '0x' + '0'.repeat(64),
    signature: '0x' + 'c'.repeat(130),
    signerAddress: '0x' + 'd'.repeat(40),
    chainId: 31337,
    tokenNetworkAddress: '0x' + 'e'.repeat(40),
  } as unknown as SignedBalanceProof;
}

function injectState(client: ToonClient) {
  const sendIlpPacketWithClaim = vi.fn(async () => ({
    accepted: true,
    data: undefined,
  }));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (client as any).state = {
    bootstrapService: {},
    discoveryTracker: {},
    runtimeClient: {},
    peersDiscovered: 0,
    btpClient: { sendIlpPacketWithClaim },
  };
  return sendIlpPacketWithClaim;
}

describe('ToonClient explicit-claim path is chain-aware', () => {
  it('builds a blockchain:"solana" claim for a tracked Solana channel (not an EVM claim)', async () => {
    const client = new ToonClient(baseConfig());

    // Real ChannelManager with a Solana signer registered + a tracked Solana
    // channel matching the explicit claim's channelId (the base58 PDA).
    const cm = new ChannelManager();
    const solanaSigner = new SolanaSigner(
      new Uint8Array(32).fill(3),
      SOLANA_SIGNER_PUBKEY
    );
    cm.registerChainSigner('solana', solanaSigner);
    cm.trackChannel(SOLANA_CHANNEL_PDA, {
      chainType: 'solana',
      chainId: 0,
      tokenNetworkAddress: SOLANA_PROGRAM_ID,
      recipient: SOLANA_RECIPIENT,
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = cm;

    const sendIlpPacketWithClaim = injectState(client);

    const result = await client.publishEvent(makeEvent(), {
      claim: makeSolanaProof(),
    });
    expect(result.success).toBe(true);
    expect(sendIlpPacketWithClaim).toHaveBeenCalledTimes(1);

    const [, claimMessage] = sendIlpPacketWithClaim.mock.calls[0] ?? [];

    // Chain-aware: Solana envelope, NOT EVM.
    expect(claimMessage).toMatchObject({
      blockchain: 'solana',
      // base58 PDA lands in channelAccount, NOT a 0x EVM channelId.
      channelAccount: SOLANA_CHANNEL_PDA,
      programId: SOLANA_PROGRAM_ID,
      transferredAmount: '1000000',
      signerPublicKey: SOLANA_SIGNER_PUBKEY,
    });
    // Guard against the F06 regression: no EVM-shaped fields.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((claimMessage as any).blockchain).not.toBe('evm');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((claimMessage as any).channelId).toBeUndefined();
  });

  it('still builds the EVM claim for a tracked EVM channel', async () => {
    const client = new ToonClient(baseConfig());

    const evmSigner = new EvmSigner('0x' + '1'.repeat(64));
    const cm = new ChannelManager(evmSigner);
    cm.trackChannel(EVM_CHANNEL_ID, {
      chainType: 'evm',
      chainId: 31337,
      tokenNetworkAddress: '0x' + 'e'.repeat(40),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (client as any).channelManager = cm;

    const sendIlpPacketWithClaim = injectState(client);

    const result = await client.publishEvent(makeEvent(), {
      claim: makeEvmProof(),
    });
    expect(result.success).toBe(true);

    const [, claimMessage] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(claimMessage).toMatchObject({
      blockchain: 'evm',
      channelId: EVM_CHANNEL_ID,
      signature: makeEvmProof().signature,
      signerAddress: makeEvmProof().signerAddress,
      transferredAmount: '1000000',
    });
  });

  it('falls back to the EVM claim when no channel is tracked (backward-compat)', async () => {
    const client = new ToonClient(baseConfig());
    // No channelManager injected.
    const sendIlpPacketWithClaim = injectState(client);

    const result = await client.publishEvent(makeEvent(), {
      claim: makeEvmProof(),
    });
    expect(result.success).toBe(true);

    const [, claimMessage] = sendIlpPacketWithClaim.mock.calls[0] ?? [];
    expect(claimMessage).toMatchObject({
      blockchain: 'evm',
      channelId: EVM_CHANNEL_ID,
    });
  });
});
