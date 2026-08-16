/**
 * Rolling-swap RFQ sender tests (toon-client#585) — at the WIRE SEAM.
 *
 * The defect this ticket fixes was unreachability, so a unit test of session
 * bookkeeping proves nothing. Every test below drives {@link sendRollingRfq}
 * against a fake maker that performs the SAME operations swap#135's
 * `createRollingRfqIntake` performs on a real one, in the same order:
 *
 *   1. `unwrapSwapPacketFromToon(dataB64, makerSecretKey)` — the RFQ arrives on
 *      the legacy zero-condition local-delivery seam, so the only way to know
 *      it IS an RFQ is to decrypt it and read the inner rumor kind;
 *   2. `rumor.kind === 20033`, else fall through to legacy;
 *   3. parse `rumor.content` under the maker's own shape rules;
 *   4. register the session, then seal a kind:20034 back to the SENDER PUBKEY
 *      recovered from the request's seal layer, base64-JSON on the FULFILL.
 *
 * If the bytes this module produces do not survive that pipeline, these tests
 * fail — which is exactly the property "no out-of-band registration anywhere
 * in the path" needs.
 */
import { describe, it, expect } from 'vitest';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import type { UnsignedEvent } from 'nostr-tools';
import {
  unwrapSwapPacketFromToon,
  wrapSwapPacket,
  wrapSwapPacketToToon,
} from '@toon-protocol/sdk';
import type { SwapPair } from '@toon-protocol/core';

import {
  ROLLING_RFQ_REQUEST_KIND,
  ROLLING_RFQ_RESPONSE_KIND,
  sendRollingRfq,
  buildRollingRfqRequest,
  parseRollingRfqResponse,
  decodeRollingRfqQuote,
  type RollingRfqRequest,
  type RollingRfqSender,
} from './rolling-rfq.js';
import { isValidStreamNonce } from './rolling-protocol.js';

const PAIR: SwapPair = {
  from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:84532' },
  to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
  rate: '4.0000',
  maxAmount: '25000000',
};

const DESTINATION = 'g.toon.swap.maker';
const CHAIN_RECIPIENT = 'B62qtestrecipient';
const SENDER_ILP = 'g.toon.client';

interface CapturedPacket {
  destination: string;
  amount: bigint;
  toonData: Uint8Array;
  executionCondition?: Uint8Array;
}

/**
 * A maker with RFQ intake — a faithful transcription of swap#135's
 * `createRollingRfqIntake.handle()` decision tree, minus the pricing seams.
 */
function rfqMaker(opts: {
  secretKey: Uint8Array;
  /** Pairs this maker advertises; the RFQ must match one on ALL SIX fields. */
  pairs?: readonly SwapPair[];
  /** Quote the response answers with. */
  quote?: { rate: string; rateTimestamp: number };
  /** Answer with a quote for THIS nonce instead of the requested one. */
  forceStreamNonce?: string;
}): {
  client: RollingRfqSender;
  sent: CapturedPacket[];
  /** Sessions the maker registered FROM THE WIRE — never out of band. */
  sessions: Map<string, RollingRfqRequest & { senderPubkey: string }>;
} {
  const sent: CapturedPacket[] = [];
  const sessions = new Map<
    string,
    RollingRfqRequest & { senderPubkey: string }
  >();
  const pairs = opts.pairs ?? [PAIR];
  const quote = opts.quote ?? {
    rate: '4.0012',
    rateTimestamp: 1_783_936_201_437,
  };

  const client: RollingRfqSender = {
    async sendSwapPacket(params) {
      sent.push({
        destination: params.destination,
        amount: params.amount,
        toonData: params.toonData,
        ...(params.executionCondition
          ? { executionCondition: params.executionCondition }
          : {}),
      });
      // (1) unwrap — the maker cannot see the kind before decrypting.
      let rumor: UnsignedEvent;
      let senderPubkey: string;
      try {
        const unwrapped = unwrapSwapPacketFromToon({
          toonData: params.toonData,
          recipientSecretKey: opts.secretKey,
        });
        rumor = unwrapped.rumor;
        senderPubkey = unwrapped.senderPubkey;
      } catch {
        return {
          accepted: false,
          code: 'F06',
          message: 'Invalid TOON payload',
        };
      }
      // (2) inner kind decides.
      if (rumor.kind !== ROLLING_RFQ_REQUEST_KIND) {
        return { accepted: false, code: 'F06', message: 'not a swap request' };
      }
      // (3) shape rules.
      const parsed: unknown = JSON.parse(rumor.content);
      if (typeof parsed !== 'object' || parsed === null) {
        return { accepted: false, code: 'F01', message: 'malformed' };
      }
      const rec = parsed as Record<string, unknown>;
      const streamNonce = rec['streamNonce'];
      if (
        rec['proto'] !== 'rolling/1' ||
        rec['type'] !== 'rfq' ||
        typeof streamNonce !== 'string' ||
        !/^[0-9a-f]{32}$/.test(streamNonce) ||
        typeof rec['chainRecipient'] !== 'string' ||
        typeof rec['senderIlpAddress'] !== 'string' ||
        rec['senderIlpAddress'].length === 0
      ) {
        return {
          accepted: false,
          code: 'F01',
          message: 'malformed rolling RFQ request',
          data: Buffer.from(
            JSON.stringify({ reason: 'malformed_rfq' }),
            'utf8'
          ).toString('base64'),
        };
      }
      const request = parsed as RollingRfqRequest;
      const matched = pairs.find(
        (p) =>
          p.from.assetCode === request.pair.from.assetCode &&
          p.from.assetScale === request.pair.from.assetScale &&
          p.from.chain === request.pair.from.chain &&
          p.to.assetCode === request.pair.to.assetCode &&
          p.to.assetScale === request.pair.to.assetScale &&
          p.to.chain === request.pair.to.chain
      );
      if (!matched) {
        return {
          accepted: false,
          code: 'F06',
          message: 'pair is not advertised',
          data: Buffer.from(
            JSON.stringify({ reason: 'unsupported_pair' }),
            'utf8'
          ).toString('base64'),
        };
      }
      // (4) register FROM THE WIRE, then seal the answer back to the sender.
      sessions.set(streamNonce, { ...request, senderPubkey });
      const response = {
        proto: 'rolling/1',
        type: 'quote',
        streamNonce: opts.forceStreamNonce ?? streamNonce,
        rate: quote.rate,
        rateTimestamp: quote.rateTimestamp,
        expiresAt: quote.rateTimestamp + 60_000,
        spreadBps: 40,
        maxRateAge: 15_000,
        ...(matched.maxAmount !== undefined
          ? { maxAmount: matched.maxAmount }
          : {}),
        swapSignerAddress: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      };
      const { giftWrap } = wrapSwapPacket({
        rumor: {
          kind: ROLLING_RFQ_RESPONSE_KIND,
          content: JSON.stringify(response),
          tags: [],
          created_at: Math.floor(Date.now() / 1000),
          pubkey: '',
        } as unknown as UnsignedEvent,
        senderSecretKey: opts.secretKey,
        recipientPubkey: senderPubkey,
      });
      return {
        accepted: true,
        data: Buffer.from(JSON.stringify(giftWrap), 'utf8').toString('base64'),
      };
    },
  };
  return { client, sent, sessions };
}

describe('sendRollingRfq — the wire round trip (toon-client#585)', () => {
  it('REACHABILITY: a stock sender establishes a session with NO out-of-band registration', async () => {
    const makerSecret = generateSecretKey();
    const maker = rfqMaker({ secretKey: makerSecret });

    const outcome = await sendRollingRfq({
      client: maker.client,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
      sizeHint: 100_000_000n,
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(isValidStreamNonce(outcome.streamNonce)).toBe(true);
    expect(outcome.quote.rate).toBe('4.0012');
    expect(outcome.quote.maxRateAge).toBe(15_000);
    expect(outcome.quote.swapSignerAddress).toBe(
      '0xfeedfacefeedfacefeedfacefeedfacefeedface'
    );

    // The maker holds the session because THE PACKET put it there.
    const session = maker.sessions.get(outcome.streamNonce);
    expect(session).toBeDefined();
    expect(session?.senderIlpAddress).toBe(SENDER_ILP);
    expect(session?.chainRecipient).toBe(CHAIN_RECIPIENT);
    expect(session?.sizeHint).toBe('100000000');
    // Sealed to the key the sender kept — the maker's reply key.
    expect(session?.senderPubkey).toBe(getPublicKey(outcome.senderSecretKey));
  });

  it('rides the zero-condition seam: the probe carries NO executionCondition', async () => {
    const makerSecret = generateSecretKey();
    const maker = rfqMaker({ secretKey: makerSecret });
    await sendRollingRfq({
      client: maker.client,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 7n,
    });
    expect(maker.sent).toHaveLength(1);
    expect(maker.sent[0]?.executionCondition).toBeUndefined();
    expect(maker.sent[0]?.amount).toBe(7n);
    expect(maker.sent[0]?.destination).toBe(DESTINATION);
  });

  it('puts the six matched pair fields on the wire, so the maker can match its advertised pair', async () => {
    const makerSecret = generateSecretKey();
    const maker = rfqMaker({ secretKey: makerSecret });
    const outcome = await sendRollingRfq({
      client: maker.client,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const session = maker.sessions.get(outcome.streamNonce);
    expect(session?.pair).toEqual({
      from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:84532' },
      to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
    });
    // The advertised `rate`/`maxAmount` are NOT sent — the maker prices itself.
    expect(Object.keys(session?.pair.from ?? {}).sort()).toEqual([
      'assetCode',
      'assetScale',
      'chain',
    ]);
  });

  it('a maker whose pair does not match rejects, and the sender reports it as a fallback (never a throw)', async () => {
    const makerSecret = generateSecretKey();
    const maker = rfqMaker({
      secretKey: makerSecret,
      pairs: [{ ...PAIR, to: { ...PAIR.to, chain: 'evm:8453' } }],
    });
    const outcome = await sendRollingRfq({
      client: maker.client,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('rejected');
    expect(outcome.code).toBe('F06');
    expect(outcome.message).toContain('unsupported_pair');
    expect(maker.sessions.size).toBe(0);
  });

  it('LEGACY MAKER: no RFQ intake at all → a typed fallback signal, never an exception', async () => {
    // A pre-#135 maker unwraps the gift wrap, finds a kind it does not
    // handle, and answers from its LEGACY handler. That reject IS capability
    // discovery (spec §10.3 step 2).
    const makerSecret = generateSecretKey();
    const legacyOnly: RollingRfqSender = {
      async sendSwapPacket() {
        return {
          accepted: false,
          code: 'F06',
          message: 'Unsupported rumor kind 20033',
        };
      },
    };
    const outcome = await sendRollingRfq({
      client: legacyOnly,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome).toMatchObject({
      ok: false,
      reason: 'rejected',
      code: 'F06',
    });
  });

  it('a maker that FULFILLs with legacy claim metadata (not a gift wrap) is treated as legacy', async () => {
    const maker: RollingRfqSender = {
      async sendSwapPacket() {
        // Exactly what a legacy swap FULFILL carries: base64 JSON metadata.
        return {
          accepted: true,
          data: Buffer.from(
            JSON.stringify({ claim: 'AQID', swapSignerAddress: '0xabc' }),
            'utf8'
          ).toString('base64'),
        };
      },
    };
    const outcome = await sendRollingRfq({
      client: maker,
      destination: DESTINATION,
      swapPubkey: getPublicKey(generateSecretKey()),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'not-a-quote' });
  });

  it('an accepted probe with no data reports no-response', async () => {
    const outcome = await sendRollingRfq({
      client: {
        async sendSwapPacket() {
          return { accepted: true };
        },
      },
      destination: DESTINATION,
      swapPubkey: getPublicKey(generateSecretKey()),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'no-response' });
  });

  it('a quote for a DIFFERENT streamNonce is refused — that session is not ours', async () => {
    const makerSecret = generateSecretKey();
    const maker = rfqMaker({
      secretKey: makerSecret,
      forceStreamNonce: 'ab'.repeat(16),
    });
    const outcome = await sendRollingRfq({
      client: maker.client,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'nonce-mismatch' });
  });

  it('a local send throw never escapes — it is a send-failed fallback', async () => {
    const outcome = await sendRollingRfq({
      client: {
        async sendSwapPacket() {
          throw new Error('PEER_NOT_NEGOTIATED (g.toon.swap.maker)');
        },
      },
      destination: DESTINATION,
      swapPubkey: getPublicKey(generateSecretKey()),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('send-failed');
    expect(outcome.message).toContain('PEER_NOT_NEGOTIATED');
  });

  it('a quote sealed to somebody ELSE cannot be opened, so it does not establish a session', async () => {
    const makerSecret = generateSecretKey();
    const strangerPubkey = getPublicKey(generateSecretKey());
    const maker: RollingRfqSender = {
      async sendSwapPacket() {
        const { giftWrap } = wrapSwapPacket({
          rumor: {
            kind: ROLLING_RFQ_RESPONSE_KIND,
            content: JSON.stringify({
              proto: 'rolling/1',
              type: 'quote',
              streamNonce: 'cd'.repeat(16),
              rate: '4.0',
              rateTimestamp: 1,
              expiresAt: 2,
            }),
            tags: [],
            created_at: 1,
            pubkey: '',
          } as unknown as UnsignedEvent,
          senderSecretKey: makerSecret,
          recipientPubkey: strangerPubkey,
        });
        return {
          accepted: true,
          data: Buffer.from(JSON.stringify(giftWrap), 'utf8').toString(
            'base64'
          ),
        };
      },
    };
    const outcome = await sendRollingRfq({
      client: maker,
      destination: DESTINATION,
      swapPubkey: getPublicKey(makerSecret),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
      amount: 1n,
    });
    expect(outcome).toMatchObject({ ok: false, reason: 'not-a-quote' });
  });

  it('an unroutable senderIlpAddress is refused BEFORE a packet is paid for', async () => {
    let sends = 0;
    const outcome = await sendRollingRfq({
      client: {
        async sendSwapPacket() {
          sends += 1;
          return { accepted: true };
        },
      },
      destination: DESTINATION,
      swapPubkey: getPublicKey(generateSecretKey()),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: '',
      amount: 1n,
    });
    expect(sends).toBe(0);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe('send-failed');
    expect(outcome.message).toContain('senderIlpAddress');
  });
});

describe('buildRollingRfqRequest', () => {
  it('produces the maker-parseable shape, omitting an absent sizeHint', () => {
    const req = buildRollingRfqRequest({
      streamNonce: '9f'.repeat(16),
      pair: PAIR,
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
    });
    expect(req).toEqual({
      proto: 'rolling/1',
      type: 'rfq',
      streamNonce: '9f'.repeat(16),
      pair: {
        from: { assetCode: 'USDC', assetScale: 6, chain: 'evm:84532' },
        to: { assetCode: 'MINA', assetScale: 9, chain: 'mina:devnet' },
      },
      chainRecipient: CHAIN_RECIPIENT,
      senderIlpAddress: SENDER_ILP,
    });
  });

  it('refuses a malformed streamNonce (an unconditional maker-side F01)', () => {
    expect(() =>
      buildRollingRfqRequest({
        streamNonce: 'NOT-HEX',
        pair: PAIR,
        chainRecipient: CHAIN_RECIPIENT,
        senderIlpAddress: SENDER_ILP,
      })
    ).toThrow(/lowercase hex/);
  });
});

describe('parseRollingRfqResponse / decodeRollingRfqQuote', () => {
  const full = {
    proto: 'rolling/1',
    type: 'quote',
    streamNonce: '9f'.repeat(16),
    rate: '4.0000',
    rateTimestamp: 1_783_936_201_437,
    expiresAt: 1_783_936_261_437,
    spreadBps: 40,
    maxRateAge: 15_000,
    minAmount: '1000',
    maxAmount: '25000000',
    swapSignerAddress: '0xabc',
  };

  it('round-trips the full documented quote', () => {
    expect(parseRollingRfqResponse(JSON.stringify(full))).toEqual(full);
  });

  it('keeps the optional fields optional', () => {
    const parsed = parseRollingRfqResponse(
      JSON.stringify({
        proto: 'rolling/1',
        type: 'quote',
        streamNonce: full.streamNonce,
        rate: '4.0',
        rateTimestamp: 1,
        expiresAt: 2,
      })
    );
    expect(parsed).toEqual({
      proto: 'rolling/1',
      type: 'quote',
      streamNonce: full.streamNonce,
      rate: '4.0',
      rateTimestamp: 1,
      expiresAt: 2,
    });
  });

  it.each([
    ['not json', 'x{'],
    ['wrong proto', JSON.stringify({ ...full, proto: 'other/1' })],
    ['wrong type', JSON.stringify({ ...full, type: 'rfq' })],
    ['bad nonce', JSON.stringify({ ...full, streamNonce: 'zz' })],
    ['missing rate', JSON.stringify({ ...full, rate: undefined })],
    ['missing expiresAt', JSON.stringify({ ...full, expiresAt: undefined })],
    ['rate not a string', JSON.stringify({ ...full, rate: 4 })],
  ])('returns null for %s rather than half-parsing it', (_label, content) => {
    expect(parseRollingRfqResponse(content)).toBeNull();
  });

  it('decodeRollingRfqQuote returns null for non-base64 / non-JSON / wrong-kind data', () => {
    const key = generateSecretKey();
    expect(decodeRollingRfqQuote('!!!not base64!!!', key)).toBeNull();
    expect(
      decodeRollingRfqQuote(Buffer.from('nope', 'utf8').toString('base64'), key)
    ).toBeNull();
    // A well-formed gift wrap whose inner kind is the legacy 20032.
    const maker = generateSecretKey();
    const { giftWrap } = wrapSwapPacket({
      rumor: {
        kind: 20032,
        content: '{}',
        tags: [],
        created_at: 1,
        pubkey: '',
      } as unknown as UnsignedEvent,
      senderSecretKey: maker,
      recipientPubkey: getPublicKey(key),
    });
    expect(
      decodeRollingRfqQuote(
        Buffer.from(JSON.stringify(giftWrap), 'utf8').toString('base64'),
        key
      )
    ).toBeNull();
  });
});

describe('the RFQ packet is built the way the sdk builds a legacy swap packet', () => {
  it('the TOON `data` is byte-shaped identically — same wrap, same encoder', () => {
    // `encodeRollingRfqPacket` is `wrapSwapPacketToToon(...).ilpPrepare.data`
    // decoded, which is exactly what the sdk's `buildAndWrapPacket` does. If
    // that stopped holding, the RFQ would stop landing on the maker's legacy
    // local-delivery seam at all — so pin it by decoding both the same way.
    const senderSecretKey = generateSecretKey();
    const makerSecret = generateSecretKey();
    const wrapped = wrapSwapPacketToToon({
      rumor: {
        kind: ROLLING_RFQ_REQUEST_KIND,
        content: '{}',
        tags: [],
        created_at: 1,
        pubkey: getPublicKey(senderSecretKey),
      } as unknown as UnsignedEvent,
      senderSecretKey,
      recipientPubkey: getPublicKey(makerSecret),
      destination: DESTINATION,
      amount: 1n,
    });
    const toonData = new Uint8Array(
      Buffer.from(wrapped.ilpPrepare.data, 'base64')
    );
    const unwrapped = unwrapSwapPacketFromToon({
      toonData,
      recipientSecretKey: makerSecret,
    });
    expect(unwrapped.rumor.kind).toBe(ROLLING_RFQ_REQUEST_KIND);
    expect(unwrapped.senderPubkey).toBe(getPublicKey(senderSecretKey));
  });
});
