import { useCallback, useEffect, useState } from 'react';

export interface SupplyWallet {
  name: string;
  address: string;
  balance: number | null;
  note?: string;
}

export interface SupplyData {
  totalSupply: number | null;
  wallets: SupplyWallet[];
  fetchedAt: string | null;
  configured: boolean;
  error: string | null;
}

interface UseSupplyDataResult extends SupplyData {
  isLoading: boolean;
  refetch: () => void;
}

const POLL_MS = 5 * 60 * 1000; // 5 min, matches the CDN cache on the API side

export function useSupplyData(): UseSupplyDataResult {
  const [data, setData] = useState<SupplyData>({
    totalSupply: null,
    wallets: [],
    fetchedAt: null,
    configured: true,
    error: null,
  });
  const [isLoading, setIsLoading] = useState(true);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/supply');
      if (!res.ok) {
        setData(d => ({ ...d, error: `HTTP ${res.status}` }));
        return;
      }
      const json = await res.json();
      setData({
        totalSupply: json.totalSupply ?? null,
        wallets: json.wallets ?? [],
        fetchedAt: json.fetchedAt ?? null,
        configured: json.configured ?? false,
        error: json.error ?? null,
      });
    } catch (err) {
      setData(d => ({ ...d, error: err instanceof Error ? err.message : 'Unknown error' }));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Poll only while the tab is visible (see useLiveActivity) — a background tab
  // shouldn't keep spending Alchemy calls. Refresh when it comes back.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      fetchData();
      timer = setInterval(fetchData, POLL_MS);
    };
    const stop = () => { if (timer) { clearInterval(timer); timer = null; } };
    const onVisibility = () => (document.hidden ? stop() : start());
    if (document.hidden) fetchData(); else start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { stop(); document.removeEventListener('visibilitychange', onVisibility); };
  }, [fetchData]);

  return { ...data, isLoading, refetch: fetchData };
}
