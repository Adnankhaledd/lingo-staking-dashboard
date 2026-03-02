import type {
  TotalStakedRow,
  WeeklyStatsRow,
  WeeklyNewStakersRow,
  CohortRetentionRow,
  TradingFeesRow,
  APYClaimsRow,
  MonthlyStakingFlowRow,
  WeeklyStakesRow,
  LPFeesRow,
  MonthlyNewReturningRow,
  MonthlyLingoByLockRow,
  CommunityRewardsRow,
  BuyPressureRow,
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
  _weeklyNewStakers: WeeklyNewStakersRow[] | null,
  cohortRetention: CohortRetentionRow[] | null,
  weeklyStakes: WeeklyStakesRow[] | null
): KPIData[] {
  // Get latest total staked
  const latestStaked = totalStakedData?.slice(-1)[0];
  const previousStaked = totalStakedData?.slice(-2, -1)[0];

  // Get latest weekly stats
  const latestWeekStats = weeklyStats?.slice(-1)[0];
  const previousWeekStats = weeklyStats?.slice(-2, -1)[0];

  // Get total stake events this week vs last week (sort by date — Dune returns newest-first)
  const sortedWeeklyStakes = weeklyStakes ? [...weeklyStakes].sort((a, b) => a.week.localeCompare(b.week)) : null;
  const thisWeekStakes = sortedWeeklyStakes?.slice(-1)[0];
  const lastWeekStakes = sortedWeeklyStakes?.slice(-2, -1)[0];

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
      label: 'Stakes This Week',
      value: thisWeekStakes?.total_stake_events ?? 0,
      previousValue: lastWeekStakes?.total_stake_events,
      format: 'number',
      trend: thisWeekStakes && lastWeekStakes
        ? thisWeekStakes.total_stake_events > lastWeekStakes.total_stake_events ? 'up' : 'down'
        : 'neutral',
      trendValue: thisWeekStakes && lastWeekStakes && lastWeekStakes.total_stake_events > 0
        ? ((thisWeekStakes.total_stake_events - lastWeekStakes.total_stake_events) / lastWeekStakes.total_stake_events) * 100
        : 0,
    },
    {
      label: 'Stakers This Week',
      value: thisWeekStakes?.unique_wallets_staked ?? 0,
      previousValue: lastWeekStakes?.unique_wallets_staked,
      format: 'number',
      trend: thisWeekStakes && lastWeekStakes
        ? thisWeekStakes.unique_wallets_staked > lastWeekStakes.unique_wallets_staked ? 'up' : 'down'
        : 'neutral',
      trendValue: thisWeekStakes && lastWeekStakes && lastWeekStakes.unique_wallets_staked > 0
        ? ((thisWeekStakes.unique_wallets_staked - lastWeekStakes.unique_wallets_staked) / lastWeekStakes.unique_wallets_staked) * 100
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
 * Transform cohort retention data - grouped by month with weighted retention
 */
export interface MonthlyRetentionData {
  month: string;
  newStakers: number;
  stillStaking: number;
  retentionPct: number;
}

export function transformRetentionData(data: CohortRetentionRow[] | null): MonthlyRetentionData[] {
  if (!data) return [];

  // Group by month with weighted calculation
  const monthlyMap = new Map<string, {
    totalUsers: number;
    retainedUsers: number;
  }>();

  data.forEach(row => {
    const date = new Date(parseDuneDate(row.cohort_week));
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, {
        totalUsers: 0,
        retainedUsers: 0,
      });
    }

    const entry = monthlyMap.get(monthKey)!;
    const retainedPct = parseFloat(row.pct_retained);
    const retainedUsers = Math.round(row.cohort_size * retainedPct / 100);

    entry.totalUsers += row.cohort_size;
    entry.retainedUsers += retainedUsers;
  });

  // Convert to array with true weighted retention
  return Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, data]) => {
      const [year, month] = monthKey.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      const retentionPct = data.totalUsers > 0
        ? Math.round((data.retainedUsers / data.totalUsers) * 1000) / 10
        : 0;

      return {
        month: monthName,
        newStakers: data.totalUsers,
        stillStaking: data.retainedUsers,
        retentionPct,
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

/**
 * Transform APY claims data for chart
 */
export function transformAPYClaimsData(data: APYClaimsRow[] | null) {
  if (!data) return [];

  return data.map(row => {
    const date = new Date(parseDuneDate(row.month));
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    return {
      month: monthName,
      claims: row.num_transfers,
      lingo: row.lingo_out,
      usd: row.usd_value,
      avgClaim: row.avg_transfer_size,
    };
  });
}

/**
 * Get total APY claims stats
 */
export function getAPYClaimsTotals(data: APYClaimsRow[] | null) {
  if (!data || data.length === 0) {
    return { totalClaims: 0, totalLingo: 0, totalUsd: 0 };
  }

  return {
    totalClaims: data.reduce((sum, row) => sum + row.num_transfers, 0),
    totalLingo: data.reduce((sum, row) => sum + row.lingo_out, 0),
    totalUsd: data.reduce((sum, row) => sum + row.usd_value, 0),
  };
}

/**
 * Transform monthly staking flow data for chart
 */
export function transformMonthlyStakingFlowData(data: MonthlyStakingFlowRow[] | null) {
  if (!data) return [];

  return data.map(row => {
    const date = new Date(parseDuneDate(row.month));
    const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

    return {
      month: monthName,
      staked: Math.round(row.staked),
      unstaked: Math.round(row.unstaked),
      netFlow: Math.round(row.net_flow),
    };
  });
}

/**
 * Transform weekly stakes data for chart
 */
export function transformWeeklyStakesData(data: WeeklyStakesRow[] | null) {
  if (!data) return [];

  // Sort by week ascending and take recent weeks
  const sorted = [...data].sort((a, b) =>
    parseDuneDate(a.week).localeCompare(parseDuneDate(b.week))
  );

  return sorted.map(row => {
    const date = new Date(parseDuneDate(row.week));
    const weekLabel = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

    return {
      week: weekLabel,
      stakeEvents: row.total_stake_events,
      uniqueStakers: row.unique_wallets_staked,
    };
  });
}

/**
 * Aggregate weekly data into monthly new vs returning stakers
 * New = first-time stakers, Returning = old wallets staking again
 */
export function transformMonthlyNewStakersData(
  newStakersData: WeeklyNewStakersRow[] | null,
  weeklyStakesData: WeeklyStakesRow[] | null
) {
  if (!newStakersData) return [];

  // Build a map of unique wallets per week from WeeklyStakes
  const walletsMap = new Map<string, number>();
  if (weeklyStakesData) {
    weeklyStakesData.forEach(row => {
      walletsMap.set(parseDuneDate(row.week), row.unique_wallets_staked);
    });
  }

  const monthlyMap = new Map<string, { newStakers: number; returning: number }>();

  newStakersData.forEach(row => {
    const weekDate = parseDuneDate(row.week);
    const date = new Date(weekDate);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, { newStakers: 0, returning: 0 });
    }

    const entry = monthlyMap.get(monthKey)!;
    entry.newStakers += row.new_stakers;

    const totalWallets = walletsMap.get(weekDate);
    if (totalWallets !== undefined) {
      entry.returning += Math.max(0, totalWallets - row.new_stakers);
    }
  });

  return Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, data]) => {
      const [year, month] = monthKey.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      return {
        month: monthName,
        newStakers: data.newStakers,
        returning: data.returning,
        total: data.newStakers + data.returning,
      };
    });
}

/**
 * Transform combined trading fees + LP fees data for monthly chart
 */
export function transformCombinedFeesData(
  tradingFees: TradingFeesRow[] | null,
  lpFees: LPFeesRow[] | null
) {
  // Create a map of all months
  const monthlyMap = new Map<string, { tradingFees: number; lpFees: number }>();

  // Add trading fees
  if (tradingFees) {
    tradingFees.forEach(row => {
      const date = new Date(parseDuneDate(row.month));
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, { tradingFees: 0, lpFees: 0 });
      }
      monthlyMap.get(monthKey)!.tradingFees = row.usd_value;
    });
  }

  // Add LP fees
  if (lpFees) {
    lpFees.forEach(row => {
      const date = new Date(parseDuneDate(row.month));
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

      if (!monthlyMap.has(monthKey)) {
        monthlyMap.set(monthKey, { tradingFees: 0, lpFees: 0 });
      }
      monthlyMap.get(monthKey)!.lpFees = row.fees_usd;
    });
  }

  // Convert to array sorted by month
  return Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, data]) => {
      const [year, month] = monthKey.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      return {
        month: monthName,
        tradingFees: Math.round(data.tradingFees * 100) / 100,
        lpFees: Math.round(data.lpFees * 100) / 100,
        totalFees: Math.round((data.tradingFees + data.lpFees) * 100) / 100,
      };
    });
}

/**
 * Transform combined cumulative fees data
 */
export function transformCombinedCumulativeFeesData(
  tradingFees: TradingFeesRow[] | null,
  lpFees: LPFeesRow[] | null
) {
  const combinedData = transformCombinedFeesData(tradingFees, lpFees);

  let cumulativeTrading = 0;
  let cumulativeLP = 0;

  return combinedData.map(row => {
    cumulativeTrading += row.tradingFees;
    cumulativeLP += row.lpFees;

    return {
      month: row.month,
      cumulativeTrading: Math.round(cumulativeTrading * 100) / 100,
      cumulativeLP: Math.round(cumulativeLP * 100) / 100,
      cumulative: Math.round((cumulativeTrading + cumulativeLP) * 100) / 100,
    };
  });
}

/**
 * Get total combined fees
 */
export function getTotalCombinedFees(
  tradingFees: TradingFeesRow[] | null,
  lpFees: LPFeesRow[] | null
): { tradingTotal: number; lpTotal: number; grandTotal: number } {
  const tradingTotal = tradingFees
    ? tradingFees.reduce((sum, row) => sum + row.usd_value, 0)
    : 0;

  const lpTotal = lpFees
    ? lpFees.reduce((sum, row) => sum + row.fees_usd, 0)
    : 0;

  return {
    tradingTotal: Math.round(tradingTotal * 100) / 100,
    lpTotal: Math.round(lpTotal * 100) / 100,
    grandTotal: Math.round((tradingTotal + lpTotal) * 100) / 100,
  };
}

/**
 * Transform monthly new vs returning wallets data from Dune query 6738028
 */
export function transformMonthlyNewReturningData(data: MonthlyNewReturningRow[] | null) {
  if (!data || data.length === 0) return [];

  return [...data]
    .sort((a, b) => a.stake_month.localeCompare(b.stake_month))
    .map(row => {
      const dateStr = parseDuneDate(row.stake_month);
      const [year, month] = dateStr.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      return {
        month: monthName,
        newWallets: row.new_wallets,
        returningWallets: row.returning_wallets,
        newLingo: Math.round(row.new_lingo_staked),
        returningLingo: Math.round(row.returning_lingo_staked),
        totalLingo: Math.round(row.total_lingo_staked),
        totalWallets: row.new_wallets + row.returning_wallets,
      };
    });
}

/**
 * Transform monthly LINGO staked by lock duration from Dune query 6749292
 */
export function transformMonthlyLingoByLockData(data: MonthlyLingoByLockRow[] | null) {
  if (!data || data.length === 0) return [];

  return [...data]
    .sort((a, b) => a.month.localeCompare(b.month))
    .map(row => {
      const dateStr = parseDuneDate(row.month);
      const [year, month] = dateStr.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      return {
        month: monthName,
        flexible: Math.round(row.flexible),
        threeMonth: Math.round(row['3mo']),
        sixMonth: Math.round(row['6mo']),
        twelveMonth: Math.round(row['12mo']),
        total: Math.round(row.total),
      };
    });
}

/**
 * Transform weekly community rewards data into monthly breakdown (Dune query 6749507)
 */
export function transformCommunityRewardsData(data: CommunityRewardsRow[] | null) {
  if (!data || data.length === 0) return [];

  // Aggregate weekly data into monthly buckets
  const monthlyMap = new Map<string, { transfers: number; lingoOut: number; usdValue: number }>();

  data.forEach(row => {
    const dateStr = parseDuneDate(row.week);
    const date = new Date(dateStr);
    const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

    if (!monthlyMap.has(monthKey)) {
      monthlyMap.set(monthKey, { transfers: 0, lingoOut: 0, usdValue: 0 });
    }

    const entry = monthlyMap.get(monthKey)!;
    entry.transfers += row.transfers;
    entry.lingoOut += row.lingo_out;
    entry.usdValue += row.usd_value;
  });

  return Array.from(monthlyMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, data]) => {
      const [year, month] = monthKey.split('-');
      const date = new Date(parseInt(year), parseInt(month) - 1);
      const monthName = date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });

      return {
        month: monthName,
        transfers: data.transfers,
        lingoOut: Math.round(data.lingoOut),
        usdValue: Math.round(data.usdValue * 100) / 100,
      };
    });
}

/**
 * Get total community rewards stats
 */
export function getCommunityRewardsTotals(data: CommunityRewardsRow[] | null) {
  if (!data || data.length === 0) {
    return { totalTransfers: 0, totalLingo: 0, totalUsd: 0 };
  }

  return {
    totalTransfers: data.reduce((sum, row) => sum + row.transfers, 0),
    totalLingo: data.reduce((sum, row) => sum + row.lingo_out, 0),
    totalUsd: data.reduce((sum, row) => sum + row.usd_value, 0),
  };
}

/**
 * Transform buy pressure data — sorts chronologically
 */
export function transformBuyPressureData(data: BuyPressureRow[] | null) {
  if (!data || data.length === 0) return [];
  return [...data]
    .sort((a, b) => parseDuneDate(a.week).localeCompare(parseDuneDate(b.week)))
    .map(row => ({
      week: parseDuneDate(row.week),
      buyVolume: Math.round(row.buy_volume_usd),
      sellVolume: Math.round(row.sell_volume_usd),
      netBuyPressure: Math.round(row.net_buy_pressure),
      trades: row.trades,
      totalVolume: Math.round(row.total_volume_usd),
    }));
}
