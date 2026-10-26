import { useEffect, useState } from 'react';

// LINGO/USD per day from the LINGO/WETH pool's own trades (/api/pool-prices).
// Served from storage built nightly; loading it makes no Alchemy calls.

interface Result {
  /** [YYYY-MM-DD, LINGO/USD] for days with trades, ascending. */
  days: Array<[string, number]> | null;
  isLoading: boolean;
  error: string | null;
}

export function usePoolPrices(): Result {
  const [days, setDays] = useState<Array<[string, number]> | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    fetch(`${base}/api/pool-prices`)
      .then(r => r.json())
      .then(j => {
        if (cancelled) return;
        if (j?.error || !Array.isArray(j?.days)) { setError(j?.error ?? 'No price history'); return; }
        setDays(j.days);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, []);

  return { days, isLoading, error };
}
