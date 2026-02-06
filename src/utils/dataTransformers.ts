import type {
  TotalStakedRow,
  WeeklyStatsRow,
  WeeklyNewStakersRow,
  CohortRetentionRow,
  TradingFeesRow,
} from '../hooks/useDuneQuery';
import type { KPIData } from '../types';

/**
 * Parse Dune date string to ISO format
 */
export function parseDuneDate(dateStr: string): string {
  // Dune returns dates like "2024-12-11 00:00:00.000 UTC"
  return dateStr.split(' ')[0];
}

/**
 * Calculate KPIs from the raw data
 */
export function calculateKPIs(
  totalStakedData: TotalStakedRow[] | null,
  weeklyStats: WeeklyStatsRow[] | null,
  weeklyNewStakers: WeeklyNewStakersRow[] | null,
  cohortRetention: CohortRetentionRow[] | null
): KPIData[] {
  // Get latest total staked
  const latestStaked = totalStakedData?.slice(-1)[0];
  const previousStaked = totalStakedData?.slice(-2, -1)[0];

  // Get latest weekly stats
  const latestWeekStats = weeklyStats?.slice(-1)[0];
  const previousWeekStats = weeklyStats?.slice(-2, -1)[0];

  // Get new stakers this week vs last week
  const thisWeekNewStakers = weeklyNewStakers?.slice(-1)[0];
  const lastWeekNewStakers = weeklyNewStakers?.slice(-2, -1)[0];

  // Calculate average retention rate from recent cohorts
  const recentCohorts = cohortRetention?.slice(-8) ?? [];
  const avgRetention = recentCohorts.length > 0
    ? recentCohorts.reduce((sum, c) => sum + parseFloat(c.pct_retained), 0) / recentCohorts.length
    : 0;
  const previousCohorts = cohortRetention?.slice(-16, -8) ?? [];
  const prevAvgRetention = previousCohorts.length > 0
    ? previousCohorts.reduce((sum, c) => sum + parseFloat(c.pct_retained), 0) / previousCohorts.length
    : avgRetention;

  return [
    {
      label: 'Total LINGO Staked',
      value: latestStaked?.total_staked ?? 0,
      previousValue: previousStaked?.total_staked,
      format: 'number',
      suffix: ' LINGO',
      trend: latestStaked && previousStaked
        ? latestStaked.total_staked > previousStaked.total_staked ? 'up' : 'down'
        : 'neutral',
      trendValue: latestStaked?.change_pct ?? 0,
    },
    {
      label: 'Active Stakers',
      value: latestWeekStats?.active_stakers ?? 0,
      previousValue: previousWeekStats?.active_stakers,
      format: 'number',
      trend: latestWeekStats && previousWeekStats
        ? latestWeekStats.active_stakers > previousWeekStats.active_stakers ? 'up' : 'down'
        : 'neutral',
      trendValue: latestWeekStats && previousWeekStats
        ? ((latestWeekStats.active_stakers - previousWeekStats.active_stakers) / previousWeekStats.active_stakers) * 100
        : 0,
    },
    {
      label: 'New This Week',
      value: thisWeekNewStakers?.new_stakers ?? 0,
      previousValue: lastWeekNewStakers?.new_stakers,
      format: 'number',
      trend: thisWeekNewStakers && lastWeekNewStakers
        ? thisWeekNewStakers.new_stakers > lastWeekNewStakers.new_stakers ? 'up' : 'down'
        : 'neutral',
      trendValue: thisWeekNewStakers && lastWeekNewStakers && lastWeekNewStakers.new_stakers > 0
        ? ((thisWeekNewStakers.new_stakers - lastWeekNewStakers.new_stakers) / lastWeekNewStakers.new_stakers) * 100
        : 0,
    },
    {
      label: 'Retention Rate',
      value: avgRetention,
      previousValue: prevAvgRetention,
      format: 'percent',
      trend: avgRetention > prevAvgRetention ? 'up' : avgRetention < prevAvgRetention ? 'down' : 'neutral',
      trendValue: prevAvgRetention > 0 ? ((avgRetention - prevAvgRetention) / prevAvgRetention) * 100 : 0,
    },
  ];
}

/**
 * Transform total staked data for the area chart
 */
export function transformStakingTrendData(data: TotalStakedRow[] | null) {
  if (!data) return [];

  return data.map(row => ({
    date: parseDuneDate(row.day),
    volume: row.total_staked,
    change: row.change_from_yesterday,
  }));
}

/**
 * Transform weekly stats for the TVL chart
 */
export function transformWeeklyTVLData(data: WeeklyStatsRow[] | null) {
  if (!data) return [];

  return data.map(row => ({
    week: parseDuneDate(row.week),
    tvl: row.total_tvl,
    stakers: row.active_stakers,
  }));
}

/**
 * Transform weekly new stakers data
 */
export function transformNewStakersData(
  weeklyNewStakers: WeeklyNewStakersRow[] | null,
  weeklyStats: WeeklyStatsRow[] | null
) {
  if (!weeklyNewStakers || !weeklyStats) return [];

  // Create a map of week to stats
  const statsMap = new Map(
    weeklyStats.map(s => [parseDuneDate(s.week), s])
  );

  return weeklyNewStakers.map(row => {
    const weekDate = parseDuneDate(row.week);
    const stats = statsMap.get(weekDate);
    const totalStakers = stats?.active_stakers ?? row.new_stakers;
    const returningStakers = Math.max(0, totalStakers - row.new_stakers);

    return {
      week: weekDate,
      newStakers: row.new_stakers,
      returningStakers: returningStakers,
    };
  });
}

/**
 * Transform cohort retention data - grouped by month
 */
export interface MonthlyRetentionData {
  month: string;
  cohortSize: number;
  retained: number;
  diamondHands: number;
  churned: number;
}

export function transformRetentionData(data: CohortRetentionRow[] | null): MonthlyRetentionData[] {
  if (!data) return [];

  // Group by month
  const monthlyMap = new Map<string, {
    cohortSize: number;
    retained: number[];
    diamondHands: number[];
    churned: number[];
  }>();

  data.forEach(row => {
    const date = new Date(parseDuneDate(row.cohort_week));
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, {
        cohortSize: 0,
        retained: [],
        diamondHands: [],
        churned: [],
      });
    }

    const entry = monthlyMap.get(monthKey)!;
    entry.cohortSize += row.cohort_size;
    entry.retained.push(parseFloat(row.pct_retained));
    entry.diamondHands.push(parseFloat(row.pct_diamond_hands));
    entry.churned.push(parseFloat(row.pct_churned));
  });

  // Convert to array and calculate averages
  return Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, data]) => {
      const [year, month] = monthKey.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      const avgRetained = data.retained.reduce((a, b) => a + b, 0) / data.retained.length;
      const avgDiamondHands = data.diamondHands.reduce((a, b) => a + b, 0) / data.diamondHands.length;
      const avgChurned = data.churned.reduce((a, b) => a + b, 0) / data.churned.length;

      return {
        month: monthName,
        cohortSize: data.cohortSize,
        retained: Math.round(avgRetained * 10) / 10,
        diamondHands: Math.round(avgDiamondHands * 10) / 10,
        churned: Math.round(avgChurned * 10) / 10,
      };
    });
}

/**
 * Calculate monthly comparison data from daily data
 */
export function calculateMonthlyComparison(data: TotalStakedRow[] | null) {
  if (!data || data.length === 0) return [];

  // Group by month
  const monthlyData = new Map<string, { total: number; count: number }>();

  data.forEach(row => {
    const date = new Date(parseDuneDate(row.day));
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyData.has(monthKey)) {
      monthlyData.set(monthKey, { total: 0, count: 0 });
    }

    const entry = monthlyData.get(monthKey)!;
    entry.total = row.total_staked; // Use the latest value for that month
    entry.count++;
  });

  // Convert to array and calculate growth
  const months = Array.from(monthlyData.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-6); // Last 6 months

  return months.map(([monthKey, data], index) => {
    const [year, month] = monthKey.split('-');
    const date = new Date(parseInt(year), parseInt(month) - 1);
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    const prevVolume = index > 0 ? months[index - 1][1].total : data.total;
    const growth = prevVolume > 0 ? ((data.total - prevVolume) / prevVolume) * 100 : 0;

    return {
      month: monthName,
      volume: data.total,
      growth: Math.round(growth * 10) / 10,
    };
  });
}

/**
 * Transform trading fees data for monthly fees chart
 */
export function transformMonthlyFeesData(data: TradingFeesRow[] | null) {
  if (!data) return [];

  return data.map(row => {
    const date = new Date(parseDuneDate(row.month));
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    return {
      month: monthName,
      fees: row.usd_value,
      lingo: row.total_lingo,
    };
  });
}

/**
 * Transform trading fees data for cumulative fees chart
 */
export function transformCumulativeFeesData(data: TradingFeesRow[] | null) {
  if (!data) return [];

  return data.map(row => {
    const date = new Date(parseDuneDate(row.month));
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    return {
      month: monthName,
      cumulative: row.cumulative_usd,
    };
  });
}

/**
 * Get total fees from the latest cumulative value
 */
export function getTotalFees(data: TradingFeesRow[] | null): number {
  if (!data || data.length === 0) return 0;
  return data[data.length - 1].cumulative_usd;
}
