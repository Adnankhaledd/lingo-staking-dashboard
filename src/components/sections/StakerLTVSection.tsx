import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { TrendingUp, Users, Repeat, Zap, Flame } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import type {
  LTVByThresholdRow,
  LTVByFirstDepositTierRow,
  GrowthTierDistributionRow,
} from '../../hooks/useDuneQuery';

// ─── Utilities ─────────────────────────────────────────────────────────

function pct(value: string | number | null | undefined): number {
  if (value == null) return 0;
  const n = typeof value === 'string' ? parseFloat(value) : value;
  return Number.isFinite(n) ? n : 0;
}

// Shorten a tier label like "5. 10x+ growth" → "10x+ growth"
function stripTierPrefix(s: string): string {
  return s.replace(/^\d+\.\s*/, '');
}

// ─── 1. Hero KPIs ───────────────────────────────────────────────────────

interface HeroKPIsProps {
  byThreshold: LTVByThresholdRow[] | null;
  byTier: LTVByFirstDepositTierRow[] | null;
  byGrowth: GrowthTierDistributionRow[] | null;
  isLoading: boolean;
}

function LTVHeroKPIs({ byThreshold, byTier, byGrowth, isLoading }: HeroKPIsProps) {
  const stats = useMemo(() => {
    if (!byThreshold || !byTier || !byGrowth) return null;

    // Use the "≥ 2k LINGO" cohort as the "serious staker" baseline
    const baseline = byThreshold.find(r => /2k/i.test(r.min_threshold)) ?? byThreshold[0];

    // Highest repeat-rate tier (stickiest whales)
    const stickiest = byTier.reduce<LTVByFirstDepositTierRow | null>((best, r) => {
      if (!best) return r;
      return pct(r.pct_repeat) > pct(best.pct_repeat) ? r : best;
    }, null);

    // Growth tier 5 = 10x+ growth
    const powerTier = byGrowth.find(r => /10x\+/.test(r.growth_tier));
    const totalStakedAcrossAll = byGrowth.reduce((s, r) => s + (r.total_staked_by_tier ?? 0), 0);
    const powerLingoShare = powerTier && totalStakedAcrossAll > 0
      ? (powerTier.total_staked_by_tier / totalStakedAcrossAll) * 100
      : 0;

    return {
      baseline,
      stickiest,
      powerTier,
      powerLingoShare,
      totalStakedAcrossAll,
    };
  }, [byThreshold, byTier, byGrowth]);

  if (isLoading || !stats || !stats.baseline) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="flagship-card rounded-2xl p-5 h-[120px] skeleton" />)}
      </div>
    );
  }

  const { baseline, stickiest, powerTier, powerLingoShare } = stats;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <HeroStat
        icon={<TrendingUp className="w-4 h-4" />}
        iconBg="from-green1/20 to-green1/5"
        iconColor="text-green1"
        label="Avg LTV Multiplier"
        value={`${baseline.avg_ltv_multiplier.toFixed(1)}\u00D7`}
        sub={`Serious stakers (\u2265 2K) grow their stake ${baseline.avg_ltv_multiplier.toFixed(1)}\u00D7 on average`}
      />
      <HeroStat
        icon={<Repeat className="w-4 h-4" />}
        iconBg="from-purple/25 to-purple/5"
        iconColor="text-purple"
        label="Repeat Stake Rate"
        value={`${pct(baseline.pct_repeat).toFixed(0)}%`}
        sub={`${pct(baseline.pct_repeat).toFixed(0)}% come back to stake again`}
      />
      <HeroStat
        icon={<Flame className="w-4 h-4" />}
        iconBg="from-orange1/30 to-orange1/5"
        iconColor="text-orange1"
        label="Whale Loyalty"
        value={stickiest ? `${pct(stickiest.pct_repeat).toFixed(0)}%` : '\u2014'}
        sub={stickiest
          ? `${stripTierPrefix(stickiest.first_deposit_tier)} tier: ${stickiest.avg_stakes.toFixed(0)} stakes per user`
          : ''}
      />
      <HeroStat
        icon={<Zap className="w-4 h-4" />}
        iconBg="from-amber-soft/30 to-amber-soft/5"
        iconColor="text-amber-soft"
        label="Power User Share"
        value={powerTier ? `${powerLingoShare.toFixed(0)}%` : '\u2014'}
        sub={powerTier
          ? `${pct(powerTier.pct_of_users).toFixed(1)}% of users drive ${powerLingoShare.toFixed(0)}% of staked LINGO`
          : ''}
      />
    </div>
  );
}

function HeroStat({
  icon, iconBg, iconColor, label, value, sub,
}: {
  icon: React.ReactNode;
  iconBg: string;
  iconColor: string;
  label: string;
  value: string;
  sub: string;
}) {
  return (
    <div className="flagship-card rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-2 relative z-10">
        <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${iconBg} flex items-center justify-center ${iconColor}`}>
          {icon}
        </div>
        <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="text-2xl font-bold text-lavender relative z-10">{value}</p>
      <p className="text-[11px] text-purple-gray mt-1 leading-tight relative z-10">{sub}</p>
    </div>
  );
}

// ─── 2. Growth Distribution chart (16% users drive 65% LINGO) ──────────

const GROWTH_COLORS = ['#5A5F7A', '#7B68AE', '#FF7847', '#E8B100', '#5EB851'];

interface GrowthDistProps {
  data: GrowthTierDistributionRow[] | null;
  isLoading: boolean;
}

function GrowthDistributionChart({ data, isLoading }: GrowthDistProps) {
  const rows = useMemo(() => {
    if (!data) return [];
    const totalUsers = data.reduce((s, r) => s + (r.num_users ?? 0), 0);
    const totalLingo = data.reduce((s, r) => s + (r.total_staked_by_tier ?? 0), 0);
    return data.map(r => ({
      tier: stripTierPrefix(r.growth_tier),
      num_users: r.num_users,
      total_staked: Math.round(r.total_staked_by_tier),
      pctUsers: totalUsers > 0 ? (r.num_users / totalUsers) * 100 : 0,
      pctLingo: totalLingo > 0 ? (r.total_staked_by_tier / totalLingo) * 100 : 0,
    }));
  }, [data]);

  if (isLoading) return <div className="flagship-card rounded-2xl p-6 h-[280px] skeleton" />;

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="relative z-10">
        <h3 className="text-lg font-semibold text-lavender">Growth Tier Distribution</h3>
        <p className="text-sm text-soft-gray mt-1">
          Power users (<span className="text-green1 font-medium">10x+ growth</span>) drive the majority of staked LINGO
        </p>
      </div>

      {/* Two stacked bars: Users and LINGO */}
      <div className="mt-6 space-y-5 relative z-10">
        <StackedPctBar label="% of users" rows={rows} metricKey="pctUsers" formatValue={(r) => formatNumber(r.num_users)} />
        <StackedPctBar label="% of LINGO staked" rows={rows} metricKey="pctLingo" formatValue={(r) => `${formatNumber(r.total_staked)} LINGO`} />
      </div>

      {/* Legend */}
      <div className="mt-5 flex flex-wrap gap-3 relative z-10">
        {rows.map((r, i) => (
          <div key={r.tier} className="flex items-center gap-1.5 text-[11px] text-soft-gray">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: GROWTH_COLORS[i] }} />
            {r.tier}
          </div>
        ))}
      </div>
    </div>
  );
}

function StackedPctBar({
  label,
  rows,
  metricKey,
  formatValue,
}: {
  label: string;
  rows: Array<{ tier: string; pctUsers: number; pctLingo: number; num_users: number; total_staked: number }>;
  metricKey: 'pctUsers' | 'pctLingo';
  formatValue: (r: { tier: string; pctUsers: number; pctLingo: number; num_users: number; total_staked: number }) => string;
}) {
  return (
    <div>
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="flex h-8 rounded-lg overflow-hidden border border-white/[0.06]">
        {rows.map((r, i) => {
          const v = r[metricKey];
          if (v < 0.5) return null; // hide sliver < 0.5%
          return (
            <div
              key={r.tier}
              className="flex items-center justify-center relative group transition-all"
              style={{ width: `${v}%`, backgroundColor: GROWTH_COLORS[i] }}
              title={`${r.tier}: ${v.toFixed(1)}% (${formatValue(r)})`}
            >
              {v >= 10 && (
                <span className="text-[11px] font-semibold text-white/95">
                  {v.toFixed(v >= 20 ? 0 : 1)}%
                </span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── 3. LTV by First Deposit Tier bar chart ────────────────────────────

interface TierChartProps {
  data: LTVByFirstDepositTierRow[] | null;
  isLoading: boolean;
}

function LTVByDepositTierChart({ data, isLoading }: TierChartProps) {
  const rows = useMemo(() => {
    if (!data) return [];
    return data.map(r => ({
      tier: stripTierPrefix(r.first_deposit_tier),
      avg_ltv: Math.round(r.avg_ltv),
      avg_first: Math.round(r.avg_first_deposit),
      avg_additional: Math.round(r.avg_additional),
      multiplier: r.avg_ltv_multiplier,
      num_users: r.num_users,
      repeat: pct(r.pct_repeat),
      avg_stakes: r.avg_stakes,
    }));
  }, [data]);

  if (isLoading) return <div className="flagship-card rounded-2xl p-6 h-[380px] skeleton" />;

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="relative z-10">
        <h3 className="text-lg font-semibold text-lavender">LTV by First Deposit Tier</h3>
        <p className="text-sm text-soft-gray mt-1">
          First deposit vs additional stakes, per wallet cohort
        </p>
      </div>

      <div className="h-[280px] mt-5 relative z-10">
        <ResponsiveContainer minWidth={0} width="100%" height={280}>
          <BarChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
            <defs>
              <linearGradient id="ltvFirstGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7B68AE" stopOpacity={1} />
                <stop offset="100%" stopColor="#7B68AE" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="ltvAddGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5EB851" stopOpacity={1} />
                <stop offset="100%" stopColor="#5EB851" stopOpacity={0.5} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />

            <XAxis
              dataKey="tier"
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              dy={10}
            />

            <YAxis
              tickFormatter={(value) => {
                const abs = Math.abs(value);
                if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
                if (abs >= 1000) return `${(value / 1000).toFixed(0)}K`;
                return `${value}`;
              }}
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              width={65}
            />

            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null;
                const row = payload[0].payload as typeof rows[number];
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-2">{String(label)} {'\u00B7'} {formatNumber(row.num_users)} users</p>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#7B68AE' }} />
                      <span className="text-soft-gray text-sm">First deposit:</span>
                      <span className="text-lavender font-medium">{formatNumber(row.avg_first)} LINGO</span>
                    </div>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#5EB851' }} />
                      <span className="text-soft-gray text-sm">Additional:</span>
                      <span className="text-lavender font-medium">{formatNumber(row.avg_additional)} LINGO</span>
                    </div>
                    <div className="mt-2 pt-2 border-t border-white/10 text-[11px] text-purple-gray">
                      <span className="text-green1 font-semibold">{row.multiplier.toFixed(1)}{'\u00D7'}</span>
                      {' avg growth '}{'\u00B7'}{' '}
                      <span className="text-lavender">{row.repeat.toFixed(0)}%</span>
                      {' repeat '}{'\u00B7'}{' '}
                      <span className="text-lavender">{row.avg_stakes.toFixed(1)}</span>
                      {' stakes/user'}
                    </div>
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
            />

            <Bar dataKey="avg_first" stackId="a" name="First Deposit" fill="url(#ltvFirstGrad)" radius={[0, 0, 0, 0]} animationDuration={600} />
            <Bar dataKey="avg_additional" stackId="a" name="Additional" fill="url(#ltvAddGrad)" radius={[4, 4, 0, 0]} animationDuration={600} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="mt-3 flex items-center justify-center gap-5 relative z-10 text-xs">
        <div className="flex items-center gap-1.5 text-soft-gray">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#7B68AE' }} />
          First Deposit
        </div>
        <div className="flex items-center gap-1.5 text-soft-gray">
          <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: '#5EB851' }} />
          Additional Stakes
        </div>
      </div>
    </div>
  );
}

// ─── 4. LTV Cohort table (cumulative thresholds) ───────────────────────

interface CohortTableProps {
  data: LTVByThresholdRow[] | null;
  isLoading: boolean;
}

function LTVCohortTable({ data, isLoading }: CohortTableProps) {
  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">LTV by Minimum Deposit Threshold</h3>
        <p className="text-sm text-soft-gray mt-1">
          Cumulative cohorts &bull; every wallet whose first deposit was at least the threshold
        </p>
      </div>

      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">Cohort</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Users</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Avg First</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Avg Additional</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Avg LTV</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">LTV {'\u00D7'}</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Repeat</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">Total LTV</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  {[...Array(8)].map((__, j) => (
                    <td key={j} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded" /></td>
                  ))}
                </tr>
              ))
            ) : (data ?? []).map(row => (
              <tr key={row.min_threshold} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                <td className="py-3 px-6 text-sm font-medium text-lavender">
                  {row.min_threshold}
                </td>
                <td className="py-3 px-4 text-right text-sm text-soft-gray">{formatNumber(row.total_users)}</td>
                <td className="py-3 px-4 text-right text-sm text-soft-gray">{formatNumber(Math.round(row.avg_first_deposit))}</td>
                <td className="py-3 px-4 text-right text-sm text-green1">{formatNumber(Math.round(row.avg_additional))}</td>
                <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">{formatNumber(Math.round(row.avg_ltv))}</td>
                <td className="py-3 px-4 text-right text-sm">
                  <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-green1/10 border border-green1/20 text-green1">
                    <TrendingUp className="w-3 h-3" />
                    {row.avg_ltv_multiplier.toFixed(1)}{'\u00D7'}
                  </span>
                </td>
                <td className="py-3 px-4 text-right text-sm text-soft-gray">{pct(row.pct_repeat).toFixed(0)}%</td>
                <td className="py-3 px-6 text-right text-sm font-semibold text-lavender">
                  {formatNumber(Math.round(row.total_ltv))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── 5. Main section wrapper ───────────────────────────────────────────

interface StakerLTVSectionProps {
  byThreshold: LTVByThresholdRow[] | null;
  byTier: LTVByFirstDepositTierRow[] | null;
  byGrowth: GrowthTierDistributionRow[] | null;
  isLoading: boolean;
}

export function StakerLTVSection({ byThreshold, byTier, byGrowth, isLoading }: StakerLTVSectionProps) {
  return (
    <section className="space-y-5">
      <div className="flex items-center gap-3 mb-1">
        <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-green1/25 to-purple/20 border border-green1/30 flex items-center justify-center">
          <Users className="w-4 h-4 text-green1" />
        </div>
        <div>
          <h2 className="text-xl font-bold text-lavender">Staker LTV</h2>
          <p className="text-sm text-soft-gray">How stakers grow their positions over their lifetime</p>
        </div>
      </div>

      {/* Hero KPIs */}
      <LTVHeroKPIs
        byThreshold={byThreshold}
        byTier={byTier}
        byGrowth={byGrowth}
        isLoading={isLoading}
      />

      {/* Growth distribution (headline visual) */}
      <GrowthDistributionChart data={byGrowth} isLoading={isLoading} />

      {/* Two-column: deposit tier chart + cohort table */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <LTVByDepositTierChart data={byTier} isLoading={isLoading} />
        <LTVCohortTable data={byThreshold} isLoading={isLoading} />
      </div>
    </section>
  );
}

