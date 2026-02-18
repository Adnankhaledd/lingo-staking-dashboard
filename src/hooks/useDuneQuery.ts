import { useState, useEffect, useCallback } from 'react';

const DUNE_API_BASE = 'https://api.dune.com/api/v1';
const CACHE_VERSION = 'v3'; // Bump to invalidate all old caches
const CACHE_PREFIX = `dune_${CACHE_VERSION}_`;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

interface DuneResponse<T> {
  execution_id: string;
  query_id: number;
  is_execution_finished: boolean;
  state: string;
  execution_ended_at?: string;
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
  executedAt?: string;
}

interface UseDuneQueryOptions {
  enabled?: boolean;
  limit?: number;
}

interface UseDuneQueryReturn<T> {
  data: T[] | null;
  isLoading: boolean;
  error: string | null;
  executedAt: string | null;
  refetch: () => Promise<void>;
}

// Clear all Dune caches from localStorage
export function clearDuneCache(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('dune_')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
  console.log(`Cleared ${keysToRemove.length} Dune cache entries`);
}

// Try to parse cached data from a specific key
function parseCacheEntry<T>(key: string): { data: T[]; executedAt?: string; timestamp: number } | null {
  try {
    const cached = localStorage.getItem(key);
    if (!cached) return null;

    const parsed: CachedData<T> = JSON.parse(cached);
    if (!parsed.data || parsed.data.length === 0) return null;
    if (!parsed.executedAt) return null;

    return { data: parsed.data, executedAt: parsed.executedAt, timestamp: parsed.timestamp };
  } catch {
    return null;
  }
}

// Get cached data - returns fresh or stale data with a flag
// Also checks previous cache versions as fallback
function getCachedData<T>(queryId: string | number): { data: T[]; executedAt?: string; isStale: boolean } | null {
  const now = Date.now();

  // Try current version first
  const current = parseCacheEntry<T>(`${CACHE_PREFIX}${queryId}`);
  if (current) {
    const isFresh = now - current.timestamp < CACHE_DURATION;
    if (isFresh) {
      console.log(`Using cached Dune data for query ${queryId}`);
      return { data: current.data, executedAt: current.executedAt, isStale: false };
    }
    console.log(`Dune cache expired for query ${queryId}, returning stale for fallback`);
    return { data: current.data, executedAt: current.executedAt, isStale: true };
  }

  // Fallback: check previous cache versions (v2, v1, original)
  const legacyPrefixes = ['dune_v2_', 'dune_v1_', 'dune_cache_'];
  for (const prefix of legacyPrefixes) {
    const legacy = parseCacheEntry<T>(`${prefix}${queryId}`);
    if (legacy) {
      console.log(`Found legacy cache (${prefix}) for query ${queryId}, using as stale fallback`);
      return { data: legacy.data, executedAt: legacy.executedAt, isStale: true };
    }
  }

  return null;
}

// Save data to cache
function setCachedData<T>(queryId: string | number, data: T[], executedAt?: string): void {
  try {
    const cacheEntry: CachedData<T> = {
      data,
      timestamp: Date.now(),
      executedAt,
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
  const [executedAt, setExecutedAt] = useState<string | null>(null);

  const apiKey = import.meta.env.VITE_DUNE_API_KEY;

  const fetchData = useCallback(async (forceRefresh = false) => {
    if (!apiKey) {
      setError('Dune API key not configured');
      setIsLoading(false);
      return;
    }

    // Check cache first
    const cached = getCachedData<T>(queryId);

    // If cache is fresh and not force refreshing, use it directly
    if (!forceRefresh && cached && !cached.isStale) {
      setData(cached.data);
      setExecutedAt(cached.executedAt ?? null);
      setIsLoading(false);
      return;
    }

    // If we have stale cached data, show it immediately while fetching
    if (cached) {
      setData(cached.data);
      setExecutedAt(cached.executedAt ?? null);
    }

    // Only show loading spinner if we have no data at all to display
    if (!cached) {
      setIsLoading(true);
    }
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
      const queryExecutedAt = result.execution_ended_at;

      // Only update if we actually got data (don't replace good data with empty)
      if (rows.length > 0) {
        setCachedData(queryId, rows, queryExecutedAt);
        setData(rows);
        setExecutedAt(queryExecutedAt ?? null);
      } else if (cached) {
        // API returned empty rows — keep showing cached data
        console.warn(`Dune query ${queryId} returned empty, keeping cached data`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'An error occurred';
      console.warn(`Dune API error for query ${queryId}: ${errorMsg}`);

      // If we have cached data (even stale), keep showing it instead of wiping
      if (cached) {
        console.log(`Using stale cache as fallback for query ${queryId}`);
        setData(cached.data);
        setExecutedAt(cached.executedAt ?? null);
        // Don't set error state — user still sees data, just stale
      } else {
        // No cached data at all — show the error
        setError(errorMsg);
        setData(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [queryId, apiKey, limit]);

  useEffect(() => {
    if (enabled) {
      fetchData();
    }
  }, [enabled, fetchData]);

  return { data, isLoading, error, executedAt, refetch: () => fetchData(true) };
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

  // Liquidity pool fees per month
  LP_FEES: '6693715',

  // Membership tiers by lock period
  MEMBERSHIP_TIERS: '6708293',
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

export interface LPFeesRow {
  month: string;
  fees_usd: number;
  trades: number;
  volume_usd: number;
}

export interface MembershipTiersRow {
  lock_period: string;
  total_users: number;
  users_100_plus: number;
  users_500_plus: number;
  users_1000_plus: number;
  users_5000_plus: number;
  total_lingo_staked: number;
  total_usd_value: number;
  price_used: number;
}
