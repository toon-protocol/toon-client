import { describe, it, expect } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { CONDITION_LENGTH } from './utils/condition.js';
import { toHex, encodeUtf8, decodeUtf8 } from './utils/binary.js';
import {
  encryptArtifact,
  fulfillIncrement,
  decryptArtifact,
  buildIncrementPrepare,
  HashlockConditionMismatchError,
  HashlockDecryptError,
} from './hashlock-delivery.js';

describe('encryptArtifact (provider side)', () => {
  it('returns a 32-byte key and condition = sha256(key)', () => {
    const { key, condition } = encryptArtifact(encodeUtf8('an increment of work'));
    expect(key).toHaveLength(CONDITION_LENGTH);
    expect(condition).toHaveLength(CONDITION_LENGTH);
    expect(condition).toEqual(sha256(key));
  });

  it('ciphertext does not contain the plaintext', () => {
    const plaintext = encodeUtf8('a secret PR diff');
    const { ciphertext } = encryptArtifact(plaintext);
    const ciphertextHex = toHex(ciphertext);
    expect(ciphertextHex).not.toContain(toHex(plaintext));
  });

  it('mints a FRESH key per call — never reuse across increments', () => {
    const artifact = encodeUtf8('same bytes, different increment');
    const a = encryptArtifact(artifact);
    const b = encryptArtifact(artifact);
    expect(a.key).not.toEqual(b.key);
    expect(a.condition).not.toEqual(b.condition);
    expect(a.ciphertext).not.toEqual(b.ciphertext);
  });

  it('the API accepts only artifact bytes — no caller-supplied key or condition can be threaded in', () => {
    // Structural guarantee: encryptArtifact's signature takes exactly one
    // parameter, so there is no way to pass a condition derived from
    // anything other than the key this function itself generates.
    expect(encryptArtifact.length).toBe(1);
  });
});

describe('fulfillIncrement (provider side)', () => {
  it('returns the key unchanged — revealing it IS fulfilling the increment', () => {
    const { key } = encryptArtifact(encodeUtf8('work'));
    expect(fulfillIncrement(key)).toEqual(key);
  });

  it('rejects a key that is not exactly 32 bytes', () => {
    expect(() => fulfillIncrement(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});

describe('decryptArtifact (buyer side)', () => {
  it('round-trips: encrypt then decrypt recovers the original artifact', () => {
    const plaintext = encodeUtf8('the deliverable');
    const { ciphertext, key, condition } = encryptArtifact(plaintext);
    const recovered = decryptArtifact(ciphertext, key, condition);
    expect(decodeUtf8(recovered)).toBe('the deliverable');
  });

  it('verifies against the condition the buyer PAID, not one re-derived from the key', () => {
    const { ciphertext, key } = encryptArtifact(encodeUtf8('work'));
    const wrongCondition = sha256(encodeUtf8('some other key entirely'));
    expect(() => decryptArtifact(ciphertext, key, wrongCondition)).toThrow(
      HashlockConditionMismatchError
    );
  });

  it('never decrypts when the condition check fails, even if the key would otherwise open the ciphertext', () => {
    const { ciphertext, key } = encryptArtifact(encodeUtf8('sensitive'));
    const staleCondition = new Uint8Array(CONDITION_LENGTH); // all-zero, e.g. a stale re-advertised value
    expect(() => decryptArtifact(ciphertext, key, staleCondition)).toThrow(
      HashlockConditionMismatchError
    );
  });

  it('the condition-mismatch error never includes the key', () => {
    const { ciphertext, key } = encryptArtifact(encodeUtf8('work'));
    const wrongCondition = new Uint8Array(CONDITION_LENGTH).fill(9);
    try {
      decryptArtifact(ciphertext, key, wrongCondition);
      expect.fail('expected a throw');
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      expect(message).not.toContain(toHex(key));
    }
  });

  it('throws HashlockDecryptError on a tampered ciphertext, even under the right condition', () => {
    const { ciphertext, key, condition } = encryptArtifact(encodeUtf8('work'));
    const tampered = ciphertext.slice();
    tampered[tampered.length - 1] ^= 0xff;
    expect(() => decryptArtifact(tampered, key, condition)).toThrow(
      HashlockDecryptError
    );
  });

  it('rejects a caller-supplied condition of the wrong length', () => {
    const { ciphertext, key } = encryptArtifact(encodeUtf8('work'));
    expect(() => decryptArtifact(ciphertext, key, new Uint8Array(31))).toThrow();
  });
});

describe('buildIncrementPrepare (buyer side)', () => {
  it('parses the advertised condition + amount tags into PREPARE-ready fields', () => {
    const { condition } = encryptArtifact(encodeUtf8('work'));
    const { executionCondition, amount } = buildIncrementPrepare({
      conditionHex: toHex(condition),
      amountUsdc: '4000000',
    });
    expect(executionCondition).toEqual(condition);
    expect(amount).toBe(4000000n);
  });

  it('rejects a condition that is not 32 bytes once decoded', () => {
    expect(() =>
      buildIncrementPrepare({ conditionHex: 'ab', amountUsdc: '1' })
    ).toThrow(/32 bytes/);
  });

  it('rejects a non-numeric amount', () => {
    const { condition } = encryptArtifact(encodeUtf8('work'));
    expect(() =>
      buildIncrementPrepare({
        conditionHex: toHex(condition),
        amountUsdc: 'not-a-number',
      })
    ).toThrow();
  });

  it('rejects a zero or negative amount', () => {
    const { condition } = encryptArtifact(encodeUtf8('work'));
    expect(() =>
      buildIncrementPrepare({ conditionHex: toHex(condition), amountUsdc: '0' })
    ).toThrow();
  });
});

describe('worked example — end to end (spec §7)', () => {
  it('provider encrypts, buyer pays the advertised condition, provider fulfils with the key, buyer decrypts', () => {
    const artifact = encodeUtf8('implement thread-focus-mode anchor deflake');

    // Provider: encrypt, advertise condition + amount on the kind:7000 offer.
    const { ciphertext, key, condition } = encryptArtifact(artifact);
    const offer = { conditionHex: toHex(condition), amountUsdc: '5000000' };

    // Buyer: build the PREPARE from the advertised offer.
    const prepare = buildIncrementPrepare(offer);
    expect(prepare.executionCondition).toEqual(condition);

    // Provider: FULFILL reveals the key as the preimage.
    const fulfillment = fulfillIncrement(key);
    expect(sha256(fulfillment)).toEqual(prepare.executionCondition);

    // Buyer: verify against what was paid, then decrypt.
    const recovered = decryptArtifact(ciphertext, fulfillment, prepare.executionCondition);
    expect(decodeUtf8(recovered)).toBe(decodeUtf8(artifact));
  });
});
