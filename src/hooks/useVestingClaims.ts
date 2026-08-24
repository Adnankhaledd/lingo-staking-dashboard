import { useState, useEffect } from 'react';

// Live LINGO claims from the vesting contract, per week or month, via
// /api/vesting-claims (reads the Claimed event — mint-safe, no Dune).

export interface VestingClaimBucket {
  period: string;        // week: "YYYY-MM-DD" (Monday) · month: "YYYY-MM"
  lingoClaimed: number;
  claims: number;
}

interface ApiResponse {
  bucket?: 'week' | 'month';
  asOfBlock?: number;
  totalClaims?: number;
  totalLingoClaimed?: number;
  buckets?: VestingClaimBucket[];
  error?: string;
}

interface Result {
  data: VestingClaimBucket[] | null;
  totalClaims: number | null;
  totalLingoClaimed: number | null;
  asOfBlock: number | null;
  isLoading: boolean;
  error: string | null;
}

export function useVestingClaims(bucket: 'week' | 'month' = 'week'): Result {
  const [data, setData] = useState<VestingClaimBucket[] | null>(null);
  const [totalClaims, setTotalClaims] = useState<number | null>(null);
  const [totalLingoClaimed, setTotalLingoClaimed] = useState<number | null>(null);
  const [asOfBlock, setAsOfBlock] = useState<number | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    setIsLoading(true);
    setError(null);
    fetch(`${base}/api/vesting-claims?bucket=${bucket}`)
      .then(r => r.json())
      .then((j: ApiResponse) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        setData(j.buckets ?? []);
        setTotalClaims(j.totalClaims ?? null);
        setTotalLingoClaimed(j.totalLingoClaimed ?? null);
        setAsOfBlock(j.asOfBlock ?? null);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [bucket]);

  return { data, totalClaims, totalLingoClaimed, asOfBlock, isLoading, error };
}
