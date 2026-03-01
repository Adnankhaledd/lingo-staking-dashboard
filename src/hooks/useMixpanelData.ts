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
  const entries = Object.entries(walletData)
    .map(([dateStr, value]) => ({
      date: formatWeekLabel(dateStr),
      value,
      sortKey: dateStr,
    }))
    .sort((a, b) => a.sortKey.localeCompare(b.sortKey));

  // Skip the latest (partial) week
  if (entries.length > 1) entries.pop();

  return entries.map(({ date, value }) => ({ date, value }));
}

function formatWeekLabel(isoStr: string): string {
  const date = new Date(isoStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function parseWeeklyEngagement(
  totals: EventsResponse | null,
  unique: EventsResponse | null,
  eventName: string
): WeeklyEngagement {
  const totalValues = totals?.data?.values?.[eventName] || {};
  const uniqueValues = unique?.data?.values?.[eventName] || {};

  // Skip the latest (partial) week — show last complete week instead
  const totalDates = Object.keys(totalValues).sort();
  const uniqueDates = Object.keys(uniqueValues).sort();
  if (totalDates.length > 1) totalDates.pop();
  if (uniqueDates.length > 1) uniqueDates.pop();

  return {
    thisWeek: totalDates.length > 0 ? totalValues[totalDates[totalDates.length - 1]] ?? 0 : 0,
    lastWeek: totalDates.length > 1 ? totalValues[totalDates[totalDates.length - 2]] ?? 0 : 0,
    thisWeekUsers: uniqueDates.length > 0 ? uniqueValues[uniqueDates[uniqueDates.length - 1]] ?? 0 : 0,
    lastWeekUsers: uniqueDates.length > 1 ? uniqueValues[uniqueDates[uniqueDates.length - 2]] ?? 0 : 0,
  };
}

function parseMonthlyEngagement(
  totals: EventsResponse | null,
  unique: EventsResponse | null,
  eventName: string
): MonthlyEngagement {
  const totalValues = totals?.data?.values?.[eventName] || {};
  const uniqueValues = unique?.data?.values?.[eventName] || {};

  // Skip the latest (partial) month — show last complete month instead
  const totalDates = Object.keys(totalValues).sort();
  const uniqueDates = Object.keys(uniqueValues).sort();
  if (totalDates.length > 1) totalDates.pop();
  if (uniqueDates.length > 1) uniqueDates.pop();

  return {
    thisMonth: totalDates.length > 0 ? totalValues[totalDates[totalDates.length - 1]] ?? 0 : 0,
    lastMonth: totalDates.length > 1 ? totalValues[totalDates[totalDates.length - 2]] ?? 0 : 0,
    thisMonthUsers: uniqueDates.length > 0 ? uniqueValues[uniqueDates[uniqueDates.length - 1]] ?? 0 : 0,
    lastMonthUsers: uniqueDates.length > 1 ? uniqueValues[uniqueDates[uniqueDates.length - 2]] ?? 0 : 0,
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
