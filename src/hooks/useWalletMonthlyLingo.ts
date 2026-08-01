import { useState, useEffect } from 'react';

// Monthly LINGO in/out for a wallet, straight from Alchemy via
// /api/reward-wallet-monthly (exact, no Dune). Omit `wallet` for the default
// community reward wallet; pass an address for any other (e.g. the APY wallet).

export interface WalletMonthlyRow {
  month: string;      // "YYYY-MM"
  lingoSent: number;  // OUT
  lingoIn: number;    // IN
  net: number;        // in − out
  transfers: number;      // out transfers
  inTransfers: number;    // in transfers
}

export interface WalletReconciliation {
  balanceNow: number;
  impliedBalance: number;   // totalIn − totalOut
  unaccountedLingo: number; // impliedBalance − balanceNow (≈0 = complete)
}

interface ApiResponse {
  wallet?: string;
  months?: WalletMonthlyRow[];
  totalLingoSent?: number;
  totalLingoIn?: number;
  reconciliation?: WalletReconciliation | null;
  capped?: boolean;
  error?: string;
}

interface Result {
  data: WalletMonthlyRow[] | null;
  totalOut: number | null;
  totalIn: number | null;
  reconciliation: WalletReconciliation | null;
  capped: boolean;
  isLoading: boolean;
  error: string | null;
}

export function useWalletMonthlyLingo(wallet?: string): Result {
  const [data, setData] = useState<WalletMonthlyRow[] | null>(null);
  const [totalOut, setTotalOut] = useState<number | null>(null);
  const [totalIn, setTotalIn] = useState<number | null>(null);
  const [reconciliation, setReconciliation] = useState<WalletReconciliation | null>(null);
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
        setTotalOut(j.totalLingoSent ?? null);
        setTotalIn(j.totalLingoIn ?? null);
        setReconciliation(j.reconciliation ?? null);
        setCapped(!!j.capped);
      })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [wallet]);

  return { data, totalOut, totalIn, reconciliation, capped, isLoading, error };
}
