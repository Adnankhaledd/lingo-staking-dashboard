import { useMemo } from 'react';
import { Users, Calendar, CalendarDays, CalendarRange, Rocket, Ticket, Trophy } from 'lucide-react';
import { Header } from '../components/layout';
import { KPICard, KPICardSkeleton, ChartCard, TopStakersTable, TotalFeesCard } from '../components/cards';
import { MixpanelKPICard } from '../components/cards/MixpanelKPICard';
import { AreaChartComponent, BarChartComponent, SimpleBarChart, RetentionTable, StakingTiersByLockTable } from '../components/charts';
import { MixpanelChart } from '../components/charts/MixpanelChart';
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
  transformMonthlyStakingFlowData,
  transformMonthlyNewReturningData,
  transformMonthlyLingoByLockData,
  transformCommunityRewardsData,
  getCommunityRewardsTotals,
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
  } = useDuneQuery<TopStakerRow>(DUNE_QUERIES.TOP_STAKERS, { limit: 50 });

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

  // APY Claims data
  const apyClaimsData = useMemo(
    () => transformAPYClaimsData(apyClaims),
    [apyClaims]
  );

  const apyClaimsTotals = useMemo(
    () => getAPYClaimsTotals(apyClaims),
    [apyClaims]
  );

  // Monthly staking flow data
  const stakingFlowData = useMemo(
    () => transformMonthlyStakingFlowData(monthlyStakingFlow),
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

          {/* DAU Trend Chart */}
          <MixpanelChart
            title="Daily Active Users Trend"
            subtitle="Unique active users per day (last 30 days)"
            data={mixpanelData?.dauTrend ?? []}
            color="#C4B5D4"
            isLoading={loadingMixpanel}
          />

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
            />
            <MixpanelKPICard
              title="Raffle Entries"
              value={mixpanelData?.raffleEntries?.thisWeek ?? 0}
              icon={Ticket}
              color="#C4B5D4"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.raffleEntries?.thisWeekUsers}
            />
            <MixpanelKPICard
              title="Rewards Claimed"
              value={mixpanelData?.rewardsClaimed?.thisWeek ?? 0}
              icon={Trophy}
              color="#5EB851"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.rewardsClaimed?.thisWeekUsers}
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
            />
            <MixpanelKPICard
              title="Raffle Entries"
              value={mixpanelData?.monthlyRaffleEntries?.thisMonth ?? 0}
              icon={Ticket}
              color="#C4B5D4"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.monthlyRaffleEntries?.thisMonthUsers}
            />
            <MixpanelKPICard
              title="Rewards Claimed"
              value={mixpanelData?.monthlyRewardsClaimed?.thisMonth ?? 0}
              icon={Trophy}
              color="#5EB851"
              isLoading={loadingMixpanel}
              userCount={mixpanelData?.monthlyRewardsClaimed?.thisMonthUsers}
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
                <AreaChartComponent
                  data={stakingTrendData}
                  dataKey="volume"
                  xAxisKey="date"
                  color="#C4B5D4"
                  gradientId="stakingTrendGradient"
                  height={320}
                  formatValue={(value) => formatNumber(value) + ' LINGO'}
                />
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

          {/* Row 2: Net Flow + Staked vs Unstaked */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <ChartCard
              title="Monthly Net Flow"
              subtitle="Net LINGO staked minus unstaked per month"
              isLoading={loadingStakingFlow}
              lastUpdated={stakingFlowExecutedAt}
            >
              {stakingFlowData.length > 0 ? (
                <SimpleBarChart
                  data={stakingFlowData}
                  dataKey="netFlow"
                  xAxisKey="month"
                  color="#5EB851"
                  height={300}
                />
              ) : (
                <div className="h-[300px] flex items-center justify-center text-soft-gray">
                  {loadingStakingFlow ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            <ChartCard
              title="Monthly Staked vs Unstaked"
              subtitle="LINGO staked (green) vs unstaked (red) per month"
              isLoading={loadingStakingFlow}
              lastUpdated={stakingFlowExecutedAt}
            >
              {stakingFlowData.length > 0 ? (
                <BarChartComponent
                  data={stakingFlowData}
                  xAxisKey="month"
                  bars={[
                    {
                      dataKey: 'staked',
                      name: 'Staked',
                      color: '#5EB851',
                    },
                    {
                      dataKey: 'unstaked',
                      name: 'Unstaked',
                      color: '#E5484D',
                    },
                  ]}
                  height={300}
                />
              ) : (
                <div className="h-[300px] flex items-center justify-center text-soft-gray">
                  {loadingStakingFlow ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>

          {/* Row 3: Lock Duration Breakdown */}
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

        <section className="mb-10">
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
            Powered by Dune Analytics & Mixpanel
          </p>
        </footer>
      </main>
    </div>
  );
}
