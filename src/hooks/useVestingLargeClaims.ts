import { useState, useEffect } from 'react';

// Recent large LINGO claims from the vesting contract, live via
// /api/vesting-large-claims (Claimed event — mint-safe, exact per-log time).

export interface LargeClaim {
  wallet: string;
  lingo: number;
  timestamp: number; // unix seconds
  txHash: string | null;
}

interface ApiResponse {
  days?: number;
  minLingo?: number;
  asOfBlock?: number;
  windowClaims?: number;
  windowLingo?: number;
  largeClaims?: number;
  largeLingo?: number;
  claims?: LargeClaim[];
  truncated?: boolean;
  error?: string;
}

interface Result {
  data: LargeClaim[] | null;
  windowClaims: number | null;
  windowLingo: number | null;
  largeClaims: number | null;
  largeLingo: number | null;
  asOfBlock: number | null;
  truncated: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useVestingLargeClaims(days = 30, minLingo = 50000): Result {
  const [data, setData] = useState<LargeClaim[] | null>(null);
  const [windowClaims, setWindowClaims] = useState<number | null>(null);
  const [windowLingo, setWindowLingo] = useState<number | null>(null);
  const [largeClaims, setLargeClaims] = useState<number | null>(null);
  const [largeLingo, setLargeLingo] = useState<number | null>(null);
  const [asOfBlock, setAsOfBlock] = useState<number | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    setIsLoading(true);
    setError(null);
    fetch(`${base}/api/vesting-large-claims?days=${days}&minLingo=${minLingo}`)
      .then(r => r.json())
      .then((j: ApiResponse) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        setData(j.claims ?? []);
        setWindowClaims(j.windowClaims ?? null);
        setWindowLingo(j.windowLingo ?? null);
        setLargeClaims(j.largeClaims ?? null);
        setLargeLingo(j.largeLingo ?? null);
        setAsOfBlock(j.asOfBlock ?? null);
        setTruncated(!!j.truncated);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [days, minLingo]);

  return { data, windowClaims, windowLingo, largeClaims, largeLingo, asOfBlock, truncated, isLoading, error };
}
