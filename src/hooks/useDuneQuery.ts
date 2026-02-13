import { useState, useEffect, useCallback } from 'react';

const DUNE_API_BASE = 'https://api.dune.com/api/v1';
const CACHE_PREFIX = 'dune_cache_';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

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

interface CachedData<T> {
  data: T[];
  timestamp: number;
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

// Get cached data if valid
function getCachedData<T>(queryId: string | number): T[] | null {
  try {
    const cached = localStorage.getItem(`${CACHE_PREFIX}${queryId}`);
    if (!cached) return null;

    const parsed: CachedData<T> = JSON.parse(cached);
    const now = Date.now();

    if (now - parsed.timestamp < CACHE_DURATION) {
      console.log(`Using cached Dune data for query ${queryId}`);
      return parsed.data;
    }

    console.log(`Dune cache expired for query ${queryId}`);
    return null;
  } catch {
    return null;
  }
}

// Save data to cache
function setCachedData<T>(queryId: string | number, data: T[]): void {
  try {
    const cacheEntry: CachedData<T> = {
      data,
      timestamp: Date.now(),
    };
    localStorage.setItem(`${CACHE_PREFIX}${queryId}`, JSON.stringify(cacheEntry));
  } catch (e) {
    console.warn('Failed to cache Dune data:', e);
  }
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

  const fetchData = useCallback(async (forceRefresh = false) => {
    if (!apiKey) {
      setError('Dune API key not configured');
      setIsLoading(false);
      return;
    }

    // Check cache first (unless force refresh)
    if (!forceRefresh) {
      const cachedData = getCachedData<T>(queryId);
      if (cachedData) {
        setData(cachedData);
        setIsLoading(false);
        return;
      }
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

      const rows = result.result?.rows ?? [];

      // Cache the data
      setCachedData(queryId, rows);
      setData(rows);
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

  return { data, isLoading, error, refetch: () => fetchData(true) };
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

  // APY Contract claims per month
  APY_CLAIMS: '6606898',

  // Monthly staking flow (staked/unstaked/net)
  MONTHLY_STAKING_FLOW: '6535334',

  // Weekly stake events and unique stakers
  WEEKLY_STAKES: '6693660',
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

export interface APYClaimsRow {
  month: string;
  num_transfers: number;
  lingo_out: number;
  usd_value: number;
  avg_transfer_size: number;
}

export interface MonthlyStakingFlowRow {
  month: string;
  staked: number;
  unstaked: number;
  net_flow: number;
}

export interface WeeklyStakesRow {
  week: string;
  total_stake_events: number;
  unique_wallets_staked: number;
}
