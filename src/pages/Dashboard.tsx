import { useMemo } from 'react';
import { Users, Calendar, CalendarDays, CalendarRange } from 'lucide-react';
import { Header } from '../components/layout';
import { KPICard, KPICardSkeleton, ChartCard, TopStakersTable, TotalFeesCard } from '../components/cards';
import { MixpanelKPICard } from '../components/cards/MixpanelKPICard';
import { AreaChartComponent, BarChartComponent, SimpleBarChart, RetentionTable, MembershipTiersTable } from '../components/charts';
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
  type MembershipTiersRow,
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
  transformWeeklyStakesData,
  transformMonthlyNewStakersData,
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
    isLoading: loadingWeeklyStakes,
    executedAt: weeklyStakesExecutedAt,
  } = useDuneQuery<WeeklyStakesRow>(DUNE_QUERIES.WEEKLY_STAKES);

  const {
    data: lpFees,
    isLoading: loadingLPFees,
    executedAt: lpFeesExecutedAt,
  } = useDuneQuery<LPFeesRow>(DUNE_QUERIES.LP_FEES);

  const {
    data: membershipTiers,
    isLoading: loadingMembershipTiers,
    executedAt: membershipTiersExecutedAt,
  } = useDuneQuery<MembershipTiersRow>(DUNE_QUERIES.MEMBERSHIP_TIERS);

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
    () => calculateKPIs(totalStakedData, weeklyStats, weeklyNewStakers, cohortRetention),
    [totalStakedData, weeklyStats, weeklyNewStakers, cohortRetention]
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

  // Weekly stakes data
  const weeklyStakesData = useMemo(
    () => transformWeeklyStakesData(weeklyStakes),
    [weeklyStakes]
  );

  // Monthly new unique stakers (aggregated from weekly data)
  const monthlyNewStakersData = useMemo(
    () => transformMonthlyNewStakersData(weeklyNewStakers),
    [weeklyNewStakers]
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
        {/* Total Fees Hero Card */}
        <section className="mb-10">
          <TotalFeesCard totalFees={totalFeesData} isLoading={combinedFeesLoading} />
        </section>

        {/* KPI Cards */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Overview
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 stagger-children">
            {isLoading
              ? [...Array(4)].map((_, i) => <KPICardSkeleton key={i} />)
              : kpiData.map((kpi, index) => (
                  <KPICard key={kpi.label} data={kpi} index={index} />
                ))}
          </div>
        </section>

        {/* Fees Charts */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Trading & LP Fees
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Monthly Fees - Stacked */}
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

        {/* Active Users Section - Mixpanel */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-soft-gray uppercase tracking-widest mb-5">
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
        </section>

        {/* Staking Charts */}
        <section className="mb-10">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Total LINGO Staked */}
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

            {/* Monthly Net Flow */}
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
                  height={320}
                />
              ) : (
                <div className="h-[320px] flex items-center justify-center text-soft-gray">
                  {loadingStakingFlow ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>
        </section>

        {/* Two Column Layout */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-10">
          {/* New vs Returning Stakers */}
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

          {/* Weekly Stake Activity */}
          <ChartCard
            title="Weekly Stake Activity"
            subtitle="Total stake events vs unique wallets"
            isLoading={loadingWeeklyStakes}
            lastUpdated={weeklyStakesExecutedAt}
          >
            {weeklyStakesData.length > 0 ? (
              <BarChartComponent
                data={weeklyStakesData}
                xAxisKey="week"
                bars={[
                  {
                    dataKey: 'stakeEvents',
                    name: 'Stake Events',
                    color: '#C4B5D4',
                  },
                  {
                    dataKey: 'uniqueStakers',
                    name: 'Unique Wallets',
                    color: '#5EB851',
                  },
                ]}
                height={300}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-soft-gray">
                {loadingWeeklyStakes ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
        </section>

        {/* Monthly New Unique Stakers */}
        <section className="mb-10">
          <ChartCard
            title="New Unique Stakers per Month"
            subtitle="First-time stakers aggregated by month"
            isLoading={loadingNewStakers}
            lastUpdated={newStakersExecutedAt}
          >
            {monthlyNewStakersData.length > 0 ? (
              <SimpleBarChart
                data={monthlyNewStakersData}
                dataKey="newStakers"
                xAxisKey="month"
                color="#C4B5D4"
                height={300}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-soft-gray">
                {loadingNewStakers ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
        </section>

        {/* Monthly Growth */}
        <section className="mb-10">
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
                height={300}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-soft-gray">
                {loadingTotalStaked ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
        </section>

        {/* Membership Tiers */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-5">
            Lingo Membership Tiers
          </h2>
          <ChartCard
            title="Membership Tiers by Lock Period"
            subtitle="Users by USD value staked: Bronze ($100+), Silver ($500+), Gold ($1,000+), Diamond ($5,000+)"
            isLoading={loadingMembershipTiers}
            lastUpdated={membershipTiersExecutedAt}
          >
            <MembershipTiersTable data={membershipTiers} isLoading={loadingMembershipTiers} />
          </ChartCard>
        </section>

        {/* Monthly Retention */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-soft-gray uppercase tracking-widest mb-5">
            Staker Retention
          </h2>

          {/* Retention KPI Cards */}
          {retentionData.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              {/* Recent Retention (last 3 months) */}
              <div className="glass-card rounded-2xl p-6">
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

              {/* All-time Retention */}
              <div className="glass-card rounded-2xl p-6">
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

        {/* APY Claims Section */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-soft-gray uppercase tracking-widest mb-5">
            APY Contract Claims
          </h2>

          {/* APY Claims KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
            <div className="glass-card rounded-2xl p-6">
              <span className="text-sm text-soft-gray">Total Claims</span>
              <div className="text-2xl font-bold text-lavender mt-1">
                {loadingAPYClaims ? '...' : apyClaimsTotals.totalClaims.toLocaleString()}
              </div>
            </div>
            <div className="glass-card rounded-2xl p-6">
              <span className="text-sm text-soft-gray">Total LINGO Claimed</span>
              <div className="text-2xl font-bold text-purple mt-1">
                {loadingAPYClaims ? '...' : Math.round(apyClaimsTotals.totalLingo).toLocaleString()}
              </div>
            </div>
            <div className="glass-card rounded-2xl p-6">
              <span className="text-sm text-soft-gray">Total USD Value</span>
              <div className="text-2xl font-bold text-green1 mt-1">
                {loadingAPYClaims ? '...' : `$${Math.round(apyClaimsTotals.totalUsd).toLocaleString()}`}
              </div>
            </div>
          </div>

          {/* APY Claims Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Claims Count */}
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

            {/* LINGO Amount Claimed */}
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
        </section>

        {/* Top Stakers Table */}
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
