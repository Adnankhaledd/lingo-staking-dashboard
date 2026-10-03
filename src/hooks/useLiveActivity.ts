import { useState, useEffect, useCallback } from 'react';

export interface StakingEvent {
  type: 'stake';
  wallet: string;
  amount: number;
  txHash: string;
  timestamp: string;
  blockNum: string;
  lockDuration: string | null;
}

interface LiveActivityResponse {
  events: StakingEvent[];
  configured: boolean;
  error?: string;
}

interface UseLiveActivityResult {
  events: StakingEvent[];
  isLoading: boolean;
  isConfigured: boolean;
  error: string | null;
}

// 2 minutes, matching the endpoint's CDN cache — polling faster only re-reads the cache.
export function useLiveActivity(pollInterval = 120_000): UseLiveActivityResult {
  const [events, setEvents] = useState<StakingEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isConfigured, setIsConfigured] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchActivity = useCallback(async () => {
    try {
      const response = await fetch('/api/live-activity');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const data: LiveActivityResponse = await response.json();
      setIsConfigured(data.configured);
      setEvents(data.events);
      setError(data.error ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch');
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Poll only while the tab is visible. A dashboard left open in a background
  // tab used to keep polling all day; every poll that misses the CDN cache is
  // an Alchemy call. Refresh immediately when the tab comes back.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      fetchActivity();
      timer = setInterval(fetchActivity, pollInterval);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (document.hidden) fetchActivity(); else start();   // first paint even in a background tab
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [fetchActivity, pollInterval]);

  return { events, isLoading, isConfigured, error };
}
