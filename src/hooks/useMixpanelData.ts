import { useState, useEffect } from 'react';

// Use API proxy to avoid CORS issues
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';
const CACHE_KEY = 'mixpanel_data_cache_v9';
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours

// ─── Types ───────────────────────────────────────────────────────────

interface EventsResponse {
  data: {
    series: string[];
    values: Record<string, Record<string, number>>;
  };
}

interface DAUReportResponse {
  series: {
    'A. DAU': Record<string, number>;
  };
  date_range: {
    from_date: string;
    to_date: string;
  };
}

export interface DailyMetric {
  date: string;
  value: number;
}

export interface WeeklyEngagement {
  thisWeek: number;
  lastWeek: number;
  thisWeekUsers: number;
  lastWeekUsers: number;
}

export interface MonthlyEngagement {
  thisMonth: number;
  lastMonth: number;
  thisMonthUsers: number;
  lastMonthUsers: number;
}

export interface MixpanelMetrics {
  dauTrend: DailyMetric[];
  currentDAU: number;
  currentWAU: number;
  currentMAU: number;
  avgDAU: number;
  // Weekly engagement
  asteroidsSmashed: WeeklyEngagement;
  raffleEntries: WeeklyEngagement;
  rewardsClaimed: WeeklyEngagement;
  // Monthly engagement
  monthlyAsteroidsSmashed: MonthlyEngagement;
  monthlyRaffleEntries: MonthlyEngagement;
  monthlyRewardsClaimed: MonthlyEngagement;
}

// ─── Combined API response shape ─────────────────────────────────────

interface AllMixpanelResponse {
  dau: DAUReportResponse | null;
  wau: EventsResponse | null;
  mau: EventsResponse | null;
  weeklyEngagement: { totals: EventsResponse; unique: EventsResponse } | null;
  monthlyEngagement: { totals: EventsResponse; unique: EventsResponse } | null;
  errors?: Record<string, string>;
  fetchedAt: string;
}

// ─── Cache ───────────────────────────────────────────────────────────

interface CachedData {
  data: MixpanelMetrics;
  timestamp: number;
}

function getCachedData(): MixpanelMetrics | null {
  try {
    const cached = localStorage.getItem(CACHE_KEY);
    if (!cached) return null;

    const parsed: CachedData = JSON.parse(cached);
    const now = Date.now();

    if (now - parsed.timestamp < CACHE_DURATION) {
      console.log('Using cached Mixpanel data');
      return parsed.data;
    }

    console.log('Mixpanel cache expired');
    return null;
  } catch {
    return null;
  }
}

function setCachedData(data: MixpanelMetrics): void {
  try {
    const cacheEntry: CachedData = { data, timestamp: Date.now() };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cacheEntry));
  } catch (e) {
    console.warn('Failed to cache Mixpanel data:', e);
  }
}

// ─── Data transformation helpers ─────────────────────────────────────

function transformDAUData(data: DAUReportResponse): DailyMetric[] {
  const dauSeries = data.series?.['A. DAU'] || {};

  return Object.entries(dauSeries)
    .map(([dateStr, value]) => ({
      date: formatDate(dateStr),
      value,
    }))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

function formatDate(isoStr: string): string {
  const date = new Date(isoStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function latestValue(obj: Record<string, number>): number {
  const dates = Object.keys(obj).sort();
  return dates.length > 0 ? obj[dates[dates.length - 1]] ?? 0 : 0;
}

function prevValue(obj: Record<string, number>): number {
  const dates = Object.keys(obj).sort();
  return dates.length > 1 ? obj[dates[dates.length - 2]] ?? 0 : 0;
}

function parseWeeklyEngagement(
  totals: EventsResponse | null,
  unique: EventsResponse | null,
  eventName: string
): WeeklyEngagement {
  const totalValues = totals?.data?.values?.[eventName] || {};
  const uniqueValues = unique?.data?.values?.[eventName] || {};

  return {
    thisWeek: latestValue(totalValues),
    lastWeek: prevValue(totalValues),
    thisWeekUsers: latestValue(uniqueValues),
    lastWeekUsers: prevValue(uniqueValues),
  };
}

function parseMonthlyEngagement(
  totals: EventsResponse | null,
  unique: EventsResponse | null,
  eventName: string
): MonthlyEngagement {
  const totalValues = totals?.data?.values?.[eventName] || {};
  const uniqueValues = unique?.data?.values?.[eventName] || {};

  return {
    thisMonth: latestValue(totalValues),
    lastMonth: prevValue(totalValues),
    thisMonthUsers: latestValue(uniqueValues),
    lastMonthUsers: prevValue(uniqueValues),
  };
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_ENGAGEMENT: WeeklyEngagement = { thisWeek: 0, lastWeek: 0, thisWeekUsers: 0, lastWeekUsers: 0 };
const DEFAULT_MONTHLY: MonthlyEngagement = { thisMonth: 0, lastMonth: 0, thisMonthUsers: 0, lastMonthUsers: 0 };

// ─── Main hook ───────────────────────────────────────────────────────

export function useMixpanelData() {
  const [data, setData] = useState<MixpanelMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        // Check cache first
        const cachedData = getCachedData();
        if (cachedData) {
          setData(cachedData);
          setIsLoading(false);
          return;
        }

        // ── Single API call fetches everything ──────────────────────
        const response = await fetch(`${API_BASE}/api/mixpanel?type=all`);
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const raw: AllMixpanelResponse = await response.json();

        if (raw.errors && Object.keys(raw.errors).length > 0) {
          console.warn('Mixpanel partial errors:', raw.errors);
        }

        // ── Parse DAU ───────────────────────────────────────────────
        const dauTrend = raw.dau ? transformDAUData(raw.dau) : [];
        const currentDAU = dauTrend.length > 0 ? dauTrend[dauTrend.length - 1].value : 0;
        const avgDAU = dauTrend.length > 0
          ? Math.round(dauTrend.reduce((sum, d) => sum + d.value, 0) / dauTrend.length)
          : 0;

        // ── Parse WAU ───────────────────────────────────────────────
        const wauData = raw.wau as EventsResponse | null;
        const walletData = wauData?.data?.values?.['Wallet Connected'] || {};
        const wauDates = Object.keys(walletData).sort();
        const currentWAU = wauDates.length > 0 ? walletData[wauDates[wauDates.length - 1]] ?? 0 : 0;

        // ── Parse MAU ───────────────────────────────────────────────
        const mauData = raw.mau as EventsResponse | null;
        const mauValues = Object.values(mauData?.data?.values?.['Wallet Connected'] || {});
        const currentMAU = mauValues.reduce((sum, val) => sum + val, 0);

        // ── Parse weekly engagement ─────────────────────────────────
        const weTotals = raw.weeklyEngagement?.totals ?? null;
        const weUnique = raw.weeklyEngagement?.unique ?? null;

        const asteroidsSmashed = raw.weeklyEngagement
          ? parseWeeklyEngagement(weTotals, weUnique, 'Asteroid Smashed')
          : DEFAULT_ENGAGEMENT;
        const raffleEntries = raw.weeklyEngagement
          ? parseWeeklyEngagement(weTotals, weUnique, 'Raffle Ticket Purchased')
          : DEFAULT_ENGAGEMENT;
        const rewardsClaimed = raw.weeklyEngagement
          ? parseWeeklyEngagement(weTotals, weUnique, 'Reward Claimed')
          : DEFAULT_ENGAGEMENT;

        // ── Parse monthly engagement ────────────────────────────────
        const meTotals = raw.monthlyEngagement?.totals ?? null;
        const meUnique = raw.monthlyEngagement?.unique ?? null;

        const monthlyAsteroidsSmashed = raw.monthlyEngagement
          ? parseMonthlyEngagement(meTotals, meUnique, 'Asteroid Smashed')
          : DEFAULT_MONTHLY;
        const monthlyRaffleEntries = raw.monthlyEngagement
          ? parseMonthlyEngagement(meTotals, meUnique, 'Raffle Ticket Purchased')
          : DEFAULT_MONTHLY;
        const monthlyRewardsClaimed = raw.monthlyEngagement
          ? parseMonthlyEngagement(meTotals, meUnique, 'Reward Claimed')
          : DEFAULT_MONTHLY;

        // ── Assemble metrics ────────────────────────────────────────
        const metrics: MixpanelMetrics = {
          dauTrend,
          currentDAU,
          currentWAU,
          currentMAU,
          avgDAU,
          asteroidsSmashed,
          raffleEntries,
          rewardsClaimed,
          monthlyAsteroidsSmashed,
          monthlyRaffleEntries,
          monthlyRewardsClaimed,
        };

        // Only cache if no critical errors (DAU + WAU + MAU all present)
        const hasErrors = raw.errors && Object.keys(raw.errors).length > 0;
        const criticalMissing = !raw.dau || !raw.wau || !raw.mau;

        if (!hasErrors && !criticalMissing) {
          setCachedData(metrics);
        } else {
          console.warn('Skipping Mixpanel cache — partial data received');
        }

        setData(metrics);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to fetch Mixpanel data');
        console.error('Mixpanel fetch error:', err);
      } finally {
        setIsLoading(false);
      }
    }

    fetchData();
  }, []);

  return { data, isLoading, error };
}
