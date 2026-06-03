import { useMemo } from 'react';
import { formatCurrency } from '../../utils/formatters';
import type { StakerLTVRow } from '../../hooks/useDuneQuery';

interface LTVCohortTableProps {
  data: StakerLTVRow[] | null;
  isLoading?: boolean;
  /** How many recent months to show. Defaults to 5. */
  months?: number;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface CohortRow {
  monthKey: string;
  label: string;
  walletCount: number;
  totalFirstDeposit: number;     // USD
  totalLTV: number;              // USD, cumulative across the cohort
  additionalStaked: number;      // LTV − first deposit
  growthMultiplier: number;      // LTV / first deposit
}

function parseDay(raw: string): string {
  if (!raw) return '';
  return raw.split(/[T\s]/)[0];
}

function monthLabel(monthKey: string): string {
  const [yStr, mStr] = monthKey.split('-');
  const m = parseInt(mStr, 10);
  return `${MONTH_NAMES[m - 1]} '${yStr.slice(2)}`;
}

/**
 * Group LTV rows by the calendar month of first_stake_date and aggregate.
 * Returns the most recent N months that have data, oldest → newest.
 */
function aggregateCohorts(rows: StakerLTVRow[], months: number): CohortRow[] {
  const buckets = new Map<string, { count: number; firstDep: number; ltv: number }>();
  for (const r of rows) {
    const day = parseDay(r.first_stake_date);
    if (!day) continue;
    const monthKey = day.slice(0, 7); // "YYYY-MM"
    const bucket = buckets.get(monthKey) ?? { count: 0, firstDep: 0, ltv: 0 };
    bucket.count += 1;
    bucket.firstDep += r.first_stake_usd ?? 0;
    bucket.ltv += r.total_staked_usd ?? 0;
    buckets.set(monthKey, bucket);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .slice(-months)
    .map(([monthKey, b]) => {
      const additional = Math.max(0, b.ltv - b.firstDep);
      return {
        monthKey,
        label: monthLabel(monthKey),
        walletCount: b.count,
        totalFirstDeposit: b.firstDep,
        totalLTV: b.ltv,
        additionalStaked: additional,
        growthMultiplier: b.firstDep > 0 ? b.ltv / b.firstDep : 0,
      };
    });
}

/** Horizontal bar showing first deposit vs additional staked, summing to LTV. */
function CohortBar({ firstDeposit, additional }: { firstDeposit: number; additional: number }) {
  const total = firstDeposit + additional;
  if (total === 0) return null;
  const firstPct = (firstDeposit / total) * 100;
  return (
    <div className="flex h-2 rounded-full overflow-hidden bg-dark3 w-full">
      <div
        className="bg-purple"
        style={{ width: `${firstPct}%` }}
        title={`First deposits: ${formatCurrency(firstDeposit)}`}
      />
      <div
        className="bg-green1"
        style={{ width: `${100 - firstPct}%` }}
        title={`Additional staked: ${formatCurrency(additional)}`}
      />
    </div>
  );
}

export function LTVCohortTable({ data, isLoading, months = 5 }: LTVCohortTableProps) {
  const cohorts = useMemo(() => (data ? aggregateCohorts(data, months) : []), [data, months]);

  // Pre-compute max LTV across cohorts so we can scale the secondary bar widths
  const maxLtv = useMemo(
    () => cohorts.reduce((max, c) => Math.max(max, c.totalLTV), 0),
    [cohorts]
  );

  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10 flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-lavender">LTV by First-Stake Month</h3>
          <p className="text-sm text-soft-gray mt-1">
            Cohorts of new stakers grouped by the month they first staked &middot;
            <span className="text-purple mx-1">first deposit</span>
            +
            <span className="text-green1 mx-1">additional staked</span>
            = total LTV (USD)
          </p>
        </div>
        <p className="text-[11px] text-purple-gray max-w-xs text-right">
          Sourced from the top-500 stakers query — captures most of the value but excludes the long tail of smaller stakers.
        </p>
      </div>

      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Cohort
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                New Stakers
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                <span className="text-purple">First Deposits</span>
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                <span className="text-green1">Additional Staked</span>
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Total LTV
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Growth ×
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-16 rounded" /></td>
                  {[...Array(5)].map((__, j) => (
                    <td key={j} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  ))}
                </tr>
              ))
            ) : cohorts.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-soft-gray text-sm">
                  No LTV data available
                </td>
              </tr>
            ) : (
              cohorts.map(c => (
                <tr key={c.monthKey} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td className="py-3 px-6">
                    <div className="text-sm text-lavender font-medium whitespace-nowrap">{c.label}</div>
                    {/* LTV scale bar (purple = first dep, green = additional) */}
                    <div
                      className="mt-2"
                      style={{ width: `${Math.max(20, (c.totalLTV / Math.max(maxLtv, 1)) * 200)}px` }}
                    >
                      <CohortBar firstDeposit={c.totalFirstDeposit} additional={c.additionalStaked} />
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-lavender">
                    {c.walletCount.toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="font-semibold text-purple">{formatCurrency(c.totalFirstDeposit)}</div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="font-semibold text-green1">{formatCurrency(c.additionalStaked)}</div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <div className="font-bold text-lavender">{formatCurrency(c.totalLTV)}</div>
                  </td>
                  <td className="py-3 px-6 text-right">
                    <span
                      className={`text-sm font-semibold px-2 py-0.5 rounded-md ${
                        c.growthMultiplier >= 2
                          ? 'bg-green1/15 text-green1'
                          : c.growthMultiplier >= 1.2
                          ? 'bg-amber-soft/15 text-amber-soft'
                          : 'bg-white/[0.04] text-soft-gray'
                      }`}
                    >
                      {c.growthMultiplier.toFixed(1)}×
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
