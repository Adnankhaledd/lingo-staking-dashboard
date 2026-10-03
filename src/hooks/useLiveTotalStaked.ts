import { useState, useEffect, useCallback } from 'react';

interface LiveTotalStakedResponse {
  totalStaked: number | null;
  configured: boolean;
  error?: string;
}

interface UseLiveTotalStakedResult {
  totalStaked: number | null;
  isConfigured: boolean;
  isLoading: boolean;
}

export function useLiveTotalStaked(pollInterval = 300_000): UseLiveTotalStakedResult {
  const [totalStaked, setTotalStaked] = useState<number | null>(null);
  const [isConfigured, setIsConfigured] = useState(true);
  const [isLoading, setIsLoading] = useState(true);

  const fetchTotal = useCallback(async () => {
    try {
      const response = await fetch('/api/live-total-staked');
      if (!response.ok) return;

      const data: LiveTotalStakedResponse = await response.json();
      setIsConfigured(data.configured);
      if (data.totalStaked !== null) setTotalStaked(data.totalStaked);
    } catch {
      // Silently fail — Dune data is the fallback
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
      fetchTotal();
      timer = setInterval(fetchTotal, pollInterval);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (document.hidden) fetchTotal(); else start();   // first paint even in a background tab
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [fetchTotal, pollInterval]);

  return { totalStaked, isConfigured, isLoading };
}
