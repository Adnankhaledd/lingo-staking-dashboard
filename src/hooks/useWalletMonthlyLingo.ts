import { useState, useEffect } from 'react';

// Monthly LINGO sent FROM a wallet, straight from Alchemy via
// /api/reward-wallet-monthly (exact, no Dune). Omit `wallet` for the default
// community reward wallet; pass an address for any other (e.g. the APY wallet).

export interface WalletMonthlyRow {
  month: string;      // "YYYY-MM"
  lingoSent: number;
  transfers: number;
}

interface ApiResponse {
  wallet?: string;
  months?: WalletMonthlyRow[];
  totalLingoSent?: number;
  capped?: boolean;
  error?: string;
}

interface Result {
  data: WalletMonthlyRow[] | null;
  total: number | null;
  capped: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useWalletMonthlyLingo(wallet?: string): Result {
  const [data, setData] = useState<WalletMonthlyRow[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [capped, setCapped] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    const url = `${base}/api/reward-wallet-monthly${wallet ? `?wallet=${wallet}` : ''}`;
    setIsLoading(true);
    setError(null);
    fetch(url)
      .then(r => r.json())
      .then((j: ApiResponse) => {
        if (cancelled) return;
        if (j.error) setError(j.error);
        setData(j.months ?? []);
        setTotal(j.totalLingoSent ?? null);
        setCapped(!!j.capped);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [wallet]);

  return { data, total, capped, isLoading, error };
}
