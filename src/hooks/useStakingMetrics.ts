import { useState, useEffect } from 'react';
import type { LockBreakdown } from './useStakeLockBreakdown';

// Daily snapshot from /api/staking-metrics — every chart on /v2, rebuilt once a
// day from the staking contract's events and reconciled against its balance.
// Mirrors the Snapshot type in api/staking-metrics.ts (api/ can't be imported
// from the frontend build).

export type Bucket = 'flexible' | '3mo' | '6mo' | '12mo' | 'other';
export type Tier = 'below' | 'member' | 'holder' | 'elite' | 'legend';

export interface DailyRow {
  day: string;
  total_staked: number;
  change_from_yesterday: number;
  change_pct: number | null;
  staked: number;
  unstaked: number;
  active_stakers: number;
}

export interface MonthlyRow {
  month: string;
  partial: boolean;
  price: number | null;
  endTotal: number;
  endLocked: number;
  activeStakers: number;
  staked: Record<Bucket, number> & { total: number };
  stakeEvents: number;
  uniqueStakers: number;
  unstaked: number;
  unstakeEvents: number;
  newWallets: number;
  newLingo: number;
  firstStakeLingo: number;
  returningWallets: number;
  returningLingo: number;
  newWalletTiers: Record<Tier, number>;
  lockedByBucket: Record<Bucket, number>;
  totalByBucket: Record<Bucket, number>;
  tiers: Record<Tier, number>;      // active stakers valued at that month-end's price
  tiersNow: Record<Tier, number>;   // same balances valued at today's price
}

export interface CohortRow {
  month: string;
  size: number;
  neverUnstaked: number;
  partial: number;
  exited: number;
  retainedPct: number;
  curve: number[];
}

export interface StakingMetrics {
  version: number;
  generatedAt: string;
  asOfBlock: number;
  asOfTs: number;
  requests: Record<string, number>;
  source: { stakedEvents: number; closeEvents: number; closedUnmatched: number; timestampsEstimated: number };
  price: { live: number | null; firstDay: string | null; days: number };
  reconciliation: { onChainBalance: number; computedOpen: number; deltaLingo: number } | null;
  current: {
    totalStaked: number; locked: number; unlocked: number; activeStakers: number;
    byBucket: Record<Bucket, { locked: number; total: number }>;
    tiers: Record<Tier, number>;
  };
  daily: DailyRow[];
  monthly: MonthlyRow[];
  cohorts: CohortRow[];
  topStakers: Array<{ address: string; staked: number; locked: number; usd: number | null; positions: number; firstStake: string }>;
  lockBreakdown: LockBreakdown;
}

interface Result {
  data: StakingMetrics | null;
  isLoading: boolean;
  error: string | null;
}

export function useStakingMetrics(): Result {
  const [data, setData] = useState<StakingMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    fetch(`${base}/api/staking-metrics`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j?.error) { setError(j.error); return; }
        setData(j as StakingMetrics);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { data, isLoading, error };
}
