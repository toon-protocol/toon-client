import { describe, it, expect, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useDisplayMode } from './surface.js';
import { type DisplayMode, type ViewBridge } from './app-bridge/types.js';

/** A minimal bridge; surface-mode methods are added per-test. */
function baseBridge(over: Partial<ViewBridge> = {}): ViewBridge {
  return {
    async callTool() {
      return { ok: true };
    },
    notifyModel() {},
    onSpec() {
      return () => {};
    },
    ...over,
  };
}

describe('useDisplayMode', () => {
  it('defaults to inline-only on a host without the capability', () => {
    // The bridge identity must be stable across renders (production memoizes it),
    // so build it once outside the hook callback.
    const bridge = baseBridge();
    const { result } = renderHook(() => useDisplayMode(bridge));
    expect(result.current.mode).toBe('inline');
    expect(result.current.available).toEqual([]);
    expect(result.current.canFullscreen).toBe(false);
    expect(result.current.canPip).toBe(false);
  });

  it('reports available modes from the bridge', () => {
    const available: DisplayMode[] = ['inline', 'fullscreen'];
    const bridge = baseBridge({
      availableDisplayModes: () => available,
      displayMode: () => 'inline',
    });
    const { result } = renderHook(() => useDisplayMode(bridge));
    expect(result.current.canFullscreen).toBe(true);
    expect(result.current.canPip).toBe(false);
  });

  it('request() switches to the mode the host actually set', async () => {
    const requestDisplayMode = vi.fn(async (m: DisplayMode) => m);
    const bridge = baseBridge({
      availableDisplayModes: () => ['inline', 'fullscreen'],
      displayMode: () => 'inline',
      requestDisplayMode,
    });
    const { result } = renderHook(() => useDisplayMode(bridge));
    await act(async () => {
      await result.current.request('fullscreen');
    });
    expect(requestDisplayMode).toHaveBeenCalledWith('fullscreen');
    expect(result.current.mode).toBe('fullscreen');
  });

  it('re-reads when the host context changes', async () => {
    let current: DisplayMode = 'inline';
    let fire: (() => void) | null = null;
    const bridge = baseBridge({
      displayMode: () => current,
      availableDisplayModes: () => ['inline', 'fullscreen'],
      onHostContextChanged: (cb) => {
        fire = cb;
        return () => {
          fire = null;
        };
      },
    });
    const { result } = renderHook(() => useDisplayMode(bridge));
    expect(result.current.mode).toBe('inline');
    act(() => {
      current = 'fullscreen';
      fire?.();
    });
    await waitFor(() => expect(result.current.mode).toBe('fullscreen'));
  });
});
