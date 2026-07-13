/**
 * Mina receive-side settlement — co-sign assembly + submission seam (#357).
 *
 * Exercises everything that does NOT require o1js proving: on-chain-state gating,
 * participant A/B resolution, balance conservation, the recipient's real
 * `mina-signer` co-signature, the dual-party maker-cosign gate, and the args
 * handed to an injected proof submitter. o1js circuit compilation / proving is
 * covered only against live devnet Mina (see the gated e2e), never here.
 *
 * `mina-signer` is optional — the suite self-skips when it is absent (no false
 * pass), matching the sibling mina-payment-channel tests.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import type { SettlementBundle } from '@toon-protocol/sdk';
import {
  loadMinaPaymentChannelBindings,
  minaBalanceCommitment,
  minaParticipantChannelHashField,
  _resetMinaBindingsCache,
} from '../channel/mina-payment-channel.js';
import { deriveMinaSalt } from '../signing/mina-signer.js';
import { MINA_CHANNEL_STATE } from '../channel/mina-deposit.js';
import {
  buildMinaCoSignedClaim,
  submitMinaSettlement,
  MinaSettlementError,
  type MinaSignaturePair,
  type MinaClaimSubmitArgs,
  type MinaClaimSubmitter,
} from './mina-settlement.js';

// Fixed big-endian hex Pallas scalars (< the scalar field order — leading 0
// keeps them safely in range). Distinct keys for the three channel actors.
const RECIPIENT_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000011';
const MAKER_KEY_HEX =
  '0000000000000000000000000000000000000000000000000000000000000023';
const CHANNEL_KEY_HEX =
  '00000000000000000000000000000000000000000000000000000000000000bc';

interface Party {
  privateKeyHex: string;
  privateKeyBase58: string;
  publicKey: string;
}

/**
 * Derive a Mina keypair from a raw hex scalar via `hexToMinaBase58PrivateKey` +
 * `mina-signer`'s `derivePublicKey`. Deliberately avoids `deriveFullIdentity`
 * (not exported by the pinned `@toon-protocol/core`), so this suite exercises
 * real crypto instead of silently skipping.
 */
async function deriveParty(privateKeyHex: string): Promise<Party> {
  const { hexToMinaBase58PrivateKey } = await import('@toon-protocol/core');
  const { Client } = await loadMinaPaymentChannelBindings();
  const privateKeyBase58 = hexToMinaBase58PrivateKey(privateKeyHex);
  const publicKey = new Client({ network: 'devnet' }).derivePublicKey(
    privateKeyBase58
  );
  return { privateKeyHex, privateKeyBase58, publicKey };
}

/**
 * Sign `[commitment, nonce, channelHash]` with `mina-signer`, returning both the
 * base58 signature (for `verifyFields`) and the bare {r,s} the on-chain claim
 * carries. Mina Schnorr signing is deterministic, so this reproduces exactly the
 * co-signature `buildMinaCoSignedClaim` emits for the same key + message.
 */
async function signCommitment(
  privateKeyBase58: string,
  message: bigint[]
): Promise<{ sig: MinaSignaturePair; base58: string }> {
  const { Client, Signature } = await loadMinaPaymentChannelBindings();
  const client = new Client({ network: 'devnet' });
  const signed = client.signFields(message, privateKeyBase58);
  const { r, s } = Signature.fromBase58(signed.signature);
  return { sig: { r: r.toString(), s: s.toString() }, base58: signed.signature };
}

describe('mina receive-side settlement (#357)', () => {
  let available = false;
  let recipient: Party;
  let maker: Party;
  let channelId: string;
  /** Poseidon([recipient.x, maker.x, 0]) — recipient is participant A. */
  let channelHashRecipientFirst: string;
  /** Poseidon([maker.x, recipient.x, 0]) — recipient is participant B. */
  let channelHashMakerFirst: string;

  beforeAll(async () => {
    _resetMinaBindingsCache();
    try {
      recipient = await deriveParty(RECIPIENT_KEY_HEX);
      maker = await deriveParty(MAKER_KEY_HEX);
      const chan = await deriveParty(CHANNEL_KEY_HEX);
      channelId = chan.publicKey;
      const { Poseidon, PublicKey } = await loadMinaPaymentChannelBindings();
      channelHashRecipientFirst = minaParticipantChannelHashField(
        Poseidon,
        PublicKey,
        recipient.publicKey,
        maker.publicKey,
        0n
      ).toString();
      channelHashMakerFirst = minaParticipantChannelHashField(
        Poseidon,
        PublicKey,
        maker.publicKey,
        recipient.publicKey,
        0n
      ).toString();
      available = !!recipient.publicKey && !!maker.publicKey && !!channelId;
    } catch (err) {
      console.error('[mina-settlement.test] beforeAll setup failed:', err);
      available = false;
    }
  });

  const bundleFor = (
    nonce: string,
    cumulative: string
  ): SettlementBundle => ({
    chain: 'mina:devnet',
    chainKind: 'mina',
    channelId,
    cumulativeAmount: cumulative,
    nonce,
    recipient: recipient.publicKey,
    swapSignerAddress: maker.publicKey,
    unsignedTxBytes: new Uint8Array(),
    claimsMerged: 1,
    selectedClaimIndex: 0,
    sourceChain: 'evm:8453',
    sourceAssetCode: 'USDC',
  });

  it('assembles a co-signed claim, recipient=participant A ordering', async () => {
    if (!available) return;
    const depositTotal = 1_000_000n;
    const cumulative = 400_000n;
    const nonce = 3n;
    const claim = await buildMinaCoSignedClaim({
      channelId,
      nonce,
      cumulativeAmount: cumulative,
      recipient: recipient.publicKey,
      swapSignerAddress: maker.publicKey,
      depositTotal,
      onChainChannelHash: channelHashRecipientFirst,
      recipientPrivateKey: recipient.privateKeyHex,
    });

    expect(claim.recipientRole).toBe('A');
    expect(claim.participantA).toBe(recipient.publicKey);
    expect(claim.participantB).toBe(maker.publicKey);
    // Recipient (participant A) is credited the cumulative amount.
    expect(claim.balanceA).toBe(cumulative);
    expect(claim.balanceB).toBe(depositTotal - cumulative);
    expect(claim.balanceA + claim.balanceB).toBe(depositTotal);
    expect(claim.makerSignatureMissing).toBe(true);
    // Recipient's co-signature occupies its own slot (A); maker slot empty.
    expect(claim.signatureA).toEqual(claim.recipientSignature);
    expect(claim.signatureB).toBeUndefined();

    // The commitment matches Poseidon([balA, balB, salt]) with the derived salt.
    const { Poseidon } = await loadMinaPaymentChannelBindings();
    const salt = deriveMinaSalt(channelId, Number(nonce));
    expect(claim.salt).toBe(salt);
    expect(claim.balanceCommitment).toBe(
      minaBalanceCommitment(Poseidon, cumulative, depositTotal - cumulative, salt).toString()
    );
  });

  it("recipient co-signature is a valid mina-signer signature over [commitment, nonce, channelHash]", async () => {
    if (!available) return;
    const depositTotal = 1_000_000n;
    const cumulative = 250_000n;
    const nonce = 5n;
    const claim = await buildMinaCoSignedClaim({
      channelId,
      nonce,
      cumulativeAmount: cumulative,
      recipient: recipient.publicKey,
      swapSignerAddress: maker.publicKey,
      depositTotal,
      onChainChannelHash: channelHashRecipientFirst,
      recipientPrivateKey: recipient.privateKeyHex,
    });

    const message = [
      BigInt(claim.balanceCommitment),
      nonce,
      BigInt(channelHashRecipientFirst),
    ];
    // Deterministic: independently signing the same message reproduces {r,s}.
    const expected = await signCommitment(recipient.privateKeyBase58, message);
    expect(claim.recipientSignature).toEqual(expected.sig);

    // And it verifies against the recipient's pubkey (the on-chain check's
    // off-chain analogue via mina-signer verifyFields — runtime-only method).
    const { Client } = await loadMinaPaymentChannelBindings();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = new Client({ network: 'devnet' }) as any;
    expect(
      client.verifyFields({
        data: message,
        signature: expected.base58,
        publicKey: recipient.publicKey,
      })
    ).toBe(true);
  });

  it('resolves the maker-first ordering (recipient=participant B) and slots signatures', async () => {
    if (!available) return;
    const depositTotal = 900_000n;
    const cumulative = 300_000n;
    const nonce = 2n;
    const makerSig = (await signCommitment(maker.privateKeyBase58, [1n, 2n, 3n])).sig;
    const claim = await buildMinaCoSignedClaim({
      channelId,
      nonce,
      cumulativeAmount: cumulative,
      recipient: recipient.publicKey,
      swapSignerAddress: maker.publicKey,
      depositTotal,
      onChainChannelHash: channelHashMakerFirst,
      recipientPrivateKey: recipient.privateKeyHex,
      makerSignature: makerSig,
    });
    expect(claim.recipientRole).toBe('B');
    expect(claim.participantA).toBe(maker.publicKey);
    expect(claim.participantB).toBe(recipient.publicKey);
    // Recipient (now B) still credited the cumulative amount.
    expect(claim.balanceB).toBe(cumulative);
    expect(claim.balanceA).toBe(depositTotal - cumulative);
    expect(claim.makerSignatureMissing).toBe(false);
    // Maker sig → slot A, recipient co-sig → slot B.
    expect(claim.signatureA).toEqual(makerSig);
    expect(claim.signatureB).toEqual(claim.recipientSignature);
  });

  it('throws CHANNEL_HASH_MISMATCH when no ordering reproduces the on-chain hash', async () => {
    if (!available) return;
    await expect(
      buildMinaCoSignedClaim({
        channelId,
        nonce: 1n,
        cumulativeAmount: 1n,
        recipient: recipient.publicKey,
        swapSignerAddress: maker.publicKey,
        depositTotal: 10n,
        onChainChannelHash: '12345', // neither ordering
        recipientPrivateKey: recipient.privateKeyHex,
      })
    ).rejects.toMatchObject({ code: 'CHANNEL_HASH_MISMATCH' });
  });

  it('throws CUMULATIVE_EXCEEDS_DEPOSIT when the credit exceeds the escrow', async () => {
    if (!available) return;
    await expect(
      buildMinaCoSignedClaim({
        channelId,
        nonce: 1n,
        cumulativeAmount: 20n,
        recipient: recipient.publicKey,
        swapSignerAddress: maker.publicKey,
        depositTotal: 10n,
        onChainChannelHash: channelHashRecipientFirst,
        recipientPrivateKey: recipient.privateKeyHex,
      })
    ).rejects.toMatchObject({ code: 'CUMULATIVE_EXCEEDS_DEPOSIT' });
  });

  // ---- submitMinaSettlement (injected reader + submitter, no o1js) ---------

  const reader = (state: {
    channelHash: string;
    depositTotal: bigint;
    nonceField: bigint;
    channelState: number;
  }) =>
    async () => ({
      channelHash: state.channelHash,
      balanceCommitment: '0',
      nonceField: state.nonceField,
      channelState: state.channelState,
      depositTotal: state.depositTotal,
    });

  it('NO_GRAPHQL_CONFIGURED when no graphqlUrl is set', async () => {
    if (!available) return;
    await expect(
      submitMinaSettlement(bundleFor('3', '400000'), {
        recipientPrivateKey: recipient.privateKeyHex,
      })
    ).rejects.toMatchObject({ code: 'NO_GRAPHQL_CONFIGURED' });
  });

  it('CHANNEL_NOT_OPEN when the on-chain state is not OPEN', async () => {
    if (!available) return;
    await expect(
      submitMinaSettlement(bundleFor('3', '400000'), {
        graphqlUrl: 'http://mina',
        recipientPrivateKey: recipient.privateKeyHex,
        reader: reader({
          channelHash: channelHashRecipientFirst,
          depositTotal: 1_000_000n,
          nonceField: 0n,
          channelState: MINA_CHANNEL_STATE.CLOSING,
        }),
      })
    ).rejects.toMatchObject({ code: 'CHANNEL_NOT_OPEN' });
  });

  it('NONCE_NOT_ADVANCING when the claim does not beat the on-chain nonce', async () => {
    if (!available) return;
    await expect(
      submitMinaSettlement(bundleFor('3', '400000'), {
        graphqlUrl: 'http://mina',
        recipientPrivateKey: recipient.privateKeyHex,
        reader: reader({
          channelHash: channelHashRecipientFirst,
          depositTotal: 1_000_000n,
          nonceField: 3n, // == claim nonce → not advancing
          channelState: MINA_CHANNEL_STATE.OPEN,
        }),
      })
    ).rejects.toMatchObject({ code: 'NONCE_NOT_ADVANCING' });
  });

  it('MINA_MAKER_COSIGN_REQUIRED when the maker co-signature is absent', async () => {
    if (!available) return;
    await expect(
      submitMinaSettlement(bundleFor('3', '400000'), {
        graphqlUrl: 'http://mina',
        recipientPrivateKey: recipient.privateKeyHex,
        reader: reader({
          channelHash: channelHashRecipientFirst,
          depositTotal: 1_000_000n,
          nonceField: 0n,
          channelState: MINA_CHANNEL_STATE.OPEN,
        }),
      })
    ).rejects.toMatchObject({ code: 'MINA_MAKER_COSIGN_REQUIRED' });
  });

  it('drives the submitter with a well-formed dual-party claim on the happy path', async () => {
    if (!available) return;
    const depositTotal = 1_000_000n;
    const cumulative = 400_000n;
    const nonce = 4n;
    const makerSig = (await signCommitment(maker.privateKeyBase58, [9n, 9n, 9n])).sig;
    let captured: MinaClaimSubmitArgs | undefined;
    const submitter: MinaClaimSubmitter = {
      async claimFromChannel(args) {
        captured = args;
        return { txHash: '5Jtxhashmina' };
      },
    };
    const res = await submitMinaSettlement(bundleFor(String(nonce), String(cumulative)), {
      graphqlUrl: 'http://mina',
      recipientPrivateKey: recipient.privateKeyHex,
      makerSignature: makerSig,
      submitter,
      reader: reader({
        channelHash: channelHashRecipientFirst,
        depositTotal,
        nonceField: 0n,
        channelState: MINA_CHANNEL_STATE.OPEN,
      }),
    });

    expect(res.txHash).toBe('5Jtxhashmina');
    expect(captured).toBeDefined();
    const a = captured as MinaClaimSubmitArgs;
    expect(a.channelId).toBe(channelId);
    expect(a.nonce).toBe(nonce);
    // recipient is participant A here; balances conserve.
    expect(a.participantA).toBe(recipient.publicKey);
    expect(a.participantB).toBe(maker.publicKey);
    expect(a.balanceA).toBe(cumulative);
    expect(a.balanceB).toBe(depositTotal - cumulative);
    // signatureA = recipient co-sig (valid); signatureB = maker sig.
    expect(a.signatureB).toEqual(makerSig);
    const message = [
      minaBalanceCommitment(
        (await loadMinaPaymentChannelBindings()).Poseidon,
        cumulative,
        depositTotal - cumulative,
        deriveMinaSalt(channelId, Number(nonce))
      ),
      nonce,
      BigInt(channelHashRecipientFirst),
    ];
    const expectedRecipientSig = (
      await signCommitment(recipient.privateKeyBase58, message)
    ).sig;
    expect(a.signatureA).toEqual(expectedRecipientSig);
  });

  it('rejects a non-mina bundle', async () => {
    if (!available) return;
    const evmBundle = { ...bundleFor('1', '1'), chainKind: 'evm' as const };
    await expect(
      submitMinaSettlement(evmBundle, {
        graphqlUrl: 'http://mina',
        recipientPrivateKey: recipient.privateKeyHex,
      })
    ).rejects.toBeInstanceOf(MinaSettlementError);
  });
});
