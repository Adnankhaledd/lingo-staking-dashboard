import { useState, useEffect } from 'react';

const MIXPANEL_API_SECRET = '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '3623820';
const REPORT_ID = '75454495';

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

// Fetch DAU from the saved report
async function fetchDAUReport(): Promise<DAUReportResponse> {
  const response = await fetch(
    `https://eu.mixpanel.com/api/2.0/insights?project_id=${PROJECT_ID}&bookmark_id=${REPORT_ID}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${btoa(MIXPANEL_API_SECRET + ':')}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Mixpanel API error: ${response.status}`);
  }

  return response.json();
}

// Fetch WAU (weekly unique users)
async function fetchWAU(): Promise<number> {
  const today = new Date();
  const lastWeek = new Date(today);
  lastWeek.setDate(lastWeek.getDate() - 7);

  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    event: JSON.stringify(['Wallet Connected']),
    type: 'unique',
    unit: 'week',
    from_date: lastWeek.toISOString().split('T')[0],
    to_date: today.toISOString().split('T')[0],
  });

  const response = await fetch(
    `https://eu.mixpanel.com/api/2.0/events?${params}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${btoa(MIXPANEL_API_SECRET + ':')}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Mixpanel API error: ${response.status}`);
  }

  const data: EventsResponse = await response.json();
  const values = Object.values(data.data.values['Wallet Connected'] || {});
  return values.reduce((sum, val) => sum + val, 0);
}

// Fetch MAU (monthly unique users)
async function fetchMAU(): Promise<number> {
  const today = new Date();
  const lastMonth = new Date(today);
  lastMonth.setDate(lastMonth.getDate() - 30);

  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    event: JSON.stringify(['Wallet Connected']),
    type: 'unique',
    unit: 'month',
    from_date: lastMonth.toISOString().split('T')[0],
    to_date: today.toISOString().split('T')[0],
  });

  const response = await fetch(
    `https://eu.mixpanel.com/api/2.0/events?${params}`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json',
        'Authorization': `Basic ${btoa(MIXPANEL_API_SECRET + ':')}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Mixpanel API error: ${response.status}`);
  }

  const data: EventsResponse = await response.json();
  const values = Object.values(data.data.values['Wallet Connected'] || {});
  return values.reduce((sum, val) => sum + val, 0);
}

function transformDAUData(data: DAUReportResponse): DailyMetric[] {
  const dauSeries = data.series['A. DAU'] || {};

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
