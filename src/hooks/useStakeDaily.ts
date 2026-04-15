import { useState, useEffect } from 'react';

export interface StakeDailyRow {
  date: string;
  lock_3mo_amount: number;
  lock_6mo_amount: number;
  lock_12mo_amount: number;
  lock_3mo_count: number;
  lock_6mo_count: number;
  lock_12mo_count: number;
  new_wallet_amount: number;
  old_wallet_amount: number;
  new_wallet_count: number;
  old_wallet_count: number;
  total_amount: number;
  total_events: number;
}

interface StakeDailyPayload {
  days: StakeDailyRow[];
  scannedBlocks: { from: number; to: number };
  refreshedAt: string;
  eventCount: number;
}

interface UseStakeDailyReturn {
  days: StakeDailyRow[] | null;
  refreshedAt: string | null;
  isLoading: boolean;
  error: string | null;
}

// Shared singleton with 5-min TTL, same pattern as useDuneQuery
const TTL = 5 * 60 * 1000;
let cachedData: StakeDailyPayload | null = null;
let cachedAt = 0;
let inflight: Promise<StakeDailyPayload | null> | null = null;

function fetchData(): Promise<StakeDailyPayload | null> {
  const now = Date.now();
  if (cachedData && now - cachedAt < TTL) return Promise.resolve(cachedData);
  if (inflight) return inflight;

  inflight = fetch('/api/stake-daily-data')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data: StakeDailyPayload) => {
      cachedData = data;
      cachedAt = Date.now();
      inflight = null;
      return data;
    })
    .catch(err => {
      console.warn('Failed to fetch stake-daily:', err);
      inflight = null;
      return cachedData; // return stale if available
    });

  return inflight;
}

export function useStakeDaily(): UseStakeDailyReturn {
  const [days, setDays] = useState<StakeDailyRow[] | null>(null);
  const [refreshedAt, setRefreshedAt] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setIsLoading(true);
    fetchData()
      .then(data => {
        if (!mounted) return;
        if (data) {
          setDays(data.days);
          setRefreshedAt(data.refreshedAt);
        } else {
          setError('No data available');
        }
      })
      .catch(err => {
        if (!mounted) return;
        setError(err instanceof Error ? err.message : 'Error fetching');
      })
      .finally(() => {
        if (mounted) setIsLoading(false);
      });
    return () => { mounted = false; };
  }, []);

  return { days, refreshedAt, isLoading, error };
}
