import { useState, useEffect } from 'react';

// Use API proxy to avoid CORS issues
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';
const CACHE_KEY = 'mixpanel_data_cache_v8';
const CACHE_DURATION = 4 * 60 * 60 * 1000; // 4 hours — short enough to recover from failures quickly

interface DAUReportResponse {
  series: {
    'A. DAU': Record<string, number>;
  };
  date_range: {
    from_date: string;
    to_date: string;
  };
}

interface EventsResponse {
  data: {
    series: string[];
    values: Record<string, Record<string, number>>;
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

interface CachedData {
  data: MixpanelMetrics;
  timestamp: number;
}

// Check if cache is valid
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

// Save to cache
function setCachedData(data: MixpanelMetrics): void {
  try {
    const cacheEntry: CachedData = {
      data,
      timestamp: Date.now(),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cacheEntry));
  } catch (e) {
    console.warn('Failed to cache Mixpanel data:', e);
  }
}

// Fetch DAU from the API proxy
async function fetchDAUReport(): Promise<DAUReportResponse> {
  const response = await fetch(`${API_BASE}/api/mixpanel?type=dau`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  return response.json();
}

// Fetch WAU from the API proxy
async function fetchWAU(): Promise<number> {
  const response = await fetch(`${API_BASE}/api/mixpanel?type=wau`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data: EventsResponse = await response.json();
  const walletData = data.data?.values?.['Wallet Connected'] || {};
  const dates = Object.keys(walletData).sort();
  // Use the most recent week's unique count (not the sum of all weeks)
  if (dates.length === 0) return 0;
  return walletData[dates[dates.length - 1]] ?? 0;
}

// Fetch MAU from the API proxy
async function fetchMAU(): Promise<number> {
  const response = await fetch(`${API_BASE}/api/mixpanel?type=mau`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data: EventsResponse = await response.json();
  const values = Object.values(data.data?.values?.['Wallet Connected'] || {});
  return values.reduce((sum, val) => sum + val, 0);
}

// Response shape from combined weekly_engagement endpoint
interface WeeklyEngagementResponse {
  totals: EventsResponse;
  unique: EventsResponse;
}

// Fetch weekly engagement events (asteroids, raffles, rewards)
async function fetchWeeklyEngagement(): Promise<{
  asteroidsSmashed: WeeklyEngagement;
  raffleEntries: WeeklyEngagement;
  rewardsClaimed: WeeklyEngagement;
}> {
  const response = await fetch(`${API_BASE}/api/mixpanel?type=weekly_engagement`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data: WeeklyEngagementResponse = await response.json();
  const totalValues = data.totals?.data?.values || {};
  const uniqueValues = data.unique?.data?.values || {};

  // Validate that both sub-requests returned real data — if totals is
  // empty but unique has data, the general API call failed silently
  const hasTotals = Object.keys(totalValues).length > 0;
  const hasUnique = Object.keys(uniqueValues).length > 0;
  if (!hasTotals && hasUnique) {
    console.warn('Weekly engagement totals empty but unique has data — partial API failure');
  }

  // Helper: pick the most recent period's value from a date-keyed object
  function latestValue(obj: Record<string, number>): number {
    const dates = Object.keys(obj).sort();
    return dates.length > 0 ? obj[dates[dates.length - 1]] ?? 0 : 0;
  }
  function prevValue(obj: Record<string, number>): number {
    const dates = Object.keys(obj).sort();
    return dates.length > 1 ? obj[dates[dates.length - 2]] ?? 0 : 0;
  }

  function getWeeklyValues(eventName: string): WeeklyEngagement {
    const eventData = totalValues[eventName] || {};
    const uniqueData = uniqueValues[eventName] || {};

    return {
      thisWeek: latestValue(eventData),
      lastWeek: prevValue(eventData),
      thisWeekUsers: latestValue(uniqueData),
      lastWeekUsers: prevValue(uniqueData),
    };
  }

  return {
    asteroidsSmashed: getWeeklyValues('Asteroid Smashed'),
    raffleEntries: getWeeklyValues('Raffle Ticket Purchased'),
    rewardsClaimed: getWeeklyValues('Reward Claimed'),
  };
}

// Response shape from combined monthly_engagement endpoint
interface MonthlyEngagementResponse {
  totals: EventsResponse;
  unique: EventsResponse;
}

// Fetch monthly engagement events (asteroids, raffles, rewards)
async function fetchMonthlyEngagement(): Promise<{
  monthlyAsteroidsSmashed: MonthlyEngagement;
  monthlyRaffleEntries: MonthlyEngagement;
  monthlyRewardsClaimed: MonthlyEngagement;
}> {
  const response = await fetch(`${API_BASE}/api/mixpanel?type=monthly_engagement`);

  if (!response.ok) {
    throw new Error(`API error: ${response.status}`);
  }

  const data: MonthlyEngagementResponse = await response.json();
  const totalValues = data.totals?.data?.values || {};
  const uniqueValues = data.unique?.data?.values || {};

  const hasTotals = Object.keys(totalValues).length > 0;
  const hasUnique = Object.keys(uniqueValues).length > 0;
  if (!hasTotals && hasUnique) {
    console.warn('Monthly engagement totals empty but unique has data — partial API failure');
  }

  function latestVal(obj: Record<string, number>): number {
    const dates = Object.keys(obj).sort();
    return dates.length > 0 ? obj[dates[dates.length - 1]] ?? 0 : 0;
  }
  function prevVal(obj: Record<string, number>): number {
    const dates = Object.keys(obj).sort();
    return dates.length > 1 ? obj[dates[dates.length - 2]] ?? 0 : 0;
  }

  function getMonthlyValues(eventName: string): MonthlyEngagement {
    const eventData = totalValues[eventName] || {};
    const uniqueData = uniqueValues[eventName] || {};

    return {
      thisMonth: latestVal(eventData),
      lastMonth: prevVal(eventData),
      thisMonthUsers: latestVal(uniqueData),
      lastMonthUsers: prevVal(uniqueData),
    };
  }

  return {
    monthlyAsteroidsSmashed: getMonthlyValues('Asteroid Smashed'),
    monthlyRaffleEntries: getMonthlyValues('Raffle Ticket Purchased'),
    monthlyRewardsClaimed: getMonthlyValues('Reward Claimed'),
  };
}

function transformDAUData(data: DAUReportResponse): DailyMetric[] {
  const dauSeries = data.series?.['A. DAU'] || {};

  return Object.entries(dauSeries)
    .map(([dateStr, value]) => ({
      date: formatDate(dateStr),
      value,
    }))
    .sort((a, b) => {
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
}

function formatDate(isoStr: string): string {
  const date = new Date(isoStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

const DEFAULT_ENGAGEMENT: WeeklyEngagement = { thisWeek: 0, lastWeek: 0, thisWeekUsers: 0, lastWeekUsers: 0 };
const DEFAULT_MONTHLY_ENGAGEMENT: MonthlyEngagement = { thisMonth: 0, lastMonth: 0, thisMonthUsers: 0, lastMonthUsers: 0 };

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

        // Fetch fresh data — all calls have catch handlers so a single failure
        // doesn't prevent the rest of the dashboard from loading
        const [dauReport, wau, mau, engagement, monthlyEngagement] = await Promise.all([
          fetchDAUReport().catch((err) => { console.warn('DAU fetch failed, will retry next load:', err); return null; }),
          fetchWAU().catch((err) => { console.warn('WAU fetch failed, will retry next load:', err); return -1; }),
          fetchMAU().catch((err) => { console.warn('MAU fetch failed, will retry next load:', err); return -1; }),
          fetchWeeklyEngagement().catch(() => ({
            asteroidsSmashed: DEFAULT_ENGAGEMENT,
            raffleEntries: DEFAULT_ENGAGEMENT,
            rewardsClaimed: DEFAULT_ENGAGEMENT,
          })),
          fetchMonthlyEngagement().catch(() => ({
            monthlyAsteroidsSmashed: DEFAULT_MONTHLY_ENGAGEMENT,
            monthlyRaffleEntries: DEFAULT_MONTHLY_ENGAGEMENT,
            monthlyRewardsClaimed: DEFAULT_MONTHLY_ENGAGEMENT,
          })),
        ]);

        const dauFailed = !dauReport;
        const dauTrend = dauReport ? transformDAUData(dauReport) : [];
        const currentDAU = dauTrend.length > 0 ? dauTrend[dauTrend.length - 1].value : 0;
        const avgDAU = dauTrend.length > 0
          ? Math.round(dauTrend.reduce((sum, d) => sum + d.value, 0) / dauTrend.length)
          : 0;

        // If WAU or MAU failed (-1 sentinel), show 0 but skip caching
        // so next page load retries the fetch
        const wauFailed = wau < 0;
        const mauFailed = mau < 0;

        const metrics: MixpanelMetrics = {
          dauTrend,
          currentDAU,
          currentWAU: wauFailed ? 0 : wau,
          currentMAU: mauFailed ? 0 : mau,
          avgDAU,
          ...engagement,
          ...monthlyEngagement,
        };

        // Detect partial engagement failures: totals 0 but users > 0
        // means the 'general' Mixpanel sub-request failed silently
        const engagementTotalsOk =
          engagement.asteroidsSmashed.thisWeek > 0 ||
          engagement.asteroidsSmashed.thisWeekUsers === 0;

        // Only cache if all critical metrics succeeded — prevents
        // stale 0 values from being locked in for 24 hours
        if (!dauFailed && !wauFailed && !mauFailed && engagementTotalsOk) {
          setCachedData(metrics);
        } else {
          console.warn(`Skipping cache — partial failure: DAU=${dauFailed ? 'FAIL' : 'ok'} WAU=${wauFailed ? 'FAIL' : 'ok'} MAU=${mauFailed ? 'FAIL' : 'ok'}`);
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
