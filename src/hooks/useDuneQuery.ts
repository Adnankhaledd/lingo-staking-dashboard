import { useState, useEffect, useCallback } from 'react';

const DUNE_API_BASE = 'https://api.dune.com/api/v1';

interface DuneResponse<T> {
  execution_id: string;
  query_id: number;
  is_execution_finished: boolean;
  state: string;
  result?: {
    rows: T[];
    metadata: {
      column_names: string[];
      row_count: number;
      total_row_count: number;
    };
  };
  error?: string;
}

interface UseDuneQueryOptions {
  enabled?: boolean;
  limit?: number;
}

interface UseDuneQueryReturn<T> {
  data: T[] | null;
  isLoading: boolean;
  error: string | null;
  refetch: () => Promise<void>;
}

export function useDuneQuery<T>(
  queryId: string | number,
  options: UseDuneQueryOptions = {}
): UseDuneQueryReturn<T> {
  const { enabled = true, limit = 1000 } = options;
  const [data, setData] = useState<T[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const apiKey = import.meta.env.VITE_DUNE_API_KEY;

  const fetchData = useCallback(async () => {
    if (!apiKey) {
      setError('Dune API key not configured');
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    try {
      const response = await fetch(
        `${DUNE_API_BASE}/query/${queryId}/results?limit=${limit}`,
        {
          headers: {
            'X-Dune-API-Key': apiKey,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result: DuneResponse<T> = await response.json();

      if (result.state === 'QUERY_STATE_FAILED') {
        throw new Error(result.error || 'Query failed');
      }

      if (!result.is_execution_finished) {
        throw new Error('Query execution not finished');
      }

      setData(result.result?.rows ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'An error occurred');
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [queryId, apiKey, limit]);

  useEffect(() => {
    if (enabled) {
      fetchData();
    }
  }, [enabled, fetchData]);

  return { data, isLoading, error, refetch: fetchData };
}

// Query IDs from Dune
export const DUNE_QUERIES = {
  // Total LINGO staked over time (daily)
  TOTAL_STAKED_TREND: '6590984',

  // Weekly stats: active_stakers, total_tvl
  WEEKLY_STATS: '6534908',

  // Weekly new stakers
  WEEKLY_NEW_STAKERS: '6535206',

  // Cohort retention data
  COHORT_RETENTION: '6528806',

  // Staking tiers breakdown
  STAKING_TIERS: '6560698',

  // Unlock schedule
  UNLOCK_SCHEDULE: '6543709',

  // Top 50 stakers
  TOP_STAKERS: '6632385',

  // Trading fees per month
  TRADING_FEES: '6288543',
} as const;

// Type definitions for Dune query responses
export interface TotalStakedRow {
  day: string;
  total_staked: number;
  change_from_yesterday: number;
  change_pct: number | null;
}

export interface WeeklyStatsRow {
  week: string;
  active_stakers: number;
  total_tvl: number;
}

export interface WeeklyNewStakersRow {
  week: string;
  new_stakers: number;
}

export interface CohortRetentionRow {
  cohort_week: string;
  cohort_size: number;
  never_unstaked: number;
  partial: number;
  fully_exited: number;
  pct_diamond_hands: string;
  pct_partial: string;
  pct_churned: string;
  pct_retained: string;
}

export interface StakingTierRow {
  tier: string;
  lock_type: string;
  users: number;
  avg_usd: number;
  total_usd: number;
}

export interface UnlockScheduleRow {
  unlock_day: string;
  daily_unlock_lingo: number;
  cumulative_unlock_lingo: number;
}

export interface TopStakerRow {
  rank: number;
  wallet: string;
  lingo_staked: number;
  usd_value: number;
  pct_of_total: number;
}

export interface TradingFeesRow {
  month: string;
  total_lingo: number;
  avg_price_usd: number;
  usd_value: number;
  cumulative_lingo: number;
  cumulative_usd: number;
}
