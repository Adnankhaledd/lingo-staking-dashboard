import { useState, useEffect } from 'react';

// Use API proxy to avoid CORS issues
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

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

export interface MixpanelMetrics {
  // DAU trend (daily)
  dauTrend: DailyMetric[];
  // Current values
  currentDAU: number;
  currentWAU: number;
  currentMAU: number;
  // Average DAU over period
  avgDAU: number;
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

function transformDAUData(data: DAUReportResponse): DailyMetric[] {
  const dauSeries = data.series?.['A. DAU'] || {};

  return Object.entries(dauSeries)
    .map(([dateStr, value]) => ({
      date: formatDate(dateStr),
      value,
    }))
    .sort((a, b) => {
      // Sort by original date string to maintain chronological order
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });
}

function formatDate(isoStr: string): string {
  const date = new Date(isoStr);
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function useMixpanelData() {
  const [data, setData] = useState<MixpanelMetrics | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchData() {
      try {
        setIsLoading(true);
        setError(null);

        // Fetch all data in parallel
        const [dauReport, wau, mau] = await Promise.all([
          fetchDAUReport(),
          fetchWAU(),
          fetchMAU(),
        ]);

        const dauTrend = transformDAUData(dauReport);

        // Get current DAU (most recent day)
        const currentDAU = dauTrend.length > 0 ? dauTrend[dauTrend.length - 1].value : 0;

        // Calculate average DAU
        const avgDAU = dauTrend.length > 0
          ? Math.round(dauTrend.reduce((sum, d) => sum + d.value, 0) / dauTrend.length)
          : 0;

        const metrics: MixpanelMetrics = {
          dauTrend,
          currentDAU,
          currentWAU: wau,
          currentMAU: mau,
          avgDAU,
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
