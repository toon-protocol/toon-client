import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { createElement } from 'react';
import { isValidRelayUrl } from '../url-utils.js';

const DEFAULT_RELAY_URL: string =
  import.meta.env.VITE_DEFAULT_RELAY || 'ws://localhost:7100';

interface RigConfigContextValue {
  relayUrl: string;
  repoFilter?: string;
  owner?: string;
}

const RigConfigContext = createContext<RigConfigContextValue | null>(null);

export function RigConfigProvider({ children }: { children: ReactNode }) {
  const value = useMemo<RigConfigContextValue>(() => {
    const config = window.__RIG_CONFIG__;
    if (config) {
      return {
        relayUrl: config.relay || DEFAULT_RELAY_URL,
        repoFilter: config.repo,
        owner: config.owner,
      };
    }

    // Fallback: check hash fragment for relay param (e.g. #relay=ws://...)
    const hash = window.location.hash;
    const relayMatch = hash.match(/[?&]relay=([^&]+)/);
    let relayUrl = DEFAULT_RELAY_URL;
    if (relayMatch) {
      const candidate = decodeURIComponent(relayMatch[1] as string);
      if (isValidRelayUrl(candidate)) {
        relayUrl = candidate;
      }
    }

    return { relayUrl };
  }, []);

  return createElement(RigConfigContext.Provider, { value }, children);
}

export function useRigConfig(): RigConfigContextValue {
  const ctx = useContext(RigConfigContext);
  if (!ctx) {
    throw new Error('useRigConfig must be used within a RigConfigProvider');
  }
  return ctx;
}
