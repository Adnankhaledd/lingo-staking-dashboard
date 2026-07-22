import { useState, useEffect } from 'react';

// Exact staked-by-lock-tier breakdown (current + monthly history) from
// /api/stake-lock-breakdown. Computed on-chain from events, reconciled against
// the staking contract's real LINGO balance.

export interface LockTier {
  tier: string;               // "Flexible" | "3 Months" | "12 Months" | …
  durationBlocks: string;
  stillLocked: number;
  unlockedOrFlexible: number;
  total: number;
  positions: number;
}

export interface LockHistoryRow {
  month: string;              // "YYYY-MM"
  atBlock: number;
  partial?: boolean;          // current, in-progress month
  total: number;
  locked: number;
  free: number;
  byTier: Record<string, number>;
  lockedByTier: Record<string, number>;
}

export interface LockBreakdown {
  asOfBlock: number;
  summary: { stillLocked: number; flexibleOrUnlocked: number; totalOpen: number };
  tiers: LockTier[];
  history: LockHistoryRow[];
  reconciliation: { onChainBalance: number; computedOpen: number; deltaLingo: number } | null;
  events?: { staked: number; closed: number; closedUnmatched: number };
}

interface Result {
  data: LockBreakdown | null;
  isLoading: boolean;
  error: string | null;
}

export function useStakeLockBreakdown(): Result {
  const [data, setData] = useState<LockBreakdown | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    fetch(`${base}/api/stake-lock-breakdown`)
      .then(r => r.json())
      .then((j) => {
        if (cancelled) return;
        if (j?.error) { setError(j.error); return; }
        setData(j as LockBreakdown);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { data, isLoading, error };
}
