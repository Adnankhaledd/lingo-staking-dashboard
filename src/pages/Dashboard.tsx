import { useState, useCallback, useMemo } from 'react';
import { Header } from '../components/layout';
import { KPICard, KPICardSkeleton, ChartCard, TopStakersTable } from '../components/cards';
import { AreaChartComponent, BarChartComponent, SimpleBarChart, HeatmapChart } from '../components/charts';
import { formatNumber, formatWeekDate, exportToCSV } from '../utils/formatters';
import {
  useDuneQuery,
  DUNE_QUERIES,
  type TotalStakedRow,
  type WeeklyStatsRow,
  type WeeklyNewStakersRow,
  type CohortRetentionRow,
  type TopStakerRow,
} from '../hooks/useDuneQuery';
import {
  calculateKPIs,
  transformStakingTrendData,
  transformNewStakersData,
  transformRetentionData,
  calculateMonthlyComparison,
} from '../utils/dataTransformers';

export function Dashboard() {
  const [lastUpdated, setLastUpdated] = useState<Date | null>(new Date());

  // Fetch data from Dune Analytics
  const {
    data: totalStakedData,
    isLoading: loadingTotalStaked,
    refetch: refetchTotalStaked,
  } = useDuneQuery<TotalStakedRow>(DUNE_QUERIES.TOTAL_STAKED_TREND);

  const {
    data: weeklyStats,
    isLoading: loadingWeeklyStats,
    refetch: refetchWeeklyStats,
  } = useDuneQuery<WeeklyStatsRow>(DUNE_QUERIES.WEEKLY_STATS);

  const {
    data: weeklyNewStakers,
    isLoading: loadingNewStakers,
    refetch: refetchNewStakers,
  } = useDuneQuery<WeeklyNewStakersRow>(DUNE_QUERIES.WEEKLY_NEW_STAKERS);

  const {
    data: cohortRetention,
    isLoading: loadingRetention,
    refetch: refetchRetention,
  } = useDuneQuery<CohortRetentionRow>(DUNE_QUERIES.COHORT_RETENTION);

  const {
    data: topStakers,
    isLoading: loadingTopStakers,
    refetch: refetchTopStakers,
  } = useDuneQuery<TopStakerRow>(DUNE_QUERIES.TOP_STAKERS, { limit: 50 });

  // Combined loading state
  const isLoading = loadingTotalStaked || loadingWeeklyStats || loadingNewStakers || loadingRetention;
  const [isRefreshing, setIsRefreshing] = useState(false);

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

  // Refresh handler
  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    await Promise.all([
      refetchTotalStaked(),
      refetchWeeklyStats(),
      refetchNewStakers(),
      refetchRetention(),
      refetchTopStakers(),
    ]);
    setLastUpdated(new Date());
    setIsRefreshing(false);
  }, [refetchTotalStaked, refetchWeeklyStats, refetchNewStakers, refetchRetention, refetchTopStakers]);

  // Export handlers
  const handleExportTrend = useCallback(() => {
    if (stakingTrendData.length > 0) {
      exportToCSV(stakingTrendData, 'lingo_staking_trend');
    }
  }, [stakingTrendData]);

  const handleExportNewVsReturning = useCallback(() => {
    if (newVsReturningData.length > 0) {
      exportToCSV(newVsReturningData, 'lingo_new_vs_returning');
    }
  }, [newVsReturningData]);

  const handleExportMonthly = useCallback(() => {
    if (monthlyData.length > 0) {
      exportToCSV(monthlyData, 'lingo_monthly_comparison');
    }
  }, [monthlyData]);

  return (
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* Background gradient effects - Lingo style */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#00D4FF]/8 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-[#7B61FF]/8 rounded-full blur-[150px]" />
        <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] bg-[#00D4FF]/5 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <Header
        lastUpdated={lastUpdated}
        onRefresh={handleRefresh}
        isRefreshing={isRefreshing || isLoading}
      />

      {/* Main Content */}
      <main className="relative w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
        {/* KPI Cards */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-5">
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

        {/* Staking Trend Chart */}
        <section className="mb-10">
          <ChartCard
            title="Total LINGO Staked"
            subtitle="Cumulative staking volume over time"
            onExport={handleExportTrend}
            onRefresh={handleRefresh}
            isLoading={isRefreshing || loadingTotalStaked}
          >
            {stakingTrendData.length > 0 ? (
              <AreaChartComponent
                data={stakingTrendData}
                dataKey="volume"
                xAxisKey="date"
                color="#00D4FF"
                gradientId="stakingTrendGradient"
                height={320}
                formatValue={(value) => formatNumber(value) + ' LINGO'}
              />
            ) : (
              <div className="h-[320px] flex items-center justify-center text-white/40">
                {loadingTotalStaked ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
        </section>

        {/* Two Column Layout */}
        <section className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-10">
          {/* New vs Returning Stakers */}
          <ChartCard
            title="New vs Returning Stakers"
            subtitle="Weekly breakdown of staker types"
            onExport={handleExportNewVsReturning}
            isLoading={isRefreshing || loadingNewStakers}
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
                    color: '#7B61FF',
                    stackId: 'stakers',
                  },
                  {
                    dataKey: 'newStakers',
                    name: 'New',
                    color: '#00D4FF',
                    stackId: 'stakers',
                  },
                ]}
                height={300}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-white/40">
                {loadingNewStakers ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>

          {/* Monthly Comparison */}
          <ChartCard
            title="Monthly Staking Growth"
            subtitle="Month-over-month total staked"
            onExport={handleExportMonthly}
            isLoading={isRefreshing || loadingTotalStaked}
          >
            {monthlyData.length > 0 ? (
              <SimpleBarChart
                data={monthlyData}
                dataKey="volume"
                xAxisKey="month"
                color="#00D4FF"
                height={300}
              />
            ) : (
              <div className="h-[300px] flex items-center justify-center text-white/40">
                {loadingTotalStaked ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
        </section>

        {/* Retention Heatmap */}
        <section className="mb-10">
          <ChartCard
            title="Cohort Retention"
            subtitle="User retention rates by weekly cohorts"
            isLoading={isRefreshing || loadingRetention}
          >
            {retentionData.length > 0 ? (
              <HeatmapChart data={retentionData} />
            ) : (
              <div className="h-[200px] flex items-center justify-center text-white/40">
                {loadingRetention ? 'Loading...' : 'No data available'}
              </div>
            )}
          </ChartCard>
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
            <img src="/lingo-logo.svg" alt="Lingo" className="w-6 h-6 rounded-md" />
            <span className="text-sm font-medium text-white/50">Lingo Staking Analytics</span>
          </div>
          <p className="text-xs text-white/30">
            Powered by Dune Analytics
          </p>
        </footer>
      </main>
    </div>
  );
}
