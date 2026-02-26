import { useState, useEffect, useCallback } from 'react';

const DUNE_API_BASE = 'https://api.dune.com/api/v1';

// ─── Blob data singleton with TTL ──────────────────────────────────
// All useDuneQuery hooks share a single fetch to /api/dune-data.
// This ensures only 1 network call regardless of how many hooks are mounted.
// The singleton expires after 5 minutes so fresh data is picked up
// on subsequent page loads without needing manual cache clearing.

const BLOB_TTL = 5 * 60 * 1000; // 5 minutes — re-fetch from server after this

interface BlobQueryResult {
  rows: unknown[];
  executedAt: string | null;
  error: string | null;
}

interface BlobPayload {
  queries: Record<string, BlobQueryResult>;
  refreshedAt: string;
  queryCount: number;
  successCount: number;
}

let blobPromise: Promise<BlobPayload | null> | null = null;
let blobData: BlobPayload | null = null;
let blobFetchedAt = 0;

function fetchBlobData(): Promise<BlobPayload | null> {
  const now = Date.now();

  // If we have data and it's still fresh, return it
  if (blobData && now - blobFetchedAt < BLOB_TTL) {
    return Promise.resolve(blobData);
  }

  // If a fetch is already in-flight, reuse it
  if (blobPromise) return blobPromise;

  // Expired or no data — fetch fresh
  blobPromise = fetch('/api/dune-data')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data: BlobPayload) => {
      blobData = data;
      blobFetchedAt = Date.now();
      blobPromise = null;
      return data;
    })
    .catch(err => {
      console.warn('Failed to fetch blob data:', err);
      blobPromise = null; // Allow retry on next hook mount
      return blobData; // Return stale data if available
    });

  return blobPromise;
}

function resetBlobCache(): void {
  blobPromise = null;
  blobData = null;
  blobFetchedAt = 0;
}

// ─── DuneResponse type (for direct API fallback in dev) ─────────────

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

// Reset blob cache so next page load fetches fresh data from server.
// Also clears any legacy localStorage entries from older cache versions.
export function clearDuneCache(): void {
  // Clean up legacy localStorage entries (from previous cache architecture)
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('dune_')) {
      keysToRemove.push(key);
    }
  }
  if (keysToRemove.length > 0) {
    keysToRemove.forEach(key => localStorage.removeItem(key));
    console.log(`Cleaned up ${keysToRemove.length} legacy Dune localStorage entries`);
  }

  resetBlobCache();
  console.log('Dune cache cleared — will re-fetch from server');
}

// Alias kept for backward compat
export const softRefresh = clearDuneCache;

// ─── Main hook ──────────────────────────────────────────────────────

export function useDuneQuery<T>(
  queryId: string | number,
  options: UseDuneQueryOptions = {}
): UseDuneQueryReturn<T> {
  const { enabled = true, limit = 1000 } = options;
  const [data, setData] = useState<T[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [executedAt, setExecutedAt] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      // PRIMARY: Fetch from blob endpoint (shared singleton, 5-min TTL)
      const blob = await fetchBlobData();

      if (blob && blob.queries[String(queryId)]) {
        const queryResult = blob.queries[String(queryId)];

        if (queryResult.error && (!queryResult.rows || queryResult.rows.length === 0)) {
          throw new Error(queryResult.error);
        }

        const rows = (queryResult.rows ?? []) as T[];

        if (rows.length > 0) {
          setData(rows);
          setExecutedAt(queryResult.executedAt ?? null);
          setIsLoading(false);
          return;
        }
      }

      // FALLBACK: Direct Dune API (dev mode or blob unavailable)
      const apiKey = import.meta.env.VITE_DUNE_API_KEY;
      if (!apiKey) {
        throw new Error('No data available — waiting for server refresh');
      }

      console.log(`Falling back to direct Dune API for query ${queryId}`);
      const response = await fetch(
        `${DUNE_API_BASE}/query/${queryId}/results?limit=${limit}`,
        { headers: { 'X-Dune-API-Key': apiKey } }
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

      if (rows.length > 0) {
        setData(rows);
        setExecutedAt(queryExecutedAt ?? null);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'An error occurred';
      console.warn(`Data fetch error for query ${queryId}: ${errorMsg}`);
      setError(errorMsg);
      setData(null);
    } finally {
      setIsLoading(false);
    }
  }, [queryId, limit]);

  useEffect(() => {
    if (enabled) {
      fetchData();
    }
  }, [enabled, fetchData]);

  return { data, isLoading, error, executedAt, refetch: fetchData };
}

// ─── Query IDs ──────────────────────────────────────────────────────

export const DUNE_QUERIES = {
  TOTAL_STAKED_TREND: '6590984',
  WEEKLY_STATS: '6534908',
  WEEKLY_NEW_STAKERS: '6535206',
  COHORT_RETENTION: '6528806',
  STAKING_TIERS: '6560698',
  UNLOCK_SCHEDULE: '6543709',
  TOP_STAKERS: '6632385',
  TRADING_FEES: '6288543',
  APY_CLAIMS: '6606898',
  MONTHLY_STAKING_FLOW: '6535334',
  WEEKLY_STAKES: '6693660',
  LP_FEES: '6693715',
  MEMBERSHIP_TIERS: '6708293',
  MONTHLY_NEW_RETURNING: '6738028',
  STAKING_TIERS_BY_LOCK: '6738074',
} as const;

// ─── Row type definitions ───────────────────────────────────────────

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

export interface MonthlyNewReturningRow {
  stake_month: string;
  new_wallets: number;
  returning_wallets: number;
  new_lingo_staked: number;
  returning_lingo_staked: number;
  total_lingo_staked: number;
}

export interface StakingTiersByLockRow {
  threshold: string;
  flexible_users: number;
  flexible_lingo: number;
  '3mo_users': number;
  '3mo_lingo': number;
  '6mo_users': number;
  '6mo_lingo': number;
  '12mo_users': number;
  '12mo_lingo': number;
  total_users: number;
  total_lingo: number;
  price_used: number;
}
