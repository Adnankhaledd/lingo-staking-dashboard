import { useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts';
import { ShieldCheck, Unlock } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { useStakeLockBreakdown, type LockHistoryRow } from '../../hooks/useStakeLockBreakdown';

// Tier display order + colors (longest lock = warmest).
const TIER_ORDER = ['Flexible', '1 Month', '3 Months', '6 Months', '12 Months', '24 Months', 'Other'];

/**
 * Non-standard lock durations (promo/admin/dust positions — some hold literally
 * a few LINGO) get folded into one "Other" bucket. Grouping only: no amounts
 * are dropped, and the totals still reconcile.
 */
function normalizeTier(label: string): string {
  return label.includes('(other)') ? 'Other' : label;
}
const TIER_COLORS: Record<string, string> = {
  'Flexible': '#7B68AE',
  '1 Month': '#5EB8C8',
  '3 Months': '#C4B5D4',
  '6 Months': '#5EB851',
  '12 Months': '#FF7847',
  '24 Months': '#FFD75E',
};
const OTHER_COLOR = '#909CB8';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return `${MONTH_NAMES[m - 1]} '${String(y).slice(2)}`;
}

export function LockBreakdownCard() {
  const { data, isLoading, error } = useStakeLockBreakdown();

  // Which tiers actually appear, after folding odd durations into "Other".
  const tierKeys = useMemo(() => {
    if (!data) return [];
    const present = new Set<string>();
    for (const h of data.history) for (const k of Object.keys(h.byTier)) present.add(normalizeTier(k));
    for (const t of data.tiers) present.add(normalizeTier(t.tier));
    const ordered = TIER_ORDER.filter(t => present.has(t));
    const extras = [...present].filter(t => !TIER_ORDER.includes(t)).sort();
    return [...ordered, ...extras];
  }, [data]);

  const chartData = useMemo(() => {
    if (!data) return [];
    return data.history.map((h: LockHistoryRow) => {
      const row: Record<string, string | number> = { month: monthLabel(h.month), _total: h.total, _locked: h.locked, _free: h.free };
      for (const k of tierKeys) row[k] = 0;
      for (const [rawTier, amount] of Object.entries(h.byTier)) {
        const k = normalizeTier(rawTier);
        row[k] = (Number(row[k]) || 0) + amount;
      }
      return row;
    });
  }, [data, tierKeys]);

  // Current tiers, with odd durations merged into a single "Other" row.
  const displayTiers = useMemo(() => {
    if (!data) return [];
    const merged = new Map<string, { tier: string; stillLocked: number; unlockedOrFlexible: number; total: number; positions: number }>();
    for (const t of data.tiers) {
      const key = normalizeTier(t.tier);
      const m = merged.get(key) ?? { tier: key, stillLocked: 0, unlockedOrFlexible: 0, total: 0, positions: 0 };
      m.stillLocked += t.stillLocked;
      m.unlockedOrFlexible += t.unlockedOrFlexible;
      m.total += t.total;
      m.positions += t.positions;
      merged.set(key, m);
    }
    return [...merged.values()]
      .filter(t => t.total > 0)
      .sort((a, b) => TIER_ORDER.indexOf(a.tier) - TIER_ORDER.indexOf(b.tier));
  }, [data]);

  if (isLoading) {
    return (
      <div className="flagship-card rounded-2xl p-6">
        <div className="skeleton h-6 w-72 rounded mb-2 relative z-10" />
        <div className="skeleton h-4 w-52 rounded mb-6 relative z-10" />
        <div className="skeleton h-72 w-full rounded-xl relative z-10" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flagship-card rounded-2xl p-6">
        <h3 className="text-lg font-semibold text-lavender">Staked by Lock Tier</h3>
        <p className="text-sm text-red-400 mt-2">{error ?? 'No data available'}</p>
      </div>
    );
  }

  const { summary, tiers, reconciliation } = data;
  const total = summary.totalOpen || 1;
  const lockedPct = (summary.stillLocked / total) * 100;
  // "Free" splits into genuinely-flexible vs matured locks — the interesting bit.
  const flexTier = tiers.find(t => t.tier === 'Flexible');
  const flexibleAmt = flexTier?.total ?? 0;
  const maturedAmt = Math.max(0, summary.flexibleOrUnlocked - flexibleAmt);

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="flex items-start justify-between mb-4 relative z-10 flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Staked by Lock Tier</h3>
          <p className="text-sm text-soft-gray mt-1">
            Exact on-chain positions &middot; locked vs withdrawable, by original lock duration
          </p>
        </div>
        {reconciliation && (
          <span
            className={`text-[11px] px-2 py-1 rounded-lg border ${
              Math.abs(reconciliation.deltaLingo) < 10_000
                ? 'text-green1 bg-green1/10 border-green1/30'
                : 'text-amber-soft bg-amber-soft/10 border-amber-soft/30'
            }`}
            title={`Computed ${reconciliation.computedOpen.toLocaleString()} vs contract balance ${reconciliation.onChainBalance.toLocaleString()}`}
          >
            ✓ ties to contract balance (±{Math.abs(reconciliation.deltaLingo).toLocaleString()})
          </span>
        )}
      </div>

      {/* Locked vs free headline */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-5 relative z-10">
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <ShieldCheck className="w-3.5 h-3.5 text-green1" />
            <span className="text-xs text-soft-gray">Still Locked</span>
          </div>
          <div className="text-2xl font-bold text-green1">{formatNumber(summary.stillLocked)}</div>
          <div className="text-[11px] text-purple-gray mt-0.5">{lockedPct.toFixed(1)}% of staked</div>
        </div>
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
          <div className="flex items-center gap-2 mb-1">
            <Unlock className="w-3.5 h-3.5 text-orange1" />
            <span className="text-xs text-soft-gray">Withdrawable Now</span>
          </div>
          <div className="text-2xl font-bold text-orange1">{formatNumber(summary.flexibleOrUnlocked)}</div>
          <div className="text-[11px] text-purple-gray mt-0.5">
            {formatNumber(flexibleAmt)} flexible &middot; {formatNumber(maturedAmt)} matured locks
          </div>
        </div>
        <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3">
          <span className="text-xs text-soft-gray">Total Staked</span>
          <div className="text-2xl font-bold text-lavender mt-1">{formatNumber(summary.totalOpen)}</div>
          <div className="text-[11px] text-purple-gray mt-0.5">block {data.asOfBlock.toLocaleString()}</div>
        </div>
      </div>

      {/* Per-tier current split */}
      <div className="space-y-2 mb-6 relative z-10">
        {displayTiers.map(t => {
          const pct = (t.total / total) * 100;
          const lockedShare = t.total > 0 ? (t.stillLocked / t.total) * 100 : 0;
          return (
            <div key={t.tier} className="flex items-center gap-3">
              <span className="w-24 text-xs text-soft-gray flex items-center gap-1.5 flex-shrink-0">
                <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: TIER_COLORS[t.tier] ?? OTHER_COLOR }} />
                {t.tier}
              </span>
              <div className="flex-1 h-4 rounded-md bg-dark3 overflow-hidden flex" title={`${t.stillLocked.toLocaleString()} locked · ${t.unlockedOrFlexible.toLocaleString()} withdrawable`}>
                <div className="h-full bg-green1/80" style={{ width: `${pct * lockedShare / 100}%` }} />
                <div className="h-full bg-orange1/60" style={{ width: `${pct * (100 - lockedShare) / 100}%` }} />
              </div>
              <span className="w-20 text-right text-xs font-semibold text-lavender flex-shrink-0">{formatNumber(t.total)}</span>
              <span className="w-12 text-right text-[11px] text-purple-gray flex-shrink-0">{pct.toFixed(1)}%</span>
            </div>
          );
        })}
        <div className="flex items-center gap-3 pt-1 text-[11px] text-purple-gray">
          <span className="w-24" />
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-green1/80" /> locked</span>
          <span className="inline-flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm bg-orange1/60" /> withdrawable</span>
        </div>
      </div>

      {/* Monthly history */}
      <h4 className="text-xs font-semibold text-soft-gray uppercase tracking-widest mb-3 relative z-10">
        Month-end history
      </h4>
      <div className="h-[300px] relative z-10">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={chartData} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} barCategoryGap="18%">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="month" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={6} interval="preserveStartEnd" />
            <YAxis tickFormatter={(v) => formatNumber(Number(v))} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={64} />
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null;
                const row = payload[0].payload as Record<string, number>;
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-2">{String(label)}</p>
                    {[...payload].reverse().map((e, i) => (
                      <div key={i} className="flex items-center gap-2 mb-1">
                        <span className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                        <span className="text-soft-gray text-xs">{e.name}:</span>
                        <span className="text-lavender text-xs font-medium">{formatNumber(Number(e.value))}</span>
                      </div>
                    ))}
                    <div className="mt-2 pt-2 border-t border-white/10 text-xs">
                      <div className="text-lavender font-semibold">Total {formatNumber(row._total)}</div>
                      <div className="text-green1">Locked {formatNumber(row._locked)}</div>
                      <div className="text-orange1">Withdrawable {formatNumber(row._free)}</div>
                    </div>
                  </div>
                );
              }}
            />
            <Legend wrapperStyle={{ paddingTop: 10 }} formatter={(v) => <span className="text-soft-gray text-xs">{v}</span>} />
            {tierKeys.map(k => (
              <Bar key={k} dataKey={k} name={k} stackId="tiers" fill={TIER_COLORS[k] ?? OTHER_COLOR} radius={[0, 0, 0, 0]} animationDuration={700} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <p className="text-[11px] text-purple-gray text-center mt-3 relative z-10">
        Each bar is the month-end position mix &middot; current month is live
      </p>
    </div>
  );
}
