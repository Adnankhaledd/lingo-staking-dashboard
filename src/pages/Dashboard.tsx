import { useMemo } from 'react';
import { Users, Calendar, CalendarDays, CalendarRange, Rocket, Ticket, CheckCircle } from 'lucide-react';
import { Header } from '../components/layout';
import { KPICard, KPICardSkeleton, ChartCard, TopStakersTable, TotalFeesCard, StakingUpdateCard } from '../components/cards';
import { DecubateAPYClaimersTable } from '../components/cards/DecubateAPYClaimersTable';
import { StakeBreakdownTable } from '../components/cards/StakeBreakdownTable';
import { StakerLTVTable } from '../components/cards/StakerLTVTable';
import { StakerConcentrationCard } from '../components/cards/StakerConcentrationCard';
import { MixpanelKPICard } from '../components/cards/MixpanelKPICard';
import { AreaChartComponent, BarChartComponent, SimpleBarChart, RetentionTable, StakingTiersByLockTable } from '../components/charts';
import { BuyPressureChart } from '../components/charts/BuyPressureChart';
import { StakingFlowChart } from '../components/charts/StakingFlowChart';
import { StakerTiersChart } from '../components/charts/StakerTiersChart';
import { LockDistributionChart } from '../components/charts/LockDistributionChart';
import { WeeklyLockChart } from '../components/charts/WeeklyLockChart';
import { StakeDailyChart } from '../components/charts/StakeDailyChart';
import { MixpanelChart } from '../components/charts/MixpanelChart';
import { LiveActivityFeed } from '../components/LiveActivityFeed';
import { useLiveTotalStaked } from '../hooks/useLiveTotalStaked';
import { formatNumber, formatWeekDate, formatCurrency, exportToCSV } from '../utils/formatters';
import {
  useDuneQuery,
  DUNE_QUERIES,
  type TotalStakedRow,
  type WeeklyStatsRow,
  type WeeklyNewStakersRow,
  type CohortRetentionRow,
  type TopStakerRow,
  type TradingFeesRow,
  type APYClaimsRow,
  type MonthlyStakingFlowRow,
  type WeeklyStakesRow,
  type LPFeesRow,
  type MonthlyNewReturningRow,
  type StakingTiersByLockRow,
  type MonthlyLingoByLockRow,
  type CommunityRewardsRow,
  type BuyPressureRow,
  type StakerTiersWeeklyRow,
  type LockDistributionRow,
  type WeeklyLockBreakdownRow,
  type DecubateAPYClaimerRow,
  type StakeDailyBreakdownRow,
  type StakerLTVRow,
} from '../hooks/useDuneQuery';
import { useMixpanelData } from '../hooks/useMixpanelData';
import {
  calculateKPIs,
  transformStakingTrendData,
  transformNewStakersData,
  transformRetentionData,
  calculateMonthlyComparison,
  transformCombinedFeesData,
  transformCombinedCumulativeFeesData,
  getTotalCombinedFees,
  transformAPYClaimsData,
  getAPYClaimsTotals,
  transformStakingFlowData,
  transformMonthlyNewReturningData,
  transformMonthlyLingoByLockData,
  transformCommunityRewardsData,
  getCommunityRewardsTotals,
  transformBuyPressureData,
  transformStakerTiersData,
} from '../utils/dataTransformers';
import lingoLogo from '../assets/logo-lingo.svg';

export function Dashboard() {
  // Fetch data from Dune Analytics
  const {
    data: totalStakedData,
    isLoading: loadingTotalStaked,
    executedAt: totalStakedExecutedAt,
  } = useDuneQuery<TotalStakedRow>(DUNE_QUERIES.TOTAL_STAKED_TREND);

  const {
    data: weeklyStats,
    isLoading: loadingWeeklyStats,
  } = useDuneQuery<WeeklyStatsRow>(DUNE_QUERIES.WEEKLY_STATS);

  const {
    data: weeklyNewStakers,
    isLoading: loadingNewStakers,
    executedAt: newStakersExecutedAt,
  } = useDuneQuery<WeeklyNewStakersRow>(DUNE_QUERIES.WEEKLY_NEW_STAKERS);

  const {
    data: cohortRetention,
    isLoading: loadingRetention,
    executedAt: retentionExecutedAt,
  } = useDuneQuery<CohortRetentionRow>(DUNE_QUERIES.COHORT_RETENTION);

  const {
    data: topStakers,
    isLoading: loadingTopStakers,
  } = useDuneQuery<TopStakerRow>(DUNE_QUERIES.TOP_STAKERS, { limit: 300 });

  const {
    data: tradingFees,
    isLoading: loadingFees,
    executedAt: tradingFeesExecutedAt,
  } = useDuneQuery<TradingFeesRow>(DUNE_QUERIES.TRADING_FEES);

  const {
    data: apyClaims,
    isLoading: loadingAPYClaims,
    executedAt: apyClaimsExecutedAt,
  } = useDuneQuery<APYClaimsRow>(DUNE_QUERIES.APY_CLAIMS);

  const {
    data: decubateAPYClaimers,
    isLoading: loadingDecubateAPYClaimers,
  } = useDuneQuery<DecubateAPYClaimerRow>(DUNE_QUERIES.DECUBATE_APY_CLAIMERS);

  const {
    data: stakeBreakdown,
    isLoading: loadingStakeBreakdown,
    executedAt: stakeBreakdownExecutedAt,
  } = useDuneQuery<StakeDailyBreakdownRow>(DUNE_QUERIES.STAKE_DAILY_BREAKDOWN);

  const {
    data: stakerLTV,
    isLoading: loadingStakerLTV,
  } = useDuneQuery<StakerLTVRow>(DUNE_QUERIES.STAKER_LTV);

  const {
    data: monthlyStakingFlow,
    isLoading: loadingStakingFlow,
    executedAt: stakingFlowExecutedAt,
  } = useDuneQuery<MonthlyStakingFlowRow>(DUNE_QUERIES.MONTHLY_STAKING_FLOW);

  const {
    data: weeklyStakes,
  } = useDuneQuery<WeeklyStakesRow>(DUNE_QUERIES.WEEKLY_STAKES);

  const {
    data: lpFees,
    isLoading: loadingLPFees,
    executedAt: lpFeesExecutedAt,
  } = useDuneQuery<LPFeesRow>(DUNE_QUERIES.LP_FEES);

  const {
    data: monthlyNewReturning,
    isLoading: loadingMonthlyNewReturning,
    executedAt: monthlyNewReturningExecutedAt,
  } = useDuneQuery<MonthlyNewReturningRow>(DUNE_QUERIES.MONTHLY_NEW_RETURNING);

  const {
    data: stakingTiersByLock,
    isLoading: loadingStakingTiers,
    executedAt: stakingTiersExecutedAt,
  } = useDuneQuery<StakingTiersByLockRow>(DUNE_QUERIES.STAKING_TIERS_BY_LOCK);

  const {
    data: monthlyLingoByLock,
    isLoading: loadingLingoByLock,
    executedAt: lingoByLockExecutedAt,
  } = useDuneQuery<MonthlyLingoByLockRow>(DUNE_QUERIES.MONTHLY_LINGO_BY_LOCK);

  const {
    data: communityRewards,
    isLoading: loadingCommunityRewards,
    executedAt: communityRewardsExecutedAt,
  } = useDuneQuery<CommunityRewardsRow>(DUNE_QUERIES.COMMUNITY_REWARDS);

  const {
    data: buyPressureData,
    isLoading: loadingBuyPressure,
    executedAt: buyPressureExecutedAt,
  } = useDuneQuery<BuyPressureRow>(DUNE_QUERIES.BUY_PRESSURE);

  const {
    data: stakerTiersWeekly,
    isLoading: loadingStakerTiers,
    executedAt: stakerTiersExecutedAt,
  } = useDuneQuery<StakerTiersWeeklyRow>(DUNE_QUERIES.STAKER_TIERS_WEEKLY);

  const {
    data: lockDistribution,
    isLoading: loadingLockDistribution,
    executedAt: lockDistributionExecutedAt,
  } = useDuneQuery<LockDistributionRow>(DUNE_QUERIES.LOCK_DISTRIBUTION);

  const {
    data: weeklyLockBreakdown,
    isLoading: loadingWeeklyLock,
    executedAt: weeklyLockExecutedAt,
  } = useDuneQuery<WeeklyLockBreakdownRow>(DUNE_QUERIES.WEEKLY_LOCK_BREAKDOWN);

  // Alchemy live total staked (polls every 5 min, 1 API call)
  const { totalStaked: liveTotalStaked } = useLiveTotalStaked();

  // Mixpanel data
  const {
    data: mixpanelData,
    isLoading: loadingMixpanel,
  } = useMixpanelData();

  // Combined loading state
  const isLoading = loadingTotalStaked || loadingWeeklyStats || loadingNewStakers || loadingRetention;

  // Last updated is when data was fetched (current time on load)
  const lastUpdated = useMemo(() => {
    if (!isLoading && totalStakedData) {
      return new Date();
    }
    return null;
  }, [isLoading, totalStakedData]);

  // Transform data for display
  const kpiData = useMemo(
    () => calculateKPIs(totalStakedData, weeklyStats, weeklyNewStakers, cohortRetention, weeklyStakes),
    [totalStakedData, weeklyStats, weeklyNewStakers, cohortRetention, weeklyStakes]
  );

  const stakingTrendData = useMemo(
    () => transformStakingTrendData(totalStakedData),
    [totalStakedData]
  );

  const newVsReturningData = useMemo(
    () => transformNewStakersData(weeklyNewStakers, weeklyStats),
    [weeklyNewStakers, weeklyStats]
  );

  const retentionData = useMemo(
    () => transformRetentionData(cohortRetention),
    [cohortRetention]
  );

  const monthlyData = useMemo(
    () => calculateMonthlyComparison(totalStakedData),
    [totalStakedData]
  );

  // Combined fees data (Trading + LP)
  const combinedFeesLoading = loadingFees || loadingLPFees;

  const monthlyFeesData = useMemo(
    () => transformCombinedFeesData(tradingFees, lpFees),
    [tradingFees, lpFees]
  );

  const cumulativeFeesData = useMemo(
    () => transformCombinedCumulativeFeesData(tradingFees, lpFees),
    [tradingFees, lpFees]
  );

  const totalFeesData = useMemo(
    () => getTotalCombinedFees(tradingFees, lpFees),
    [tradingFees, lpFees]
  );

  // Daily stake breakdown — transform Dune rows into the chart's row shape.
  // "new_wallet_count" uses total_new_wallets (distinct across durations) not
  // the per-lock sum, to avoid double-counting wallets that staked multiple locks.
  const stakeDailyChartData = useMemo(() => {
    if (!stakeBreakdown) return null;
    return stakeBreakdown
      .map(r => {
        const date = (r.day ?? '').split(/[T\s]/)[0];
        return {
          date,
          lock_3mo_amount: Math.round(r.three_mo_total ?? 0),
          lock_6mo_amount: Math.round(r.six_mo_total ?? 0),
          lock_12mo_amount: Math.round(r.twelve_mo_total ?? 0),
          lock_3mo_count: (r.three_mo_new_wallets ?? 0) + (r.three_mo_old_wallets ?? 0),
          lock_6mo_count: (r.six_mo_new_wallets ?? 0) + (r.six_mo_old_wallets ?? 0),
          lock_12mo_count: (r.twelve_mo_new_wallets ?? 0) + (r.twelve_mo_old_wallets ?? 0),
          new_wallet_amount: Math.round((r.three_mo_new ?? 0) + (r.six_mo_new ?? 0) + (r.twelve_mo_new ?? 0)),
          old_wallet_amount: Math.round((r.three_mo_old ?? 0) + (r.six_mo_old ?? 0) + (r.twelve_mo_old ?? 0)),
          new_wallet_count: r.total_new_wallets ?? 0,
          old_wallet_count: r.total_old_wallets ?? 0,
          total_amount: Math.round(r.daily_total ?? 0),
          total_events: (r.total_new_wallets ?? 0) + (r.total_old_wallets ?? 0),
        };
      })
      .sort((a, b) => a.date.localeCompare(b.date)); // oldest → newest for chart
  }, [stakeBreakdown]);

  // APY Claims data
  const apyClaimsData = useMemo(
    () => transformAPYClaimsData(apyClaims),
    [apyClaims]
  );

  const apyClaimsTotals = useMemo(
    () => getAPYClaimsTotals(apyClaims),
    [apyClaims]
  );

  // Weekly staking flow data
  const stakingFlowData = useMemo(
    () => transformStakingFlowData(monthlyStakingFlow),
    [monthlyStakingFlow]
  );

  // Monthly new vs returning wallets + LINGO volume (from Dune query)
  const monthlyNewReturningData = useMemo(
    () => transformMonthlyNewReturningData(monthlyNewReturning),
    [monthlyNewReturning]
  );

  // Monthly LINGO staked by lock duration
  const monthlyLingoByLockData = useMemo(
    () => transformMonthlyLingoByLockData(monthlyLingoByLock),
    [monthlyLingoByLock]
  );

  // Community rewards data (weekly → monthly aggregation)
  const communityRewardsData = useMemo(
    () => transformCommunityRewardsData(communityRewards),
    [communityRewards]
  );

  const communityRewardsTotals = useMemo(
    () => getCommunityRewardsTotals(communityRewards),
    [communityRewards]
  );

  const buyPressureChartData = useMemo(
    () => transformBuyPressureData(buyPressureData),
    [buyPressureData]
  );

  const stakerTiersChartData = useMemo(
    () => transformStakerTiersData(stakerTiersWeekly),
    [stakerTiersWeekly]
  );

  // Export handlers
  const handleExportTrend = () => {
    if (stakingTrendData.length > 0) {
      exportToCSV(stakingTrendData, 'lingo_staking_trend');
    }
  };

  const handleExportNewVsReturning = () => {
    if (newVsReturningData.length > 0) {
      exportToCSV(newVsReturningData, 'lingo_new_vs_returning');
    }
  };

  const handleExportMonthly = () => {
    if (monthlyData.length > 0) {
      exportToCSV(monthlyData, 'lingo_monthly_comparison');
    }
  };

  const handleExportFees = () => {
    if (monthlyFeesData.length > 0) {
      exportToCSV(monthlyFeesData, 'lingo_monthly_fees');
    }
  };

  const handleExportCumulativeFees = () => {
    if (cumulativeFeesData.length > 0) {
      exportToCSV(cumulativeFeesData, 'lingo_cumulative_fees');
    }
  };

  return (
    <div className="min-h-screen bg-background">
      {/* Background gradient effects — flagship style */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple/6 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-sosiska/5 rounded-full blur-[150px]" />
        <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] bg-light1/4 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <Header lastUpdated={lastUpdated} />

      {/* Main Content */}
      <main className="relative w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
        {/* ═══════════════════════════════════════════════════════════════
            HERO + OVERVIEW
        ═══════════════════════════════════════════════════════════════ */}

        {/* Total Fees Hero Card */}
        <section className="mb-10">
          <TotalFeesCard totalFees={totalFeesData} isLoading={combinedFeesLoading} />
        </section>

        {/* KPI Cards */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Overview
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 stagger-children">
            {isLoading
              ? [...Array(5)].map((_, i) => <KPICardSkeleton key={i} />)
              : kpiData.map((kpi, index) => (
                  <KPICard key={kpi.label} data={kpi} index={index} />
                ))}
          </div>
        </section>

        {/* Staking Update — period comparison card */}
        <section className="mb-10">
          <StakingUpdateCard data={totalStakedData} isLoading={loadingTotalStaked} />
        </section>

        {/* Live Activity Feed (Alchemy) — hidden if not configured */}
        <section className="mb-10">
          <LiveActivityFeed />
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            REVENUE & FEES
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Revenue & Fees
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Monthly Fees Breakdown */}
            <ChartCard
              title="Monthly Fees Breakdown"
              subtitle="Trading fees + Liquidity pool fees per month"
              onExport={handleExportFees}
              isLoading={combinedFeesLoading}
              lastUpdated={tradingFeesExecutedAt || lpFeesExecutedAt}
            >
              {monthlyFeesData.length > 0 ? (
                <BarChartComponent
                  data={monthlyFeesData}
                  xAxisKey="month"
                  bars={[
                    {
                      dataKey: 'tradingFees',
                      name: 'Trading Fees',
                      color: '#7B68AE',
                    },
                    {
                      dataKey: 'lpFees',
                      name: 'LP Fees',
                      color: '#C4B5D4',
                    },
                    {
                      dataKey: 'totalFees',
                      name: 'Total',
                      color: '#5EB851',
                    },
                  ]}
                  height={280}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-soft-gray">
                  {combinedFeesLoading ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            {/* Cumulative Fees */}
            <ChartCard
              title="Cumulative Fees"
              subtitle="Total accumulated fees over time"
              onExport={handleExportCumulativeFees}
              isLoading={combinedFeesLoading}
              lastUpdated={tradingFeesExecutedAt || lpFeesExecutedAt}
            >
              {cumulativeFeesData.length > 0 ? (
                <AreaChartComponent
                  data={cumulativeFeesData}
                  dataKey="cumulative"
                  xAxisKey="month"
                  color="#7B68AE"
                  gradientId="cumulativeFeesGradient"
                  height={280}
                  formatValue={(value) => formatCurrency(value)}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-soft-gray">
                  {combinedFeesLoading ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            TRADING VOLUME & BUY PRESSURE
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Trading Volume & Buy Pressure
          </h2>
          <BuyPressureChart
            data={buyPressureChartData}
            isLoading={loadingBuyPressure}
            lastUpdated={buyPressureExecutedAt}
          />
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            ACTIVE USERS & ENGAGEMENT (Mixpanel)
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Active Users
          </h2>

          {/* DAU / WAU / MAU KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
            <MixpanelKPICard
              title="Daily Active Users"
              value={mixpanelData?.currentDAU ?? 0}
              icon={Calendar}
              color="#C4B5D4"
              isLoading={loadingMixpanel}
            />
            <MixpanelKPICard
              title="Avg. DAU (30d)"
              value={mixpanelData?.avgDAU ?? 0}
              icon={Users}
              color="#7B68AE"
              isLoading={loadingMixpanel}
            />
            <MixpanelKPICard
              title="Weekly Active Users"
              value={mixpanelData?.currentWAU ?? 0}
              icon={CalendarDays}
              color="#5EB851"
              isLoading={loadingMixpanel}
            />
            <MixpanelKPICard
              title="Monthly Active Users"
              value={mixpanelData?.currentMAU ?? 0}
              icon={CalendarRange}
              color="#FF7847"
              isLoading={loadingMixpanel}
            />
          </div>

          {/* DAU & WAU Trend Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <MixpanelChart
              title="Daily Active Users Trend"
              subtitle="Unique active users per day (last 30 days)"
              data={mixpanelData?.dauTrend ?? []}
              color="#C4B5D4"
              isLoading={loadingMixpanel}
            />
            <MixpanelChart
              title="Weekly Active Users Trend"
              subtitle="Unique active users per week (last 8 weeks)"
              data={mixpanelData?.wauTrend ?? []}
              color="#5EB851"
              isLoading={loadingMixpanel}
            />
          </div>

          {/* Weekly Engagement Cards */}
          <h3 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mt-8 mb-5">
            Weekly Engagement
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MixpanelKPICard
              title="Asteroids Smashed"
              value={mixpanelData?.asteroidsSmashed?.thisWeek ?? 0}
              icon={Rocket}
              color="#FF7847"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.asteroidsSmashed?.thisWeekUsers}
              changePercent={mixpanelData?.asteroidsSmashed?.lastWeek
                ? ((mixpanelData.asteroidsSmashed.thisWeek - mixpanelData.asteroidsSmashed.lastWeek) / mixpanelData.asteroidsSmashed.lastWeek) * 100
                : null}
            />
            <MixpanelKPICard
              title="Raffle Entries"
              value={mixpanelData?.raffleEntries?.thisWeek ?? 0}
              icon={Ticket}
              color="#C4B5D4"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.raffleEntries?.thisWeekUsers}
              changePercent={mixpanelData?.raffleEntries?.lastWeek
                ? ((mixpanelData.raffleEntries.thisWeek - mixpanelData.raffleEntries.lastWeek) / mixpanelData.raffleEntries.lastWeek) * 100
                : null}
            />
            <MixpanelKPICard
              title="Tasks Completed"
              value={mixpanelData?.tasksCompleted?.thisWeek ?? 0}
              icon={CheckCircle}
              color="#5EB851"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.tasksCompleted?.thisWeekUsers}
              changePercent={mixpanelData?.tasksCompleted?.lastWeek
                ? ((mixpanelData.tasksCompleted.thisWeek - mixpanelData.tasksCompleted.lastWeek) / mixpanelData.tasksCompleted.lastWeek) * 100
                : null}
            />
          </div>

          {/* Monthly Engagement Cards */}
          <h3 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mt-8 mb-5">
            Monthly Engagement
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <MixpanelKPICard
              title="Asteroids Smashed"
              value={mixpanelData?.monthlyAsteroidsSmashed?.thisMonth ?? 0}
              icon={Rocket}
              color="#FF7847"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.monthlyAsteroidsSmashed?.thisMonthUsers}
              changePercent={mixpanelData?.monthlyAsteroidsSmashed?.lastMonth
                ? ((mixpanelData.monthlyAsteroidsSmashed.thisMonth - mixpanelData.monthlyAsteroidsSmashed.lastMonth) / mixpanelData.monthlyAsteroidsSmashed.lastMonth) * 100
                : null}
            />
            <MixpanelKPICard
              title="Raffle Entries"
              value={mixpanelData?.monthlyRaffleEntries?.thisMonth ?? 0}
              icon={Ticket}
              color="#C4B5D4"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.monthlyRaffleEntries?.thisMonthUsers}
              changePercent={mixpanelData?.monthlyRaffleEntries?.lastMonth
                ? ((mixpanelData.monthlyRaffleEntries.thisMonth - mixpanelData.monthlyRaffleEntries.lastMonth) / mixpanelData.monthlyRaffleEntries.lastMonth) * 100
                : null}
            />
            <MixpanelKPICard
              title="Tasks Completed"
              value={mixpanelData?.monthlyTasksCompleted?.thisMonth ?? 0}
              icon={CheckCircle}
              color="#5EB851"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.monthlyTasksCompleted?.thisMonthUsers}
              changePercent={mixpanelData?.monthlyTasksCompleted?.lastMonth
                ? ((mixpanelData.monthlyTasksCompleted.thisMonth - mixpanelData.monthlyTasksCompleted.lastMonth) / mixpanelData.monthlyTasksCompleted.lastMonth) * 100
                : null}
            />
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            STAKING VOLUME
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Staking Volume
          </h2>

          {/* Row 1: Total Staked + Monthly Growth */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <ChartCard
              title="Total LINGO Staked"
              subtitle="Cumulative staking volume over time"
              onExport={handleExportTrend}
              isLoading={loadingTotalStaked}
              lastUpdated={totalStakedExecutedAt}
            >
              {stakingTrendData.length > 0 ? (
                <>
                  {(() => {
                    const latest = totalStakedData?.[totalStakedData.length - 1];
                    const displayTotal = liveTotalStaked ?? Math.round(latest?.total_staked ?? 0);
                    // Find value ~30 days ago for month-over-month change
                    const thirtyDaysAgo = totalStakedData && totalStakedData.length > 30
                      ? totalStakedData[totalStakedData.length - 31]
                      : totalStakedData?.[0];
                    const monthPct = latest && thirtyDaysAgo && thirtyDaysAgo.total_staked > 0
                      ? ((latest.total_staked - thirtyDaysAgo.total_staked) / thirtyDaysAgo.total_staked) * 100
                      : null;
                    return (
                      <div className="flex flex-col items-center gap-1.5 mb-4">
                        <div className="flex items-center gap-2">
                          <span className="text-4xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent tracking-tight">
                            {displayTotal.toLocaleString()}
                          </span>
                          {liveTotalStaked !== null && (
                            <span className="text-[10px] font-medium text-green1 bg-green1/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider">Live</span>
                          )}
                        </div>
                        {monthPct !== null && (
                          <span className={`text-sm font-semibold px-2.5 py-0.5 rounded-full ${monthPct >= 0 ? 'text-green1 bg-green1/10' : 'text-red-400 bg-red-400/10'}`}>
                            {monthPct >= 0 ? '+' : ''}{monthPct.toFixed(1)}%
                            <span className="text-purple-gray font-normal ml-1">30d</span>
                          </span>
                        )}
                      </div>
                    );
                  })()}
                  <AreaChartComponent
                    data={stakingTrendData}
                    dataKey="volume"
                    xAxisKey="date"
                    color="#C4B5D4"
                    gradientId="stakingTrendGradient"
                    height={290}
                    formatValue={(value) => formatNumber(value) + ' LINGO'}
                  />
                </>
              ) : (
                <div className="h-[320px] flex items-center justify-center text-soft-gray">
                  {loadingTotalStaked ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Monthly Staking Growth"
              subtitle="Month-over-month total staked"
              onExport={handleExportMonthly}
              isLoading={loadingTotalStaked}
              lastUpdated={totalStakedExecutedAt}
            >
              {monthlyData.length > 0 ? (
                <SimpleBarChart
                  data={monthlyData}
                  dataKey="volume"
                  xAxisKey="month"
                  color="#5EB851"
                  height={320}
                />
              ) : (
                <div className="h-[320px] flex items-center justify-center text-soft-gray">
                  {loadingTotalStaked ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Row 2: Staking Flow */}
          <div className="mb-5">
            <StakingFlowChart data={stakingFlowData} isLoading={loadingStakingFlow} lastUpdated={stakingFlowExecutedAt} />
          </div>

          {/* Row 2.5: Staker Tiers Trend */}
          <div className="mb-5">
            <StakerTiersChart data={stakerTiersChartData} isLoading={loadingStakerTiers} lastUpdated={stakerTiersExecutedAt} />
          </div>

          {/* Row 3: Weekly Lock Duration Trend */}
          <div className="mb-5">
            <WeeklyLockChart data={weeklyLockBreakdown} isLoading={loadingWeeklyLock} lastUpdated={weeklyLockExecutedAt} />
          </div>

          {/* Row 3.5: Daily stake breakdown chart (Dune 7320190, 6 months) */}
          <div className="mb-5">
            <StakeDailyChart
              days={stakeDailyChartData}
              isLoading={loadingStakeBreakdown}
              lastUpdated={stakeBreakdownExecutedAt}
            />
          </div>

          {/* Row 3.6: Stake Breakdown Table (Dune, full history with D/W/M toggle) */}
          <div className="mb-5">
            <StakeBreakdownTable
              data={stakeBreakdown ?? []}
              isLoading={loadingStakeBreakdown}
            />
          </div>

          {/* Row 3.7: Staker LTV (Dune 7340503, per-wallet lifetime metrics) */}
          <div className="mb-5">
            <StakerLTVTable
              data={stakerLTV ?? []}
              isLoading={loadingStakerLTV}
            />
          </div>

          {/* Row 4: Lock Duration Breakdown (Monthly bar + Current donut) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <ChartCard
              title="Monthly LINGO Staked by Lock Duration"
              subtitle="New LINGO staked per month broken down by lock period"
              isLoading={loadingLingoByLock}
              lastUpdated={lingoByLockExecutedAt}
            >
              {monthlyLingoByLockData.length > 0 ? (
                <BarChartComponent
                  data={monthlyLingoByLockData}
                  xAxisKey="month"
                  bars={[
                    {
                      dataKey: 'threeMonth',
                      name: '3 Month',
                      color: '#7B68AE',
                    },
                    {
                      dataKey: 'sixMonth',
                      name: '6 Month',
                      color: '#5EB851',
                    },
                    {
                      dataKey: 'twelveMonth',
                      name: '12 Month',
                      color: '#D4A017',
                    },
                  ]}
                  height={320}
                />
              ) : (
                <div className="h-[320px] flex items-center justify-center text-soft-gray">
                  {loadingLingoByLock ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            <LockDistributionChart
              data={lockDistribution}
              isLoading={loadingLockDistribution}
              lastUpdated={lockDistributionExecutedAt}
            />
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            WALLET ANALYSIS
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Wallet Analysis
          </h2>

          {/* Row 1: Weekly New vs Returning + Monthly Wallets */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <ChartCard
              title="New vs Returning Stakers"
              subtitle="Weekly breakdown of staker types"
              onExport={handleExportNewVsReturning}
              isLoading={loadingNewStakers}
              lastUpdated={newStakersExecutedAt}
            >
              {newVsReturningData.length > 0 ? (
                <BarChartComponent
                  data={newVsReturningData}
                  xAxisKey="week"
                  formatXAxis={formatWeekDate}
                  bars={[
                    {
                      dataKey: 'returningStakers',
                      name: 'Returning',
                      color: '#7B68AE',
                      stackId: 'stakers',
                    },
                    {
                      dataKey: 'newStakers',
                      name: 'New',
                      color: '#C4B5D4',
                      stackId: 'stakers',
                    },
                  ]}
                  height={300}
                />
              ) : (
                <div className="h-[300px] flex items-center justify-center text-soft-gray">
                  {loadingNewStakers ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Monthly Wallets Breakdown"
              subtitle="New (first-time) vs Returning (old wallets staking again)"
              isLoading={loadingMonthlyNewReturning}
              lastUpdated={monthlyNewReturningExecutedAt}
            >
              {monthlyNewReturningData.length > 0 ? (
                <BarChartComponent
                  data={monthlyNewReturningData}
                  xAxisKey="month"
                  bars={[
                    {
                      dataKey: 'returningWallets',
                      name: 'Returning',
                      color: '#7B68AE',
                      stackId: 'wallets',
                    },
                    {
                      dataKey: 'newWallets',
                      name: 'New',
                      color: '#C4B5D4',
                      stackId: 'wallets',
                    },
                  ]}
                  height={300}
                />
              ) : (
                <div className="h-[300px] flex items-center justify-center text-soft-gray">
                  {loadingMonthlyNewReturning ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Row 2: LINGO by Wallet Type */}
          <ChartCard
            title="Monthly LINGO Staked by Wallet Type"
            subtitle="LINGO volume from new vs returning wallets"
            isLoading={loadingMonthlyNewReturning}
            lastUpdated={monthlyNewReturningExecutedAt}
          >
            {monthlyNewReturningData.length > 0 ? (
              <BarChartComponent
                data={monthlyNewReturningData}
                xAxisKey="month"
                bars={[
                  {
                    dataKey: 'returningLingo',
                    name: 'Returning',
                    color: '#7B68AE',
                    stackId: 'lingo',
                  },
                  {
                    dataKey: 'newLingo',
                    name: 'New',
                    color: '#C4B5D4',
                    stackId: 'lingo',
                  },
                ]}
                height={300}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-soft-gray">
                {loadingMonthlyNewReturning ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            REWARDS DISTRIBUTION
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Rewards Distribution
          </h2>

          {/* APY Contract Claims */}
          <h3 className="text-base font-medium text-lavender mb-4">APY Contract Claims</h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            <div className="flagship-card p-6">
              <div className="relative z-10">
                <span className="text-sm text-soft-gray">Total Claims</span>
                <div className="text-2xl font-bold text-lavender mt-1">
                  {loadingAPYClaims ? '...' : apyClaimsTotals.totalClaims.toLocaleString()}
                </div>
              </div>
            </div>
            <div className="flagship-card p-6">
              <div className="relative z-10">
                <span className="text-sm text-soft-gray">Total LINGO Claimed</span>
                <div className="text-2xl font-bold text-purple mt-1">
                  {loadingAPYClaims ? '...' : Math.round(apyClaimsTotals.totalLingo).toLocaleString()}
                </div>
              </div>
            </div>
            <div className="flagship-card p-6">
              <div className="relative z-10">
                <span className="text-sm text-soft-gray">Total USD Value</span>
                <div className="text-2xl font-bold text-green1 mt-1">
                  {loadingAPYClaims ? '...' : `$${Math.round(apyClaimsTotals.totalUsd).toLocaleString()}`}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
            <ChartCard
              title="Monthly Claims Count"
              subtitle="Number of APY reward claims per month"
              isLoading={loadingAPYClaims}
              lastUpdated={apyClaimsExecutedAt}
            >
              {apyClaimsData.length > 0 ? (
                <SimpleBarChart
                  data={apyClaimsData}
                  dataKey="claims"
                  xAxisKey="month"
                  color="#C4B5D4"
                  height={280}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-soft-gray">
                  {loadingAPYClaims ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Monthly LINGO Claimed"
              subtitle="Amount of LINGO claimed per month"
              isLoading={loadingAPYClaims}
              lastUpdated={apyClaimsExecutedAt}
            >
              {apyClaimsData.length > 0 ? (
                <SimpleBarChart
                  data={apyClaimsData}
                  dataKey="lingo"
                  xAxisKey="month"
                  color="#7B68AE"
                  height={280}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-soft-gray">
                  {loadingAPYClaims ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Decubate APY Claimers Table */}
          <div className="mb-8">
            <DecubateAPYClaimersTable
              data={decubateAPYClaimers ?? []}
              isLoading={loadingDecubateAPYClaimers}
            />
          </div>

          {/* Community Rewards */}
          <h3 className="text-base font-medium text-lavender mb-4">Community Rewards</h3>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            <div className="flagship-card p-6">
              <div className="relative z-10">
                <span className="text-sm text-soft-gray">Total Transfers</span>
                <div className="text-2xl font-bold text-lavender mt-1">
                  {loadingCommunityRewards ? '...' : communityRewardsTotals.totalTransfers.toLocaleString()}
                </div>
              </div>
            </div>
            <div className="flagship-card p-6">
              <div className="relative z-10">
                <span className="text-sm text-soft-gray">Total LINGO Sent</span>
                <div className="text-2xl font-bold text-purple mt-1">
                  {loadingCommunityRewards ? '...' : Math.round(communityRewardsTotals.totalLingo).toLocaleString()}
                </div>
              </div>
            </div>
            <div className="flagship-card p-6">
              <div className="relative z-10">
                <span className="text-sm text-soft-gray">Total USD Value</span>
                <div className="text-2xl font-bold text-green1 mt-1">
                  {loadingCommunityRewards ? '...' : `$${Math.round(communityRewardsTotals.totalUsd).toLocaleString()}`}
                </div>
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            <ChartCard
              title="Monthly Reward Transfers"
              subtitle="Number of reward transfers per month"
              isLoading={loadingCommunityRewards}
              lastUpdated={communityRewardsExecutedAt}
            >
              {communityRewardsData.length > 0 ? (
                <SimpleBarChart
                  data={communityRewardsData}
                  dataKey="transfers"
                  xAxisKey="month"
                  color="#FF7847"
                  height={280}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-soft-gray">
                  {loadingCommunityRewards ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Monthly USD Value"
              subtitle="USD value of community rewards per month"
              isLoading={loadingCommunityRewards}
              lastUpdated={communityRewardsExecutedAt}
            >
              {communityRewardsData.length > 0 ? (
                <SimpleBarChart
                  data={communityRewardsData}
                  dataKey="usdValue"
                  xAxisKey="month"
                  color="#5EB851"
                  height={280}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-soft-gray">
                  {loadingCommunityRewards ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            STAKER RETENTION
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Staker Retention
          </h2>

          {/* Retention KPI Cards */}
          {retentionData.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              {/* Recent Retention (last 3 months) */}
              <div className="flagship-card p-6">
                <div className="relative z-10">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-soft-gray">Recent Retention (3 months)</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-bold ${
                    (() => {
                      const recent = retentionData.slice(-3);
                      const totalNew = recent.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = recent.reduce((s, d) => s + d.stillStaking, 0);
                      const pct = totalNew > 0 ? (totalStill / totalNew) * 100 : 0;
                      return pct >= 85 ? 'text-green1' : pct >= 75 ? 'text-purple' : pct >= 65 ? 'text-amber-soft' : 'text-orange1';
                    })()
                  }`}>
                    {(() => {
                      const recent = retentionData.slice(-3);
                      const totalNew = recent.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = recent.reduce((s, d) => s + d.stillStaking, 0);
                      return totalNew > 0 ? ((totalStill / totalNew) * 100).toFixed(1) : '0';
                    })()}%
                  </span>
                  <span className="text-sm text-soft-gray">
                    {(() => {
                      const recent = retentionData.slice(-3);
                      return `${recent.reduce((s, d) => s + d.stillStaking, 0).toLocaleString()} / ${recent.reduce((s, d) => s + d.newStakers, 0).toLocaleString()} stakers`;
                    })()}
                  </span>
                </div>
                </div>
              </div>

              {/* All-time Retention */}
              <div className="flagship-card p-6">
                <div className="relative z-10">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-soft-gray">All-Time Retention</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-bold ${
                    (() => {
                      const totalNew = retentionData.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = retentionData.reduce((s, d) => s + d.stillStaking, 0);
                      const pct = totalNew > 0 ? (totalStill / totalNew) * 100 : 0;
                      return pct >= 85 ? 'text-green1' : pct >= 75 ? 'text-purple' : pct >= 65 ? 'text-amber-soft' : 'text-orange1';
                    })()
                  }`}>
                    {(() => {
                      const totalNew = retentionData.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = retentionData.reduce((s, d) => s + d.stillStaking, 0);
                      return totalNew > 0 ? ((totalStill / totalNew) * 100).toFixed(1) : '0';
                    })()}%
                  </span>
                  <span className="text-sm text-soft-gray">
                    {retentionData.reduce((s, d) => s + d.stillStaking, 0).toLocaleString()} / {retentionData.reduce((s, d) => s + d.newStakers, 0).toLocaleString()} stakers
                  </span>
                </div>
                </div>
              </div>
            </div>
          )}

          <ChartCard
            title="Monthly Cohort Breakdown"
            subtitle="Users who started staking each month and how many are still active"
            isLoading={loadingRetention}
            lastUpdated={retentionExecutedAt}
          >
            <RetentionTable data={retentionData} isLoading={loadingRetention} />
          </ChartCard>
        </section>

        {/* ═══════════════════════════════════════════════════════════════
            STAKING TIERS & TOP STAKERS
        ═══════════════════════════════════════════════════════════════ */}
        <section className="mb-10">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Staking Tiers
          </h2>
          <ChartCard
            title="Stakers by Tier & Lock Period"
            subtitle="Active stakers grouped by USD value threshold and lock duration"
            isLoading={loadingStakingTiers}
            lastUpdated={stakingTiersExecutedAt}
          >
            <StakingTiersByLockTable data={stakingTiersByLock} isLoading={loadingStakingTiers} />
          </ChartCard>
        </section>

        <section className="mb-10 space-y-5">
          <StakerConcentrationCard
            topStakers={topStakers}
            totalStakedAllWallets={liveTotalStaked}
            isLoading={loadingTopStakers}
          />
          <TopStakersTable
            data={topStakers ?? []}
            isLoading={loadingTopStakers}
          />
        </section>

        {/* Footer */}
        <footer className="text-center py-8 border-t border-white/5">
          <div className="flex items-center justify-center gap-2 mb-2">
            <img src={lingoLogo} alt="Lingo" className="h-5" />
            <span className="text-sm font-medium text-soft-gray">Staking Analytics</span>
          </div>
          <p className="text-xs text-purple-gray">
            Powered by Dune Analytics, Mixpanel & Alchemy
          </p>
        </footer>
      </main>
    </div>
  );
}
