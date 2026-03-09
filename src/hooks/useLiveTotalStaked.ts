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

  useEffect(() => {
    fetchTotal();
    const interval = setInterval(fetchTotal, pollInterval);
    return () => clearInterval(interval);
  }, [fetchTotal, pollInterval]);

  return { totalStaked, isConfigured, isLoading };
}
