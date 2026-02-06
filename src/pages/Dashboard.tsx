import { useMemo } from 'react';
import { Users, Calendar, CalendarDays, CalendarRange } from 'lucide-react';
import { Header } from '../components/layout';
import { KPICard, KPICardSkeleton, ChartCard, TopStakersTable, TotalFeesCard } from '../components/cards';
import { MixpanelKPICard } from '../components/cards/MixpanelKPICard';
import { AreaChartComponent, BarChartComponent, SimpleBarChart, RetentionTable } from '../components/charts';
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
} from '../hooks/useDuneQuery';
import { useMixpanelData } from '../hooks/useMixpanelData';
import {
  calculateKPIs,
  transformStakingTrendData,
  transformNewStakersData,
  transformRetentionData,
  calculateMonthlyComparison,
  transformMonthlyFeesData,
  transformCumulativeFeesData,
  getTotalFees,
} from '../utils/dataTransformers';

export function Dashboard() {
  // Fetch data from Dune Analytics
  const {
    data: totalStakedData,
    isLoading: loadingTotalStaked,
  } = useDuneQuery<TotalStakedRow>(DUNE_QUERIES.TOTAL_STAKED_TREND);

  const {
    data: weeklyStats,
    isLoading: loadingWeeklyStats,
  } = useDuneQuery<WeeklyStatsRow>(DUNE_QUERIES.WEEKLY_STATS);

  const {
    data: weeklyNewStakers,
    isLoading: loadingNewStakers,
  } = useDuneQuery<WeeklyNewStakersRow>(DUNE_QUERIES.WEEKLY_NEW_STAKERS);

  const {
    data: cohortRetention,
    isLoading: loadingRetention,
  } = useDuneQuery<CohortRetentionRow>(DUNE_QUERIES.COHORT_RETENTION);

  const {
    data: topStakers,
    isLoading: loadingTopStakers,
  } = useDuneQuery<TopStakerRow>(DUNE_QUERIES.TOP_STAKERS, { limit: 50 });

  const {
    data: tradingFees,
    isLoading: loadingFees,
  } = useDuneQuery<TradingFeesRow>(DUNE_QUERIES.TRADING_FEES);

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

  // Fees data
  const monthlyFeesData = useMemo(
    () => transformMonthlyFeesData(tradingFees),
    [tradingFees]
  );

  const cumulativeFeesData = useMemo(
    () => transformCumulativeFeesData(tradingFees),
    [tradingFees]
  );

  const totalFees = useMemo(
    () => getTotalFees(tradingFees),
    [tradingFees]
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
    <div className="min-h-screen bg-[#0a0a0f]">
      {/* Background gradient effects - Lingo style */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-[#00D4FF]/8 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-[#7B61FF]/8 rounded-full blur-[150px]" />
        <div className="absolute top-1/3 right-1/4 w-[400px] h-[400px] bg-[#00D4FF]/5 rounded-full blur-[120px]" />
      </div>

      {/* Header */}
      <Header lastUpdated={lastUpdated} />

      {/* Main Content */}
      <main className="relative w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
        {/* Total Fees Hero Card */}
        <section className="mb-10">
          <TotalFeesCard totalFees={totalFees} isLoading={loadingFees} />
        </section>

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

        {/* Fees Charts */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-5">
            Trading Fees
          </h2>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
            {/* Monthly Fees */}
            <ChartCard
              title="Monthly Trading Fees"
              subtitle="Fees collected per month in USD"
              onExport={handleExportFees}
              isLoading={loadingFees}
            >
              {monthlyFeesData.length > 0 ? (
                <SimpleBarChart
                  data={monthlyFeesData}
                  dataKey="fees"
                  xAxisKey="month"
                  color="#7B61FF"
                  height={280}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-white/40">
                  {loadingFees ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>

            {/* Cumulative Fees */}
            <ChartCard
              title="Cumulative Trading Fees"
              subtitle="Total accumulated fees over time"
              onExport={handleExportCumulativeFees}
              isLoading={loadingFees}
            >
              {cumulativeFeesData.length > 0 ? (
                <AreaChartComponent
                  data={cumulativeFeesData}
                  dataKey="cumulative"
                  xAxisKey="month"
                  color="#7B61FF"
                  gradientId="cumulativeFeesGradient"
                  height={280}
                  formatValue={(value) => formatCurrency(value)}
                />
              ) : (
                <div className="h-[280px] flex items-center justify-center text-white/40">
                  {loadingFees ? 'Loading...' : 'No data available'}
                </div>
              )}
            </ChartCard>
          </div>
        </section>

        {/* Active Users Section - Mixpanel */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-5">
            Active Users
          </h2>

          {/* DAU / WAU / MAU KPI Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
            <MixpanelKPICard
              title="Daily Active Users"
              value={mixpanelData?.currentDAU ?? 0}
              icon={Calendar}
              color="#00D4FF"
              isLoading={loadingMixpanel}
            />
            <MixpanelKPICard
              title="Avg. DAU (30d)"
              value={mixpanelData?.avgDAU ?? 0}
              icon={Users}
              color="#7B61FF"
              isLoading={loadingMixpanel}
            />
            <MixpanelKPICard
              title="Weekly Active Users"
              value={mixpanelData?.currentWAU ?? 0}
              icon={CalendarDays}
              color="#10B981"
              isLoading={loadingMixpanel}
            />
            <MixpanelKPICard
              title="Monthly Active Users"
              value={mixpanelData?.currentMAU ?? 0}
              icon={CalendarRange}
              color="#F59E0B"
              isLoading={loadingMixpanel}
            />
          </div>

          {/* DAU Trend Chart */}
          <MixpanelChart
            title="Daily Active Users Trend"
            subtitle="Unique active users per day (last 30 days)"
            data={mixpanelData?.dauTrend ?? []}
            color="#00D4FF"
            isLoading={loadingMixpanel}
          />
        </section>

        {/* Staking Trend Chart */}
        <section className="mb-10">
          <ChartCard
            title="Total LINGO Staked"
            subtitle="Cumulative staking volume over time"
            onExport={handleExportTrend}
            isLoading={loadingTotalStaked}
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
            isLoading={loadingNewStakers}
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
            isLoading={loadingTotalStaked}
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

        {/* Monthly Retention */}
        <section className="mb-10">
          <h2 className="text-xs font-semibold text-white/40 uppercase tracking-widest mb-5">
            Staker Retention
          </h2>

          {/* Retention KPI Cards */}
          {retentionData.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              {/* Recent Retention (last 3 months) */}
              <div className="glass-card rounded-2xl p-6">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm text-white/50">Recent Retention (3 months)</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-bold ${
                    (() => {
                      const recent = retentionData.slice(-3);
                      const totalNew = recent.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = recent.reduce((s, d) => s + d.stillStaking, 0);
                      const pct = totalNew > 0 ? (totalStill / totalNew) * 100 : 0;
                      return pct >= 85 ? 'text-emerald-400' : pct >= 75 ? 'text-cyan-400' : pct >= 65 ? 'text-yellow-400' : 'text-orange-400';
                    })()
                  }`}>
                    {(() => {
                      const recent = retentionData.slice(-3);
                      const totalNew = recent.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = recent.reduce((s, d) => s + d.stillStaking, 0);
                      return totalNew > 0 ? ((totalStill / totalNew) * 100).toFixed(1) : '0';
                    })()}%
                  </span>
                  <span className="text-sm text-white/40">
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
                  <span className="text-sm text-white/50">All-Time Retention</span>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className={`text-3xl font-bold ${
                    (() => {
                      const totalNew = retentionData.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = retentionData.reduce((s, d) => s + d.stillStaking, 0);
                      const pct = totalNew > 0 ? (totalStill / totalNew) * 100 : 0;
                      return pct >= 85 ? 'text-emerald-400' : pct >= 75 ? 'text-cyan-400' : pct >= 65 ? 'text-yellow-400' : 'text-orange-400';
                    })()
                  }`}>
                    {(() => {
                      const totalNew = retentionData.reduce((s, d) => s + d.newStakers, 0);
                      const totalStill = retentionData.reduce((s, d) => s + d.stillStaking, 0);
                      return totalNew > 0 ? ((totalStill / totalNew) * 100).toFixed(1) : '0';
                    })()}%
                  </span>
                  <span className="text-sm text-white/40">
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
          >
            <RetentionTable data={retentionData} isLoading={loadingRetention} />
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
            <img src="/lingo-logo.jpg" alt="Lingo" className="w-6 h-6 rounded-md object-cover" />
            <span className="text-sm font-medium text-white/50">Lingo Staking Analytics</span>
          </div>
          <p className="text-xs text-white/30">
            Powered by Dune Analytics & Mixpanel
          </p>
        </footer>
      </main>
    </div>
  );
}
