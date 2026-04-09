// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, it, expect } from 'vitest';
import { useProofStatus } from './use-proof-status.js';
import type { PetInteractionEventData } from '@toon-protocol/client';

function makeEvent(
  proofStatus: 'optimistic' | 'proven'
): PetInteractionEventData {
  return {
    blobbiId: 'test-pet',
    actionType: 0,
    itemId: 0,
    tokenCost: 10,
    cycle: 1,
    stage: 1,
    brainHash: 'a'.repeat(64),
    proofStatus,
    content: null,
  };
}

describe('[P1] useProofStatus', () => {
  it('returns zero counts for empty array', () => {
    const { result } = renderHook(() => useProofStatus([]));
    expect(result.current).toEqual({
      optimisticCount: 0,
      provenCount: 0,
      total: 0,
    });
  });

  it('counts a single optimistic event', () => {
    const { result } = renderHook(() =>
      useProofStatus([makeEvent('optimistic')])
    );
    expect(result.current).toEqual({
      optimisticCount: 1,
      provenCount: 0,
      total: 1,
    });
  });

  it('counts a single proven event', () => {
    const { result } = renderHook(() => useProofStatus([makeEvent('proven')]));
    expect(result.current).toEqual({
      optimisticCount: 0,
      provenCount: 1,
      total: 1,
    });
  });

  it('counts mixed optimistic and proven events', () => {
    const events = [
      makeEvent('optimistic'),
      makeEvent('proven'),
      makeEvent('optimistic'),
    ];
    const { result } = renderHook(() => useProofStatus(events));
    expect(result.current).toEqual({
      optimisticCount: 2,
      provenCount: 1,
      total: 3,
    });
  });

  it('counts all proven events', () => {
    const events = [
      makeEvent('proven'),
      makeEvent('proven'),
      makeEvent('proven'),
    ];
    const { result } = renderHook(() => useProofStatus(events));
    expect(result.current).toEqual({
      optimisticCount: 0,
      provenCount: 3,
      total: 3,
    });
  });

  it('counts all optimistic events', () => {
    const events = [makeEvent('optimistic'), makeEvent('optimistic')];
    const { result } = renderHook(() => useProofStatus(events));
    expect(result.current).toEqual({
      optimisticCount: 2,
      provenCount: 0,
      total: 2,
    });
  });

  it('total equals optimisticCount + provenCount', () => {
    const events = [
      makeEvent('optimistic'),
      makeEvent('proven'),
      makeEvent('optimistic'),
      makeEvent('proven'),
      makeEvent('proven'),
    ];
    const { result } = renderHook(() => useProofStatus(events));
    const { optimisticCount, provenCount, total } = result.current;
    expect(total).toBe(optimisticCount + provenCount);
    expect(total).toBe(5);
  });
});
