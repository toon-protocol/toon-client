import { describe, it, expect, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { createJobMessageHandler, type JobAnswer, type JobRequest } from './serve-job.js';
import {
  ILPPacketType,
  serializeIlpPrepare,
  deserializeIlpPacket,
} from './btp/protocol.js';
import type { InboundBtpMessage } from './btp/IsomorphicBtpClient.js';
import {
  giftWrapPublicKey,
  openResponse,
  sealRequest,
} from './wire/giftwrap.js';

const PREIMAGE = new Uint8Array(32).fill(7);
const CONDITION = sha256(PREIMAGE);

function inboundJob(overrides: Partial<{
  destination: string;
  amount: bigint;
  executionCondition: Uint8Array;
  expiresAt: Date;
  data: Uint8Array;
}> = {}): InboundBtpMessage {
  const ilpPacket = serializeIlpPrepare({
    type: ILPPacketType.PREPARE,
    amount: overrides.amount ?? 100n,
    destination: overrides.destination ?? 'g.toon.provider',
    executionCondition: overrides.executionCondition ?? CONDITION,
    expiresAt: overrides.expiresAt ?? new Date(Date.now() + 60_000),
    data: overrides.data ?? new Uint8Array([1, 2, 3]),
  });
  return { requestId: 1, protocolData: [], ilpPacket };
}

describe('createJobMessageHandler', () => {
  it('answers FULFILL when the handler returns a matching fulfillment', async () => {
    const handler = vi.fn(
      async (_job: JobRequest): Promise<JobAnswer> => ({
        fulfillment: PREIMAGE,
        data: new Uint8Array([9]),
      })
    );
    const onMessage = createJobMessageHandler(handler);

    const response = await onMessage(inboundJob());

    expect(handler).toHaveBeenCalledTimes(1);
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    expect(decoded.type).toBe(ILPPacketType.FULFILL);
    if (decoded.type !== ILPPacketType.FULFILL) return;
    expect(decoded.fulfillment).toEqual(PREIMAGE);
    expect(decoded.data).toEqual(new Uint8Array([9]));
  });

  it('passes the decoded PREPARE fields through to the handler', async () => {
    let received: JobRequest | undefined;
    const handler = (job: JobRequest): JobAnswer => {
      received = job;
      return { fulfillment: PREIMAGE };
    };
    const onMessage = createJobMessageHandler(handler);

    await onMessage(
      inboundJob({ destination: 'g.toon.alice', amount: 555n, data: new Uint8Array([4, 5]) })
    );

    expect(received?.destination).toBe('g.toon.alice');
    expect(received?.amount).toBe(555n);
    expect(received?.data).toEqual(new Uint8Array([4, 5]));
    expect(received?.executionCondition).toEqual(CONDITION);
  });

  it('defaults the FULFILL data field to empty when the handler omits it', async () => {
    const onMessage = createJobMessageHandler(() => ({ fulfillment: PREIMAGE }));

    const response = await onMessage(inboundJob());

    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.FULFILL) throw new Error('expected FULFILL');
    expect(decoded.data).toEqual(new Uint8Array(0));
  });

  it('answers an empty RESPONSE when the MESSAGE carries no PREPARE', async () => {
    const handler = vi.fn(() => ({ fulfillment: PREIMAGE }));
    const onMessage = createJobMessageHandler(handler);

    const response = await onMessage({ requestId: 1, protocolData: [] });

    expect(handler).not.toHaveBeenCalled();
    expect(response).toEqual({});
  });

  it('answers F00 REJECT for an undecodable PREPARE', async () => {
    const handler = vi.fn(() => ({ fulfillment: PREIMAGE }));
    const onMessage = createJobMessageHandler(handler);

    const response = await onMessage({
      requestId: 1,
      protocolData: [],
      ilpPacket: new Uint8Array([ILPPacketType.PREPARE, 1, 2]),
    });

    expect(handler).not.toHaveBeenCalled();
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('F00');
  });

  it('answers R00 REJECT for an already-expired PREPARE without invoking the handler', async () => {
    const handler = vi.fn(() => ({ fulfillment: PREIMAGE }));
    const onMessage = createJobMessageHandler(handler);

    const response = await onMessage(
      inboundJob({ expiresAt: new Date(Date.now() - 1000) })
    );

    expect(handler).not.toHaveBeenCalled();
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('R00');
  });

  it('answers F99 REJECT when the handler throws (still an answer, per ADR 0020)', async () => {
    const onMessage = createJobMessageHandler(() => {
      throw new Error('build failed');
    });

    const response = await onMessage(inboundJob());

    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('F99');
    expect(decoded.message).toContain('build failed');
  });

  it('answers F99 REJECT when the fulfillment does not match the condition', async () => {
    const onMessage = createJobMessageHandler(() => ({
      fulfillment: new Uint8Array(32).fill(1),
    }));

    const response = await onMessage(inboundJob({ executionCondition: CONDITION }));

    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('F99');
  });

  it('awaits an async handler', async () => {
    const onMessage = createJobMessageHandler(
      async (): Promise<JobAnswer> =>
        new Promise((resolve) => setTimeout(() => resolve({ fulfillment: PREIMAGE }), 1))
    );

    const response = await onMessage(inboundJob());

    const decoded = deserializeIlpPacket(response.ilpPacket!);
    expect(decoded.type).toBe(ILPPacketType.FULFILL);
  });
});

describe('createJobMessageHandler — sealing at a client destination (toon-client#537)', () => {
  const sellerIdentity = secp256k1.utils.randomSecretKey();
  const sellerPublicKey = giftWrapPublicKey(sellerIdentity);
  const REQUEST_PLAINTEXT = new Uint8Array([1, 2, 3, 4, 5]);
  const ANSWER_PLAINTEXT = new Uint8Array([9, 9, 9]);

  it('opens the PREPARE data with the seller identity, and seals the answer back with the same secret', async () => {
    const { wrapped, sharedSecret } = sealRequest(REQUEST_PLAINTEXT, sellerPublicKey);

    let received: JobRequest | undefined;
    const handler = (job: JobRequest): JobAnswer => {
      received = job;
      return { fulfillment: PREIMAGE, data: ANSWER_PLAINTEXT };
    };
    const onMessage = createJobMessageHandler(handler, sellerIdentity);

    const response = await onMessage(inboundJob({ data: wrapped }));

    // The seller unseals the job — the handler never sees the raw wrap.
    expect(received?.data).toEqual(REQUEST_PLAINTEXT);

    // The FULFILL's data is sealed back with the request's own secret — the
    // buyer opens it with the shared secret it kept from sealing, never a
    // second key exchange.
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.FULFILL) throw new Error('expected FULFILL');
    expect(openResponse(sharedSecret, decoded.data)).toEqual(ANSWER_PLAINTEXT);
  });

  it('passes through data unsealed when no identity is supplied — additive, pre-#537 behaviour', async () => {
    const { wrapped } = sealRequest(REQUEST_PLAINTEXT, sellerPublicKey);

    let received: JobRequest | undefined;
    const handler = (job: JobRequest): JobAnswer => {
      received = job;
      return { fulfillment: PREIMAGE, data: ANSWER_PLAINTEXT };
    };
    const onMessage = createJobMessageHandler(handler);

    const response = await onMessage(inboundJob({ data: wrapped }));

    // No identity configured: the still-sealed wrap rides through as opaque
    // bytes, unexamined — exactly the pre-#537 contract.
    expect(received?.data).toEqual(wrapped);
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.FULFILL) throw new Error('expected FULFILL');
    expect(decoded.data).toEqual(ANSWER_PLAINTEXT);
  });

  it('refuses loudly, without invoking the handler, when the buyer sealed to the wrong destination key', async () => {
    const wrongSeller = secp256k1.utils.randomSecretKey();
    const { wrapped } = sealRequest(REQUEST_PLAINTEXT, giftWrapPublicKey(wrongSeller));

    const handler = vi.fn(() => ({ fulfillment: PREIMAGE }));
    const onMessage = createJobMessageHandler(handler, sellerIdentity);

    const response = await onMessage(inboundJob({ data: wrapped }));

    expect(handler).not.toHaveBeenCalled();
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('F00');
    expect(decoded.message).toContain('did not open');
  });

  it('refuses loudly, without invoking the handler, on a corrupted/unopenable wrap', async () => {
    const { wrapped } = sealRequest(REQUEST_PLAINTEXT, sellerPublicKey);
    wrapped[wrapped.length - 1] ^= 0xff; // tamper with the ciphertext

    const handler = vi.fn(() => ({ fulfillment: PREIMAGE }));
    const onMessage = createJobMessageHandler(handler, sellerIdentity);

    const response = await onMessage(inboundJob({ data: wrapped }));

    expect(handler).not.toHaveBeenCalled();
    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('F00');
    expect(decoded.message).toContain('did not open');
  });

  it('still refuses F99 for a mismatched fulfillment when sealed, distinct from an unopenable wrap', async () => {
    const { wrapped } = sealRequest(REQUEST_PLAINTEXT, sellerPublicKey);

    const onMessage = createJobMessageHandler(
      () => ({ fulfillment: new Uint8Array(32).fill(1) }),
      sellerIdentity
    );

    const response = await onMessage(
      inboundJob({ data: wrapped, executionCondition: CONDITION })
    );

    const decoded = deserializeIlpPacket(response.ilpPacket!);
    if (decoded.type !== ILPPacketType.REJECT) throw new Error('expected REJECT');
    expect(decoded.code).toBe('F99');
  });
});
