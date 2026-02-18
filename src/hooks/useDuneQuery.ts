import { useState, useEffect, useCallback } from 'react';

const DUNE_API_BASE = 'https://api.dune.com/api/v1';
const CACHE_VERSION = 'v4'; // Bump on migration to blob-based architecture
const CACHE_PREFIX = `dune_${CACHE_VERSION}_`;
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// ─── Blob data singleton ────────────────────────────────────────────
// All useDuneQuery hooks share a single fetch to /api/dune-data.
// This ensures only 1 network call regardless of how many hooks are mounted.

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

function fetchBlobData(): Promise<BlobPayload | null> {
  if (blobData) return Promise.resolve(blobData);
  if (blobPromise) return blobPromise;

  blobPromise = fetch('/api/dune-data')
    .then(res => {
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    })
    .then((data: BlobPayload) => {
      blobData = data;
      return data;
    })
    .catch(err => {
      console.warn('Failed to fetch blob data:', err);
      blobPromise = null; // Allow retry on next hook mount
      return null;
    });

  return blobPromise;
}

function resetBlobCache(): void {
  blobPromise = null;
  blobData = null;
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

// ─── localStorage cache layer (fallback) ────────────────────────────

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

// Clear all Dune caches from localStorage + in-memory blob cache
export function clearDuneCache(): void {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && key.startsWith('dune_')) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(key => localStorage.removeItem(key));
  resetBlobCache();
  console.log(`Cleared ${keysToRemove.length} Dune cache entries + blob cache`);
}

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

function getCachedData<T>(queryId: string | number): { data: T[]; executedAt?: string; isStale: boolean } | null {
  const now = Date.now();

  // Try current version first
  const current = parseCacheEntry<T>(`${CACHE_PREFIX}${queryId}`);
  if (current) {
    const isFresh = now - current.timestamp < CACHE_DURATION;
    if (isFresh) {
      return { data: current.data, executedAt: current.executedAt, isStale: false };
    }
    return { data: current.data, executedAt: current.executedAt, isStale: true };
  }

  // Fallback: check previous cache versions
  const legacyPrefixes = ['dune_v3_', 'dune_v2_', 'dune_v1_', 'dune_cache_'];
  for (const prefix of legacyPrefixes) {
    const legacy = parseCacheEntry<T>(`${prefix}${queryId}`);
    if (legacy) {
      return { data: legacy.data, executedAt: legacy.executedAt, isStale: true };
    }
  }

  return null;
}

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

  const fetchData = useCallback(async (forceRefresh = false) => {
    // Check localStorage cache first
    const cached = getCachedData<T>(queryId);

    // If cache is fresh and not forcing, use it directly
    if (!forceRefresh && cached && !cached.isStale) {
      setData(cached.data);
      setExecutedAt(cached.executedAt ?? null);
      setIsLoading(false);
      return;
    }

    // Show stale data immediately while fetching fresh
    if (cached) {
      setData(cached.data);
      setExecutedAt(cached.executedAt ?? null);
    }

    // Only show loading spinner if we have nothing at all
    if (!cached) {
      setIsLoading(true);
    }
    setError(null);

    try {
      // PRIMARY: Try the blob endpoint (single server-cached response)
      const blob = await fetchBlobData();

      if (blob && blob.queries[String(queryId)]) {
        const queryResult = blob.queries[String(queryId)];

        if (queryResult.error && (!queryResult.rows || queryResult.rows.length === 0)) {
          throw new Error(queryResult.error);
        }

        const rows = (queryResult.rows ?? []) as T[];

        if (rows.length > 0) {
          setCachedData(queryId, rows, queryResult.executedAt ?? undefined);
          setData(rows);
          setExecutedAt(queryResult.executedAt ?? null);
          setIsLoading(false);
          return;
        }
      }

      // FALLBACK: Direct Dune API (dev mode or blob unavailable)
      const apiKey = import.meta.env.VITE_DUNE_API_KEY;
      if (!apiKey) {
        // No blob data and no API key — use cached data or show error
        if (cached) {
          setIsLoading(false);
          return;
        }
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
        setCachedData(queryId, rows, queryExecutedAt);
        setData(rows);
        setExecutedAt(queryExecutedAt ?? null);
      } else if (cached) {
        console.warn(`Dune query ${queryId} returned empty, keeping cached data`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'An error occurred';
      console.warn(`Data fetch error for query ${queryId}: ${errorMsg}`);

      // Keep showing cached data if available
      if (cached) {
        setData(cached.data);
        setExecutedAt(cached.executedAt ?? null);
      } else {
        setError(errorMsg);
        setData(null);
      }
    } finally {
      setIsLoading(false);
    }
  }, [queryId, limit]);

  useEffect(() => {
    if (enabled) {
      fetchData();
    }
  }, [enabled, fetchData]);

  return { data, isLoading, error, executedAt, refetch: () => fetchData(true) };
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
