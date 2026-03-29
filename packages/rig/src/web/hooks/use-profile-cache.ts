import {
  createContext,
  useContext,
  useCallback,
  useMemo,
  useState,
  useEffect,
  useRef,
  createElement,
  type ReactNode,
} from 'react';
import { ProfileCache } from '../profile-cache.js';
import { useRigConfig } from './use-rig-config.js';
import { queryRelay, buildProfileFilter } from '../relay-client.js';
import type { ProfileData } from '../profile-cache.js';

// Module-level singleton
const profileCache = new ProfileCache();

interface ProfileCacheContextValue {
  cache: ProfileCache;
  /** Trigger a re-render when profiles are fetched */
  version: number;
  /** Request profiles for pubkeys (batch fetched in background) */
  requestProfiles: (pubkeys: string[]) => void;
}

const ProfileCacheContext = createContext<ProfileCacheContextValue | null>(null);

export function ProfileCacheProvider({ children }: { children: ReactNode }) {
  const { relayUrl } = useRigConfig();
  const [version, setVersion] = useState(0);
  const pendingRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    const pubkeys = profileCache.getPendingPubkeys([...pendingRef.current]);
    pendingRef.current.clear();

    if (pubkeys.length === 0) return;

    profileCache.markRequested(pubkeys);

    queryRelay(relayUrl, buildProfileFilter(pubkeys))
      .then((events) => {
        for (const ev of events) {
          try {
            const content = JSON.parse(ev.content) as ProfileData;
            profileCache.setProfile(ev.pubkey, content);
          } catch {
            // Skip malformed profiles
          }
        }
        setVersion((v) => v + 1);
      })
      .catch(() => {
        // Profile fetch failure is non-critical
      });
  }, [relayUrl]);

  const requestProfiles = useCallback(
    (pubkeys: string[]) => {
      for (const pk of pubkeys) {
        pendingRef.current.add(pk);
      }
      // Debounce: batch requests within 50ms
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, 50);
    },
    [flush],
  );

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const value = useMemo<ProfileCacheContextValue>(
    () => ({ cache: profileCache, version, requestProfiles }),
    [version, requestProfiles],
  );

  return createElement(ProfileCacheContext.Provider, { value }, children);
}

export function useProfileCache() {
  const ctx = useContext(ProfileCacheContext);
  if (!ctx) {
    throw new Error('useProfileCache must be used within ProfileCacheProvider');
  }
  const { cache, version, requestProfiles } = ctx;

  const getDisplayName = useCallback(
    (pubkey: string) => cache.getDisplayName(pubkey),
    [cache, version],
  );

  return { getDisplayName, requestProfiles, version };
}
