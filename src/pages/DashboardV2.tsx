import { useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Header, SectionNav, type SectionNavItem } from '../components/layout';
import { KPICard, KPICardSkeleton, ChartCard, StakingUpdateCard } from '../components/cards';
import { TierGrowthTable } from '../components/cards/TierGrowthTable';
import { AreaChartComponent, BarChartComponent, RetentionTable } from '../components/charts';
import { LockBreakdownCard } from '../components/charts/LockBreakdownCard';
import { LiveActivityFeed } from '../components/LiveActivityFeed';
import { useLiveTotalStaked } from '../hooks/useLiveTotalStaked';
import { useStakingMetrics, type MonthlyRow, type Tier } from '../hooks/useStakingMetrics';
import type { TotalStakedRow, MonthlyTierGrowthRow } from '../hooks/useDuneQuery';
import type { MonthlyRetentionData } from '../utils/dataTransformers';
import type { KPIData } from '../types';
import { formatNumber, exportToCSV } from '../utils/formatters';

/**
 * /v2 — the staking dashboard rebuilt on Alchemy alone. Every chart comes from
 * one daily snapshot (/api/staking-metrics) replayed from the staking
 * contract's events; the headline total and the activity feed stay live.
 * Page views make no Alchemy calls beyond the two CDN-cached live endpoints.
 */

const SECTIONS: SectionNavItem[] = [
  { id: 'overview',  label: 'Overview' },
  { id: 'staking',   label: 'Staking' },
  { id: 'locks',     label: 'Lock Duration' },
  { id: 'new-users', label: 'New Users' },
  { id: 'tiers',     label: 'Users by Tier' },
  { id: 'retention', label: 'Retention' },
];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${MONTHS[m - 1]} '${String(y).slice(2)}`;
};

// Same colours as LockBreakdownCard and TierGrowthTable, so the page reads as one system.
const LOCK_COLORS = { flexible: '#7B68AE', '3mo': '#C4B5D4', '6mo': '#5EB851', '12mo': '#FF7847' };
const TIER_META: Array<{ key: Exclude<Tier, 'below'>; label: string; threshold: string; color: string }> = [
  { key: 'member', label: 'Member', threshold: '$100+',  color: '#C4B5D4' },
  { key: 'holder', label: 'Holder', threshold: '$250+',  color: '#5EB851' },
  { key: 'elite',  label: 'Elite',  threshold: '$1k+',   color: '#FF7847' },
  { key: 'legend', label: 'Legend', threshold: '$2.5k+', color: '#FFD75E' },
];

// The current month is unfinished: a flow so far is "MTD", a balance is "now".
const flowLabel = (m: MonthlyRow) => monthLabel(m.month) + (m.partial ? ' (MTD)' : '');
const balanceLabel = (m: MonthlyRow) => monthLabel(m.month) + (m.partial ? ' (now)' : '');
const whole = (v: number) => Math.round(v).toLocaleString();

const pctChange = (now: number, prev: number | null | undefined) =>
  prev != null && prev !== 0 ? ((now - prev) / prev) * 100 : undefined;
const trendOf = (v: number | undefined): KPIData['trend'] =>
  v == null ? 'neutral' : v > 0 ? 'up' : v < 0 ? 'down' : 'neutral';

function Empty({ loading, height = 300 }: { loading: boolean; height?: number }) {
  return (
    <div className="flex items-center justify-center text-soft-gray" style={{ height }}>
      {loading ? 'Loading…' : 'No data available'}
    </div>
  );
}

function Headline({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex flex-col items-center gap-1.5 mb-4">
      <span className="text-xs text-soft-gray uppercase tracking-wider">{label}</span>
      <span className="text-4xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent tracking-tight">
        {value}
      </span>
      {detail && <span className="text-xs text-purple-gray">{detail}</span>}
    </div>
  );
}

function StatTile({ label, value, change, note, tone = 'text-lavender' }: {
  label: string; value: string; change?: number; note: string; tone?: string;
}) {
  return (
    <div className="flagship-card p-6">
      <div className="relative z-10">
        <div className="flex items-center justify-between">
          <span className="text-sm text-soft-gray">{label}</span>
          {change != null && Number.isFinite(change) && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${change >= 0 ? 'bg-green1/15 text-green1' : 'bg-red-400/15 text-red-400'}`}>
              {change >= 0 ? '+' : ''}{change.toFixed(1)}%
            </span>
          )}
        </div>
        <div className={`text-2xl font-bold mt-2 ${tone}`}>{value}</div>
        <p className="text-xs text-purple-gray mt-1">{note}</p>
      </div>
    </div>
  );
}

export function DashboardV2() {
  const { data, isLoading, error } = useStakingMetrics();
  const { totalStaked: liveTotal } = useLiveTotalStaked();
  const [tierBasis, setTierBasis] = useState<'now' | 'then'>('now');
  // December 2024 (launch: 15.5K first-time wallets) dwarfs every later month,
  // so the New Users charts open on the last 12 months.
  const [range, setRange] = useState<'12m' | 'all'>('12m');

  const monthly = useMemo(() => data?.monthly ?? [], [data]);
  const lastUpdated = useMemo(() => (data ? new Date(data.generatedAt) : null), [data]);

  // Daily series in the shape StakingUpdateCard already reads. The last day is
  // swapped for the live total so the current period's bar moves in real time.
  const dailyRows: TotalStakedRow[] = useMemo(() => {
    if (!data) return [];
    const rows = data.daily.map(d => ({
      day: d.day, total_staked: d.total_staked,
      change_from_yesterday: d.change_from_yesterday, change_pct: d.change_pct,
    }));
    if (liveTotal != null && rows.length) {
      const last = rows[rows.length - 1];
      const prev = rows[rows.length - 2];
      rows[rows.length - 1] = {
        ...last,
        total_staked: liveTotal,
        change_from_yesterday: prev ? liveTotal - prev.total_staked : last.change_from_yesterday,
      };
    }
    return rows;
  }, [data, liveTotal]);

  const trendData = useMemo(() => dailyRows.map(r => ({ date: r.day, volume: r.total_staked })), [dailyRows]);

  // ── Overview KPIs ──
  const kpis: KPIData[] = useMemo(() => {
    if (!data) return [];
    const daily = data.daily;
    const ago = daily[Math.max(0, daily.length - 31)];
    const total = liveTotal ?? data.current.totalStaked;
    const thisMonth = monthly[monthly.length - 1];
    const lastMonth = monthly[monthly.length - 2];
    const lockedPct = data.current.totalStaked ? (data.current.locked / data.current.totalStaked) * 100 : 0;
    const twelveShare = thisMonth?.staked.total ? (thisMonth.staked['12mo'] / thisMonth.staked.total) * 100 : 0;
    const totalChange = pctChange(total, ago?.total_staked);
    const activeChange = pctChange(data.current.activeStakers, ago?.active_stakers);
    const newChange = pctChange(thisMonth?.newWallets ?? 0, lastMonth?.newWallets);
    const stakedChange = pctChange(thisMonth?.staked.total ?? 0, lastMonth?.staked.total);
    return [
      { label: 'Total Staked', value: total, suffix: 'LINGO', trend: trendOf(totalChange), trendValue: totalChange },
      { label: `Locked (${lockedPct.toFixed(0)}% of total)`, value: data.current.locked, suffix: 'LINGO' },
      { label: 'Active Stakers', value: data.current.activeStakers, trend: trendOf(activeChange), trendValue: activeChange },
      { label: `New Stakers · ${thisMonth ? monthLabel(thisMonth.month) : ''}`, value: thisMonth?.newWallets ?? 0, decimals: 0, trend: trendOf(newChange), trendValue: newChange },
      { label: `Staked · ${thisMonth ? monthLabel(thisMonth.month) : ''} (${twelveShare.toFixed(0)}% 1-yr)`, value: thisMonth?.staked.total ?? 0, suffix: 'LINGO', trend: trendOf(stakedChange), trendValue: stakedChange },
    ];
  }, [data, liveTotal, monthly]);

  // ── Locks ──
  const lockedByDuration = useMemo(() => monthly.map(m => ({
    month: balanceLabel(m),
    threeMonth: m.lockedByBucket['3mo'],
    sixMonth: m.lockedByBucket['6mo'],
    twelveMonth: m.lockedByBucket['12mo'],
    total: m.lockedByBucket['3mo'] + m.lockedByBucket['6mo'] + m.lockedByBucket['12mo'] + m.lockedByBucket.other,
  })), [monthly]);

  const stakedByDuration = useMemo(() => monthly.map(m => ({
    month: flowLabel(m),
    flexible: m.staked.flexible,
    threeMonth: m.staked['3mo'],
    sixMonth: m.staked['6mo'],
    twelveMonth: m.staked['12mo'],
  })), [monthly]);

  const yearly = useMemo(() => {
    if (!monthly.length) return null;
    const cur = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    const allTime = monthly.reduce((s, m) => s + m.staked['12mo'], 0);
    return {
      month: monthLabel(cur.month),
      thisMonth: cur.staked['12mo'],
      share: cur.staked.total ? (cur.staked['12mo'] / cur.staked.total) * 100 : 0,
      change: pctChange(cur.staked['12mo'], prev?.staked['12mo']),
      prevMonth: prev ? monthLabel(prev.month) : '',
      prev: prev?.staked['12mo'] ?? 0,
      allTime,
    };
  }, [monthly]);

  // ── New users ──
  const newUserKpis = useMemo(() => {
    if (monthly.length === 0) return null;
    const cur = monthly[monthly.length - 1];
    const prev = monthly[monthly.length - 2];
    const avg = (m?: MonthlyRow) => (m && m.newWallets ? m.newLingo / m.newWallets : 0);
    return {
      label: monthLabel(cur.month),
      newWallets: cur.newWallets, newWalletsChange: pctChange(cur.newWallets, prev?.newWallets),
      newLingo: cur.newLingo, newLingoChange: pctChange(cur.newLingo, prev?.newLingo),
      avgFirst: avg(cur), avgFirstChange: pctChange(avg(cur), avg(prev)),
    };
  }, [monthly]);

  const usersRange = useMemo(() => (range === 'all' ? monthly : monthly.slice(-12)), [monthly, range]);

  const newWalletsPerMonth = useMemo(() => usersRange.map(m => ({
    month: flowLabel(m),
    newWallets: m.newWallets,
  })), [usersRange]);

  const newWalletsByTier = useMemo(() => usersRange.map(m => ({
    month: flowLabel(m),
    member: m.newWalletTiers.member,
    holder: m.newWalletTiers.holder,
    elite: m.newWalletTiers.elite,
    legend: m.newWalletTiers.legend,
  })), [usersRange]);

  const byWalletType = useMemo(() => usersRange.map(m => ({
    month: flowLabel(m),
    newLingo: m.newLingo,
    returningLingo: m.returningLingo,
  })), [usersRange]);

  // ── Users by tier ──
  const tierKey = tierBasis === 'now' ? 'tiersNow' : 'tiers';
  const tierChart = useMemo(() => monthly.map(m => ({
    month: balanceLabel(m),
    member: m[tierKey].member,
    holder: m[tierKey].holder,
    elite: m[tierKey].elite,
    legend: m[tierKey].legend,
  })), [monthly, tierKey]);

  // TierGrowthTable reads the old Dune row shape.
  const tierGrowthRows: MonthlyTierGrowthRow[] = useMemo(() => monthly.map(m => ({
    month: `${m.month}-01`,
    total_stakers: m.activeStakers,
    'below $100': m[tierKey].below,
    'member ($100+)': m[tierKey].member,
    'holder ($250+)': m[tierKey].holder,
    'elite ($1000+)': m[tierKey].elite,
    'legend ($2500+)': m[tierKey].legend,
  })), [monthly, tierKey]);

  // ── Retention ──
  const retention: MonthlyRetentionData[] = useMemo(() => (data?.cohorts ?? []).map(c => ({
    month: monthLabel(c.month),
    newStakers: c.size,
    stillStaking: c.neverUnstaked + c.partial,
    retentionPct: c.retainedPct,
  })), [data]);

  const retentionSummary = useMemo(() => {
    const sum = (rows: MonthlyRetentionData[]) => {
      const n = rows.reduce((s, r) => s + r.newStakers, 0);
      const still = rows.reduce((s, r) => s + r.stillStaking, 0);
      return { n, still, pct: n ? (still / n) * 100 : 0 };
    };
    // Exclude the current month: its cohort has barely had time to leave.
    const complete = retention.slice(0, -1);
    return { recent: sum(complete.slice(-3)), all: sum(retention) };
  }, [retention]);

  const recon = data?.reconciliation;

  return (
    <div className="min-h-screen bg-background">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple/6 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-sosiska/5 rounded-full blur-[150px]" />
      </div>

      <Header lastUpdated={lastUpdated} />
      <SectionNav sections={SECTIONS} />

      <main className="relative w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
        {/* Provenance strip — what this page is built from, and that it ties out. */}
        <div className="flagship-card px-5 py-3 mb-8 flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-soft-gray">
          <span className="inline-flex items-center gap-1.5 text-green1 font-medium">
            <ShieldCheck className="w-4 h-4" /> On-chain · Alchemy
          </span>
          {data && (
            <>
              <span>{(data.source.stakedEvents + data.source.closeEvents).toLocaleString()} staking events replayed</span>
              {recon && (
                <span>Ties to the contract balance within {Math.abs(recon.deltaLingo).toLocaleString()} LINGO of {formatNumber(recon.onChainBalance)}</span>
              )}
              <span>Charts rebuilt daily · last {new Date(data.generatedAt).toUTCString().slice(5, 22)} UTC</span>
              <span>Headline total and activity feed are live</span>
            </>
          )}
          {error && <span className="text-red-400">Could not load metrics: {error}</span>}
        </div>

        {/* ═══ OVERVIEW ═══ */}
        <section id="overview" className="mb-10 scroll-mt-32">
          <StakingUpdateCard data={dailyRows.length ? dailyRows : null} isLoading={isLoading} />
        </section>

        <section className="mb-10">
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-5 gap-4 stagger-children">
            {isLoading || !data
              ? [...Array(5)].map((_, i) => <KPICardSkeleton key={i} />)
              : kpis.map((kpi, i) => <KPICard key={kpi.label} data={kpi} index={i} />)}
          </div>
        </section>

        <section className="mb-10">
          <LiveActivityFeed />
        </section>

        {/* ═══ STAKING ═══ */}
        <section id="staking" className="mb-10 scroll-mt-32">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">Staking</h2>

          <div className="mb-5">
            <ChartCard
              title="Total LINGO Staked"
              subtitle="Open staked balance at the end of every day since staking began"
              isLoading={isLoading}
              onExport={() => data && exportToCSV(data.daily, 'lingo_daily_staked')}
            >
              {trendData.length ? (
                <>
                  <Headline
                    label={liveTotal != null ? 'Total staked · live' : 'Total staked'}
                    value={(liveTotal ?? data?.current.totalStaked ?? 0).toLocaleString()}
                    detail={data ? `${data.current.activeStakers.toLocaleString()} wallets with an open stake` : undefined}
                  />
                  <AreaChartComponent
                    data={trendData}
                    dataKey="volume"
                    xAxisKey="date"
                    color="#C4B5D4"
                    gradientId="v2TrendGradient"
                    height={290}
                    formatValue={v => formatNumber(v) + ' LINGO'}
                  />
                </>
              ) : <Empty loading={isLoading} height={320} />}
            </ChartCard>
          </div>

          {/* Staked by lock tier — same card as today, fed from the snapshot. */}
          <LockBreakdownCard data={data?.lockBreakdown ?? null} isLoading={isLoading} />
        </section>

        {/* ═══ LOCK DURATION ═══ */}
        <section id="locks" className="mb-10 scroll-mt-32">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">Lock Duration</h2>

          <div className="mb-5">
            <ChartCard
              title="Locked LINGO by Lock Duration"
              subtitle="Month-end balance still inside its lock, by lock length. Expired locks that haven't been withdrawn are not counted."
              isLoading={isLoading}
              onExport={() => exportToCSV(lockedByDuration, 'lingo_locked_by_duration')}
            >
              {lockedByDuration.length ? (
                <>
                  {(() => {
                    const l = lockedByDuration[lockedByDuration.length - 1];
                    return (
                      <Headline
                        label={`Total locked · ${l.month}`}
                        value={l.total.toLocaleString()}
                        detail={`3mo ${formatNumber(l.threeMonth)} · 6mo ${formatNumber(l.sixMonth)} · 1y ${formatNumber(l.twelveMonth)}`}
                      />
                    );
                  })()}
                  <BarChartComponent
                    data={lockedByDuration}
                    xAxisKey="month"
                    formatXAxis={v => v}
                    showTotal
                    bars={[
                      { dataKey: 'threeMonth', name: '3 Month', color: LOCK_COLORS['3mo'], stackId: 'l' },
                      { dataKey: 'sixMonth', name: '6 Month', color: LOCK_COLORS['6mo'], stackId: 'l' },
                      { dataKey: 'twelveMonth', name: '1 Year', color: LOCK_COLORS['12mo'], stackId: 'l' },
                    ]}
                    height={300}
                  />
                </>
              ) : <Empty loading={isLoading} />}
            </ChartCard>
          </div>

          {/* 1-year stakes, called out on their own — the number that matters most. */}
          {yearly && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
              <StatTile
                label={`1-Year Stakes · ${yearly.month}`}
                value={`${formatNumber(yearly.thisMonth)} LINGO`}
                change={yearly.change}
                note={`${yearly.share.toFixed(0)}% of everything staked this month`}
                tone="text-orange1"
              />
              <StatTile
                label={`1-Year Stakes · ${yearly.prevMonth}`}
                value={`${formatNumber(yearly.prev)} LINGO`}
                note="Previous full month"
              />
              <StatTile
                label="1-Year Stakes · All Time"
                value={`${formatNumber(yearly.allTime)} LINGO`}
                note="Every 12-month lock ever opened"
                tone="text-green1"
              />
            </div>
          )}

          <ChartCard
            title="Monthly LINGO Staked by Lock Duration"
            subtitle="New LINGO staked each month, by the lock chosen at the time"
            isLoading={isLoading}
            onExport={() => exportToCSV(stakedByDuration, 'lingo_monthly_staked_by_lock')}
          >
            {stakedByDuration.length ? (
              <BarChartComponent
                data={stakedByDuration}
                xAxisKey="month"
                formatXAxis={v => v}
                showTotal
                bars={[
                  { dataKey: 'flexible', name: 'Flexible', color: LOCK_COLORS.flexible, stackId: 's' },
                  { dataKey: 'threeMonth', name: '3 Month', color: LOCK_COLORS['3mo'], stackId: 's' },
                  { dataKey: 'sixMonth', name: '6 Month', color: LOCK_COLORS['6mo'], stackId: 's' },
                  { dataKey: 'twelveMonth', name: '1 Year', color: LOCK_COLORS['12mo'], stackId: 's' },
                ]}
                height={320}
              />
            ) : <Empty loading={isLoading} height={320} />}
          </ChartCard>
        </section>

        {/* ═══ NEW USERS ═══ */}
        <section id="new-users" className="mb-10 scroll-mt-32">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">New Users</h2>

          {newUserKpis && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-5">
              <StatTile
                label={`New Wallets (${newUserKpis.label})`}
                value={newUserKpis.newWallets.toLocaleString()}
                change={newUserKpis.newWalletsChange}
                note="Wallets that staked for the first time this month"
              />
              <StatTile
                label="LINGO from New Wallets"
                value={formatNumber(newUserKpis.newLingo)}
                change={newUserKpis.newLingoChange}
                note="Everything new wallets staked in their first month"
                tone="text-purple"
              />
              <StatTile
                label="Avg First-Month Stake"
                value={formatNumber(newUserKpis.avgFirst)}
                change={newUserKpis.avgFirstChange}
                note="LINGO per new wallet"
                tone="text-green1"
              />
            </div>
          )}

          <div className="flex justify-end mb-3">
            <div className="inline-flex rounded-lg border border-white/10 p-0.5 text-xs">
              {([['12m', 'Last 12 months'], ['all', 'All time']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setRange(k)}
                  className={`px-3 py-1.5 rounded-md transition-colors ${range === k ? 'bg-purple/30 text-lavender' : 'text-soft-gray hover:text-lavender'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-5">
            <ChartCard
              title="New Wallets per Month"
              subtitle="Wallets staking for the first time"
              isLoading={isLoading}
              onExport={() => exportToCSV(newWalletsPerMonth, 'lingo_new_wallets')}
            >
              {newWalletsPerMonth.length ? (
                <BarChartComponent
                  data={newWalletsPerMonth}
                  xAxisKey="month"
                  formatXAxis={v => v}
                  formatValue={whole}
                  showLegend={false}
                  bars={[{ dataKey: 'newWallets', name: 'New wallets', color: '#C4B5D4' }]}
                  height={300}
                />
              ) : <Empty loading={isLoading} />}
            </ChartCard>

            <ChartCard
              title="New Wallets by Tier ($100+)"
              subtitle={`By the USD value of their first month's stakes, at the price on the day. Under-$100 wallets not shown${newUserKpis ? ` (${(monthly[monthly.length - 1]?.newWalletTiers.below ?? 0).toLocaleString()} this month)` : ''}.`}
              isLoading={isLoading}
              onExport={() => exportToCSV(newWalletsByTier, 'lingo_new_wallets_by_tier')}
            >
              {newWalletsByTier.length ? (
                <BarChartComponent
                  data={newWalletsByTier}
                  xAxisKey="month"
                  formatXAxis={v => v}
                  formatValue={whole}
                  showTotal
                  bars={TIER_META.map(t => ({ dataKey: t.key, name: `${t.label} ${t.threshold}`, color: t.color, stackId: 'n' }))}
                  height={300}
                />
              ) : <Empty loading={isLoading} />}
            </ChartCard>
          </div>

          <ChartCard
            title="Monthly LINGO Staked by Wallet Type"
            subtitle="New = the wallet's first month staking · Returning = first staked in an earlier month"
            isLoading={isLoading}
            onExport={() => exportToCSV(byWalletType, 'lingo_staked_by_wallet_type')}
          >
            {byWalletType.length ? (
              <BarChartComponent
                data={byWalletType}
                xAxisKey="month"
                formatXAxis={v => v}
                showTotal
                bars={[
                  { dataKey: 'newLingo', name: 'New wallets', color: '#5EB851', stackId: 'w' },
                  { dataKey: 'returningLingo', name: 'Returning wallets', color: '#7B68AE', stackId: 'w' },
                ]}
                height={320}
              />
            ) : <Empty loading={isLoading} height={320} />}
          </ChartCard>
        </section>

        {/* ═══ USERS BY TIER ═══ */}
        <section id="tiers" className="mb-10 scroll-mt-32">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest">Users by Tier</h2>
            <div className="inline-flex rounded-lg border border-white/10 p-0.5 text-xs">
              {([['now', "At today's price"], ['then', 'At the price then']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setTierBasis(k)}
                  className={`px-3 py-1.5 rounded-md transition-colors ${tierBasis === k ? 'bg-purple/30 text-lavender' : 'text-soft-gray hover:text-lavender'}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {data && (
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-5">
              {TIER_META.map(t => (
                <div key={t.key} className="flagship-card p-5">
                  <div className="relative z-10">
                    <div className="flex items-center gap-2 text-sm text-soft-gray">
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: t.color }} />
                      {t.label} <span className="text-purple-gray">{t.threshold}</span>
                    </div>
                    <div className="text-2xl font-bold text-lavender mt-2">{data.current.tiers[t.key].toLocaleString()}</div>
                    <p className="text-xs text-purple-gray mt-1">stakers right now</p>
                  </div>
                </div>
              ))}
            </div>
          )}

          <div className="mb-5">
            <ChartCard
              title="Stakers by Tier, Month End"
              subtitle={tierBasis === 'now'
                ? "Each month's balances valued at today's LINGO price — shows accumulation without price swings"
                : "Each month's balances valued at that month's closing price — tier membership as it actually was"}
              isLoading={isLoading}
              onExport={() => exportToCSV(tierChart, `lingo_tiers_${tierBasis}`)}
            >
              {tierChart.length ? (
                <BarChartComponent
                  data={tierChart}
                  xAxisKey="month"
                  formatXAxis={v => v}
                  showTotal
                  formatValue={whole}
                  bars={TIER_META.map(t => ({ dataKey: t.key, name: `${t.label} ${t.threshold}`, color: t.color, stackId: 't' }))}
                  height={320}
                />
              ) : <Empty loading={isLoading} height={320} />}
            </ChartCard>
          </div>

          <TierGrowthTable data={tierGrowthRows} isLoading={isLoading} />
        </section>

        {/* ═══ RETENTION ═══ */}
        <section id="retention" className="mb-10 scroll-mt-32">
          <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-5">Stake Retention</h2>

          {retention.length > 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-5">
              <StatTile
                label="Recent Retention (last 3 full months)"
                value={`${retentionSummary.recent.pct.toFixed(1)}%`}
                note={`${retentionSummary.recent.still.toLocaleString()} of ${retentionSummary.recent.n.toLocaleString()} new stakers still have a stake`}
              />
              <StatTile
                label="All-Time Retention"
                value={`${retentionSummary.all.pct.toFixed(1)}%`}
                note={`${retentionSummary.all.still.toLocaleString()} of ${retentionSummary.all.n.toLocaleString()} wallets that ever staked`}
              />
            </div>
          )}

          <ChartCard
            title="Monthly Cohort Breakdown"
            subtitle="Wallets grouped by the month of their first stake, and how many still have LINGO staked today"
            isLoading={isLoading}
            onExport={() => data && exportToCSV(data.cohorts.map(({ curve, ...c }) => ({ ...c, monthsTracked: curve.length })), 'lingo_cohorts')}
          >
            <RetentionTable data={retention} isLoading={isLoading} />
          </ChartCard>
        </section>
      </main>
    </div>
  );
}
