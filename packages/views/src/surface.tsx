/**
 * Surface-mode control for atoms.
 *
 * Wraps the (optional, feature-detected) display-mode methods on {@link
 * ViewBridge} as a reactive hook. Atoms use it to decide whether to offer "Open
 * timeline" (fullscreen) or a live ticker (pip), and to request the switch — but
 * they degrade to inline-only on hosts (and the mock bridge) that don't expose
 * the capability, so nothing assumes fullscreen/pip exists.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type FC,
  type ReactNode,
} from 'react';
import { type DisplayMode, type ViewBridge } from './app-bridge/types.js';

export interface DisplayModeControl {
  /** Current surface mode (defaults to `'inline'`). */
  mode: DisplayMode;
  /** Modes the host offers (empty on inline-only hosts). */
  available: DisplayMode[];
  /** Host can host a real scrolling timeline/thread. */
  canFullscreen: boolean;
  /** Host supports a parallel live ticker. */
  canPip: boolean;
  /** Ask the host to switch modes (a no-op on hosts without the capability). */
  request: (mode: DisplayMode) => Promise<void>;
}

function read(bridge: ViewBridge): { mode: DisplayMode; available: DisplayMode[] } {
  return {
    mode: bridge.displayMode?.() ?? 'inline',
    available: bridge.availableDisplayModes?.() ?? [],
  };
}

/** Reactive surface-mode state + a `request` to switch modes. */
export function useDisplayMode(bridge: ViewBridge): DisplayModeControl {
  const [state, setState] = useState(() => read(bridge));

  useEffect(() => {
    // Re-read on mount (the host context may have arrived after the initial
    // render) and whenever the host context changes (mode/size/theme).
    setState(read(bridge));
    return bridge.onHostContextChanged?.(() => setState(read(bridge)));
  }, [bridge]);

  const request = useCallback(
    async (mode: DisplayMode): Promise<void> => {
      if (!bridge.requestDisplayMode) return;
      const actual = await bridge.requestDisplayMode(mode);
      setState((s) => ({ ...s, mode: actual }));
    },
    [bridge]
  );

  return {
    mode: state.mode,
    available: state.available,
    canFullscreen: state.available.includes('fullscreen'),
    canPip: state.available.includes('pip'),
    request,
  };
}

/** The inline-only fallback used when no {@link SurfaceProvider} is mounted. */
const INLINE_ONLY: DisplayModeControl = {
  mode: 'inline',
  available: [],
  canFullscreen: false,
  canPip: false,
  request: async () => {},
};

const SurfaceContext = createContext<DisplayModeControl>(INLINE_ONLY);

/**
 * Computes surface-mode state ONCE per view and shares it via context, so the
 * many atoms in a view read it cheaply instead of each subscribing to the host
 * (which would chain N handlers onto the single host-context callback).
 */
export const SurfaceProvider: FC<{ bridge: ViewBridge; children: ReactNode }> = ({
  bridge,
  children,
}) => {
  const control = useDisplayMode(bridge);
  return <SurfaceContext.Provider value={control}>{children}</SurfaceContext.Provider>;
};

/** Read the view's surface-mode control (inline-only when no provider is mounted). */
export function useSurface(): DisplayModeControl {
  return useContext(SurfaceContext);
}
