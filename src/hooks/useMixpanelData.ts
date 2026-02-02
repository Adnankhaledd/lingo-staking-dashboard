import { useState, useEffect } from 'react';

const MIXPANEL_API_SECRET = '010125f09fef119ad08d0eb062be12b6';
const PROJECT_ID = '3623820';

interface MixpanelEventData {
  series: string[];
  values: Record<string, Record<string, number>>;
}

interface MixpanelResponse {
  data: MixpanelEventData;
  legend_size: number;
  computed_at: string;
}

export interface MonthlyMetric {
  month: string;
  value: number;
}

export interface MixpanelMetrics {
  walletConnections: MonthlyMetric[];
  stakingDone: MonthlyMetric[];
  newRegistrations: MonthlyMetric[];
  claimsDone: MonthlyMetric[];
  stakingPageViews: MonthlyMetric[];
  buyLingo: MonthlyMetric[];
  totals: {
    walletConnections: number;
    stakingDone: number;
    newRegistrations: number;
    claimsDone: number;
    stakingPageViews: number;
    buyLingo: number;
  };
}

async function fetchMixpanelEvents(events: string[]): Promise<MixpanelResponse> {
  const params = new URLSearchParams({
    project_id: PROJECT_ID,
    event: JSON.stringify(events),
    type: 'unique',
    unit: 'month',
    from_date: '2024-01-01',
    to_date: '2025-12-31',
  });

  const response = await fetch(`https://eu.mixpanel.com/api/2.0/events?${params}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Basic ${btoa(MIXPANEL_API_SECRET + ':')}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Mixpanel API error: ${response.status}`);
  }

  return response.json();
}

function transformEventData(
  data: MixpanelEventData,
  eventName: string
): MonthlyMetric[] {
  const values = data.values[eventName] || {};

  // Get all months with data and sort them
  const months = Object.keys(values)
    .filter(month => values[month] > 0)
    .sort((a, b) => new Date(a).getTime() - new Date(b).getTime());

  return months.map(month => ({
    month: formatMonth(month),
    value: values[month],
  }));
}

function formatMonth(dateStr: string): string {
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
}

function calculateTotal(values: Record<string, number> | undefined): number {
  if (!values) return 0;
  return Object.values(values).reduce((sum, val) => sum + val, 0);
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

        // Fetch all events in parallel
        const [engagementData, activityData] = await Promise.all([
          fetchMixpanelEvents(['Wallet Connected', 'Staking Done', 'New Account Registered']),
          fetchMixpanelEvents(['Claim Done', 'Staking Page View', 'Buy LINGO']),
        ]);

        const metrics: MixpanelMetrics = {
          walletConnections: transformEventData(engagementData.data, 'Wallet Connected'),
          stakingDone: transformEventData(engagementData.data, 'Staking Done'),
          newRegistrations: transformEventData(engagementData.data, 'New Account Registered'),
          claimsDone: transformEventData(activityData.data, 'Claim Done'),
          stakingPageViews: transformEventData(activityData.data, 'Staking Page View'),
          buyLingo: transformEventData(activityData.data, 'Buy LINGO'),
          totals: {
            walletConnections: calculateTotal(engagementData.data.values['Wallet Connected']),
            stakingDone: calculateTotal(engagementData.data.values['Staking Done']),
            newRegistrations: calculateTotal(engagementData.data.values['New Account Registered']),
            claimsDone: calculateTotal(activityData.data.values['Claim Done']),
            stakingPageViews: calculateTotal(activityData.data.values['Staking Page View']),
            buyLingo: calculateTotal(activityData.data.values['Buy LINGO']),
          },
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
