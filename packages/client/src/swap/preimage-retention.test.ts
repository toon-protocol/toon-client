/**
 * Per-packet preimage retention tests (toon-client#360).
 */
import { describe, it, expect } from 'vitest';
import { mintExecutionCondition } from '../utils/condition.js';
import {
  InMemoryPreimageRetentionStore,
  type RetainedPreimage,
} from './preimage-retention.js';

function retained(packetIndex: number): RetainedPreimage {
  const { preimage, condition } = mintExecutionCondition();
  return { packetIndex, preimage, condition, retainedAt: 1000 + packetIndex };
}

describe('InMemoryPreimageRetentionStore (#360)', () => {
  it('retains a preimage per packet and returns it by packetIndex', () => {
    const store = new InMemoryPreimageRetentionStore();
    const a = retained(0);
    const b = retained(1);
    store.retain(a);
    store.retain(b);

    expect(store.size()).toBe(2);
    expect(store.get(0)?.preimage).toEqual(a.preimage);
    expect(store.get(1)?.preimage).toEqual(b.preimage);
    expect(store.get(0)?.condition).toEqual(a.condition);
  });

  it('returns undefined for an unknown packetIndex', () => {
    const store = new InMemoryPreimageRetentionStore();
    expect(store.get(7)).toBeUndefined();
    expect(store.take(7)).toBeUndefined();
  });

  it('take() consumes the preimage — single-use reveal (spec R1)', () => {
    const store = new InMemoryPreimageRetentionStore();
    const a = retained(0);
    store.retain(a);

    const first = store.take(0);
    expect(first?.preimage).toEqual(a.preimage);
    // Second take finds nothing: a preimage is never revealed twice.
    expect(store.take(0)).toBeUndefined();
    expect(store.get(0)).toBeUndefined();
    expect(store.size()).toBe(0);
  });

  it('get()/take() hand back defensive copies (retained state is immutable)', () => {
    const store = new InMemoryPreimageRetentionStore();
    const a = retained(0);
    store.retain(a);

    const peek = store.get(0);
    expect(peek).toBeDefined();
    peek?.preimage.fill(0);
    // Mutating the returned copy must not corrupt the retained secret.
    expect(store.get(0)?.preimage).toEqual(a.preimage);
    expect(store.get(0)?.preimage).not.toEqual(peek?.preimage);
  });

  it('retain() replaces a prior entry for the same packetIndex', () => {
    const store = new InMemoryPreimageRetentionStore();
    store.retain(retained(0));
    const replacement = retained(0);
    store.retain(replacement);
    expect(store.size()).toBe(1);
    expect(store.get(0)?.preimage).toEqual(replacement.preimage);
  });

  it('clear() drops every retained preimage at session end', () => {
    const store = new InMemoryPreimageRetentionStore();
    store.retain(retained(0));
    store.retain(retained(1));
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.get(0)).toBeUndefined();
  });
});
