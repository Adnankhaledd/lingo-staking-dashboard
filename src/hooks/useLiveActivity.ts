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

export function useLiveActivity(pollInterval = 60_000): UseLiveActivityResult {
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

  useEffect(() => {
    fetchActivity();
    const interval = setInterval(fetchActivity, pollInterval);
    return () => clearInterval(interval);
  }, [fetchActivity, pollInterval]);

  return { events, isLoading, isConfigured, error };
}
