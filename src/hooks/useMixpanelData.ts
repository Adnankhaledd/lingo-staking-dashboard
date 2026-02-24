import { useState, useEffect } from 'react';

// Use API proxy to avoid CORS issues
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';
const CACHE_KEY = 'mixpanel_data_cache_v2';
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

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
  const values = Object.values(data.data?.values?.['Wallet Connected'] || {});
  return values.reduce((sum, val) => sum + val, 0);
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

  const data: EventsResponse = await response.json();
  const values = data.data?.values || {};

  // Parse this week and last week from the weekly data
  // Mixpanel returns { "event_name": { "2026-02-17": count, "2026-02-10": count } }
  function getWeeklyValues(eventName: string): WeeklyEngagement {
    const eventData = values[eventName] || {};
    const dates = Object.keys(eventData).sort();
    // Most recent week is last, previous week is second to last
    const thisWeek = dates.length > 0 ? eventData[dates[dates.length - 1]] ?? 0 : 0;
    const lastWeek = dates.length > 1 ? eventData[dates[dates.length - 2]] ?? 0 : 0;
    return { thisWeek, lastWeek };
  }

  return {
    asteroidsSmashed: getWeeklyValues('Asteroid Smashed'),
    raffleEntries: getWeeklyValues('Raffle Ticket Purchased'),
    rewardsClaimed: getWeeklyValues('Reward Claimed'),
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

const DEFAULT_ENGAGEMENT: WeeklyEngagement = { thisWeek: 0, lastWeek: 0 };

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

        // Fetch fresh data
        const [dauReport, wau, mau, engagement] = await Promise.all([
          fetchDAUReport(),
          fetchWAU(),
          fetchMAU(),
          fetchWeeklyEngagement().catch(() => ({
            asteroidsSmashed: DEFAULT_ENGAGEMENT,
            raffleEntries: DEFAULT_ENGAGEMENT,
            rewardsClaimed: DEFAULT_ENGAGEMENT,
          })),
        ]);

        const dauTrend = transformDAUData(dauReport);
        const currentDAU = dauTrend.length > 0 ? dauTrend[dauTrend.length - 1].value : 0;
        const avgDAU = dauTrend.length > 0
          ? Math.round(dauTrend.reduce((sum, d) => sum + d.value, 0) / dauTrend.length)
          : 0;

        const metrics: MixpanelMetrics = {
          dauTrend,
          currentDAU,
          currentWAU: wau,
          currentMAU: mau,
          avgDAU,
          ...engagement,
        };

        // Save to cache
        setCachedData(metrics);
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
