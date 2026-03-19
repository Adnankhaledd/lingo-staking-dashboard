import { useState, useEffect } from 'react';

// Use API proxy to avoid CORS issues
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

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
  wauTrend: DailyMetric[];
  currentDAU: number;
  currentWAU: number;
  currentMAU: number;
  avgDAU: number;
  // Weekly engagement
  asteroidsSmashed: WeeklyEngagement;
  raffleEntries: WeeklyEngagement;
  tasksCompleted: WeeklyEngagement;
  // Monthly engagement
  monthlyAsteroidsSmashed: MonthlyEngagement;
  monthlyRaffleEntries: MonthlyEngagement;
  monthlyTasksCompleted: MonthlyEngagement;
}

// ─── Blob response shape (from /api/mixpanel serving blob data) ──────

interface MixpanelBlobResponse {
  dau: DAUReportResponse | null;
  wau: EventsResponse | null;
  mau: EventsResponse | null;
  weeklyEngagement: { totals: EventsResponse; unique: EventsResponse } | null;
  monthlyEngagement: { totals: EventsResponse; unique: EventsResponse } | null;
  errors?: Record<string, string>;
  refreshedAt: string;
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

function transformWAUData(data: EventsResponse | null): DailyMetric[] {
  const walletData = data?.data?.values?.['Wallet Connected'] || {};
  return Object.entries(walletData)
    .map(([dateStr, value]) => ({
      date: formatWeekLabel(dateStr),
      value,
      sortKey: dateStr,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey))
    .map(({ date, value }) => ({ date, value }));
}

function formatWeekLabel(isoStr: string): string {
  const date = new Date(isoStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** Drop the current incomplete period and return the last two completed ones. */
function completedLatestAndPrev(
  obj: Record<string, number>,
  period: 'week' | 'month'
): { latest: number; prev: number } {
  const now = new Date();
  let currentPeriodStart: string;

  if (period === 'week') {
    // Monday of current week
    const d = new Date(now);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1);
    d.setDate(diff);
    currentPeriodStart = d.toISOString().split('T')[0];
  } else {
    // First of current month
    currentPeriodStart = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
  }

  // Keep only dates before the current period start
  const completedDates = Object.keys(obj)
    .sort()
    .filter((d) => d < currentPeriodStart);

  return {
    latest: completedDates.length > 0 ? obj[completedDates[completedDates.length - 1]] ?? 0 : 0,
    prev: completedDates.length > 1 ? obj[completedDates[completedDates.length - 2]] ?? 0 : 0,
  };
}

function parseWeeklyEngagement(
  totals: EventsResponse | null,
  unique: EventsResponse | null,
  eventName: string
): WeeklyEngagement {
  const totalValues = totals?.data?.values?.[eventName] || {};
  const uniqueValues = unique?.data?.values?.[eventName] || {};
  const t = completedLatestAndPrev(totalValues, 'week');
  const u = completedLatestAndPrev(uniqueValues, 'week');

  return {
    thisWeek: t.latest,
    lastWeek: t.prev,
    thisWeekUsers: u.latest,
    lastWeekUsers: u.prev,
  };
}

function parseMonthlyEngagement(
  totals: EventsResponse | null,
  unique: EventsResponse | null,
  eventName: string
): MonthlyEngagement {
  const totalValues = totals?.data?.values?.[eventName] || {};
  const uniqueValues = unique?.data?.values?.[eventName] || {};
  const t = completedLatestAndPrev(totalValues, 'month');
  const u = completedLatestAndPrev(uniqueValues, 'month');

  return {
    thisMonth: t.latest,
    lastMonth: t.prev,
    thisMonthUsers: u.latest,
    lastMonthUsers: u.prev,
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

        // Fetch from blob-served endpoint (CDN cached, no live Mixpanel calls)
        const response = await fetch(`${API_BASE}/api/mixpanel`);
        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const raw: MixpanelBlobResponse = await response.json();

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
        const wauTrend = transformWAUData(wauData);
        const currentWAU = wauTrend.length > 0 ? wauTrend[wauTrend.length - 1].value : 0;

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
        const tasksCompleted = raw.weeklyEngagement
          ? parseWeeklyEngagement(weTotals, weUnique, 'Task Completed')
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
        const monthlyTasksCompleted = raw.monthlyEngagement
          ? parseMonthlyEngagement(meTotals, meUnique, 'Task Completed')
          : DEFAULT_MONTHLY;

        // ── Assemble metrics ────────────────────────────────────────
        const metrics: MixpanelMetrics = {
          dauTrend,
          wauTrend,
          currentDAU,
          currentWAU,
          currentMAU,
          avgDAU,
          asteroidsSmashed,
          raffleEntries,
          tasksCompleted,
          monthlyAsteroidsSmashed,
          monthlyRaffleEntries,
          monthlyTasksCompleted,
        };

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
