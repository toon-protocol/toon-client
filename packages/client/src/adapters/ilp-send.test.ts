import { describe, it, expect } from 'vitest';
import {
  mapIlpResponse,
  FULFILLMENT_MISMATCH_CODE,
  FULFILLMENT_MISMATCH_MESSAGE,
} from './ilp-send.js';
import { ILPPacketType } from '../btp/protocol.js';
import { mintExecutionCondition } from '../utils/condition.js';
import { toBase64 } from '../utils/binary.js';

const EMPTY = new Uint8Array(0);

describe('mapIlpResponse — shared transport response mapping (#350)', () => {
  it('legacy (no condition): accepts a FULFILL without verification', () => {
    const result = mapIlpResponse({
      type: ILPPacketType.FULFILL,
      fulfillment: new Uint8Array(32),
      data: EMPTY,
    });
    expect(result).toEqual({ accepted: true });
    // No fulfillment leaks onto legacy results (shape unchanged pre-#350).
    expect('fulfillment' in result).toBe(false);
  });

  it('legacy (all-zero condition): identical to no condition', () => {
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        fulfillment: new Uint8Array(32),
        data: EMPTY,
      },
      new Uint8Array(32)
    );
    expect(result).toEqual({ accepted: true });
  });

  it('sender-chosen: accepts when sha256(fulfillment) == condition and echoes the preimage', () => {
    const { preimage, condition } = mintExecutionCondition();
    const data = new Uint8Array([1, 2, 3]);
    const result = mapIlpResponse(
      { type: ILPPacketType.FULFILL, fulfillment: preimage, data },
      condition
    );
    expect(result.accepted).toBe(true);
    expect(result.fulfillment).toBe(toBase64(preimage));
    expect(result.data).toBe(toBase64(data));
  });

  it('sender-chosen: a wrong preimage is a FAILED packet, not a silent accept', () => {
    const { condition } = mintExecutionCondition();
    const wrong = mintExecutionCondition().preimage;
    const result = mapIlpResponse(
      { type: ILPPacketType.FULFILL, fulfillment: wrong, data: EMPTY },
      condition
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
    expect(result.message).toBe(FULFILLMENT_MISMATCH_MESSAGE);
    expect(result.fulfillment).toBeUndefined();
  });

  it('sender-chosen: an all-zero fulfillment (legacy auto-fulfill stub) fails closed', () => {
    const { condition } = mintExecutionCondition();
    const result = mapIlpResponse(
      {
        type: ILPPacketType.FULFILL,
        fulfillment: new Uint8Array(32),
        data: EMPTY,
      },
      condition
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
  });

  it('sender-chosen: a missing fulfillment (malformed transport response) fails closed', () => {
    const { condition } = mintExecutionCondition();
    const result = mapIlpResponse(
      // Simulates a pre-#350 peer/mock that never surfaced the fulfillment.
      {
        type: ILPPacketType.FULFILL,
        data: EMPTY,
      } as unknown as Parameters<typeof mapIlpResponse>[0],
      condition
    );
    expect(result.accepted).toBe(false);
    expect(result.code).toBe(FULFILLMENT_MISMATCH_CODE);
  });

  it('REJECT maps unchanged regardless of condition class', () => {
    const { condition } = mintExecutionCondition();
    const reject = {
      type: ILPPacketType.REJECT,
      code: 'F06',
      message: 'nope',
      data: EMPTY,
    } as const;
    expect(mapIlpResponse(reject)).toEqual({
      accepted: false,
      code: 'F06',
      message: 'nope',
    });
    expect(mapIlpResponse(reject, condition)).toEqual({
      accepted: false,
      code: 'F06',
      message: 'nope',
    });
  });
});
