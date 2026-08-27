/**
 * Read-only offline cache — deliberately scoped down from a full offline
 * write/sync engine (that's a separate, much larger project with its own
 * queueing and conflict-resolution concerns). This hook only does one
 * thing: if the device is offline, or a live fetch fails even though the
 * device thinks it's online, fall back to the last successfully-loaded
 * payload for that key instead of showing an error or a blank screen.
 * Nothing is ever queued or written back — it's a read cache, not a sync
 * layer.
 *
 * Domain-agnostic on purpose: any screen adopts it by passing a stable
 * cache key and its existing data-fetching function.
 */
import { useCallback, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';

const CACHE_PREFIX = 'tourmate:cache:';

type CachedLoadResult<T> = {
  data: T | null;
  loading: boolean;
  isOffline: boolean;
  refresh: () => Promise<void>;
};

export function useCachedLoad<T>(key: string, fetcher: () => Promise<T>): CachedLoadResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);

  const storageKey = `${CACHE_PREFIX}${key}`;

  const load = useCallback(async () => {
    setLoading(true);
    const netState = await NetInfo.fetch();

    if (!netState.isConnected) {
      const cached = await readCache<T>(storageKey);
      setData(cached);
      setIsOffline(true);
      setLoading(false);
      return;
    }

    try {
      const fresh = await fetcher();
      setData(fresh);
      setIsOffline(false);
      // Best-effort — a failed cache write shouldn't block showing fresh
      // data that was just fetched successfully.
      AsyncStorage.setItem(storageKey, JSON.stringify(fresh)).catch(() => {});
    } catch (err) {
      // The device thinks it's online but the request still failed
      // (flaky connection, server hiccup) — treat it the same as
      // offline: show the last good data with a stale-data indicator
      // rather than an error screen.
      const cached = await readCache<T>(storageKey);
      if (cached !== null) {
        setData(cached);
        setIsOffline(true);
      } else {
        throw err; // nothing cached to fall back to — let the caller's own error handling take over
      }
    } finally {
      setLoading(false);
    }
  }, [storageKey, fetcher]);

  // No auto-fetch on mount — every screen in this app already refetches
  // via useFocusEffect (so data is current when navigating back from
  // somewhere that changed it), so this hook exposes `refresh` for the
  // caller to invoke there instead of racing its own mount-time fetch
  // against that pattern.
  return { data, loading, isOffline, refresh: load };
}

async function readCache<T>(storageKey: string): Promise<T | null> {
  try {
    const raw = await AsyncStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}
