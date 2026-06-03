import { useMemo } from 'react';
import { formatNumber } from '../../utils/formatters';
import type { StakerLTVRow } from '../../hooks/useDuneQuery';

interface LTVHighlightCardsProps {
  data: StakerLTVRow[] | null;
  isLoading?: boolean;
}

/** Stakers whose first stake was at least this many LINGO are considered "serious" and counted. */
const MIN_FIRST_STAKE_LINGO = 2_000;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDateUTC(raw: string): Date | null {
  if (!raw) return null;
  const isoish = raw.replace(' UTC', '').replace(' ', 'T') + 'Z';
  const d = new Date(isoish);
  return isNaN(d.getTime()) ? null : d;
}

/** Returns the UTC date 3 calendar months back from the start of this month. */
function threeMonthWindow(now: Date): { start: Date; end: Date; label: string } {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const start = new Date(Date.UTC(y, m - 3, 1));
  const end = new Date(Date.UTC(y, m, 1)); // up to but not including this month
  const fmt = (d: Date) => `${MONTH_NAMES[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const lastMonth = new Date(Date.UTC(y, m - 1, 1));
  return { start, end, label: `${fmt(start)} – ${fmt(lastMonth)}` };
}

interface KPI {
  value: number;
  userCount: number;
  rangeLabel: string;
}

function computeKPIs(data: StakerLTVRow[]) {
  const now = new Date();
  const threeMo = threeMonthWindow(now);

  // Filter once: serious first stakers
  const serious = data.filter(r => (r.first_stake ?? 0) >= MIN_FIRST_STAKE_LINGO);

  // Both KPIs use the same 3-month cohort — average first_stake vs average total_staked.
  let firstStakeSum = 0;
  let ltvSum = 0;
  let count = 0;
  for (const r of serious) {
    const d = parseDateUTC(r.first_stake_date);
    if (!d) continue;
    if (d >= threeMo.start && d < threeMo.end) {
      firstStakeSum += r.first_stake ?? 0;
      ltvSum += r.total_staked ?? 0;
      count += 1;
    }
  }
  const avgFirstStake = count > 0 ? firstStakeSum / count : 0;
  const avgLtv = count > 0 ? ltvSum / count : 0;

  return {
    avgFirstStakeLast3Months: {
      value: avgFirstStake,
      userCount: count,
      rangeLabel: threeMo.label,
    } as KPI,
    avgLtvLast3Months: {
      value: avgLtv,
      userCount: count,
      rangeLabel: threeMo.label,
    } as KPI,
  };
}

function StatCard({
  label,
  value,
  unit,
  sub,
  accent,
  loading,
}: {
  label: string;
  value: string;
  unit: string;
  sub: string;
  accent: string;
  loading?: boolean;
}) {
  return (
    <div className="flagship-card p-6 group transition-all duration-300 hover:scale-[1.01]">
      <div
        className="absolute -top-16 -right-16 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ backgroundColor: `${accent}25` }}
      />
      <div className="relative z-10">
        <div className="text-[11px] text-soft-gray font-medium uppercase tracking-wider">
          {label}
        </div>
        {loading ? (
          <div className="skeleton h-10 w-40 rounded mt-2" />
        ) : (
          <div className="flex items-baseline gap-2 mt-2">
            <span className="text-4xl font-bold tracking-tight" style={{ color: accent }}>
              {value}
            </span>
            <span className="text-sm text-soft-gray">{unit}</span>
          </div>
        )}
        <p className="text-xs text-purple-gray mt-2">{sub}</p>
      </div>
    </div>
  );
}

export function LTVHighlightCards({ data, isLoading }: LTVHighlightCardsProps) {
  const kpis = useMemo(() => (data ? computeKPIs(data) : null), [data]);

  const avgFirst = kpis?.avgFirstStakeLast3Months;
  const avgLtv = kpis?.avgLtvLast3Months;

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 px-1 flex-wrap gap-2">
        <h3 className="text-lg font-semibold text-lavender">LTV Highlights</h3>
        <p className="text-xs text-purple-gray">
          Stakers whose first stake was at least {formatNumber(MIN_FIRST_STAKE_LINGO)} LINGO &middot; sourced from top-500 LTV query
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label="Avg First Deposit (Last 3 Months)"
          value={avgFirst ? formatNumber(Math.round(avgFirst.value)) : '—'}
          unit="LINGO / staker"
          sub={
            avgFirst
              ? `Avg across ${avgFirst.userCount.toLocaleString()} stakers who first staked ${avgFirst.rangeLabel}`
              : 'Average first-stake size per new staker in the last 3 months'
          }
          accent="#C4B5D4"
          loading={isLoading && !avgFirst}
        />
        <StatCard
          label="Avg LTV (Last 3 Months)"
          value={avgLtv ? formatNumber(Math.round(avgLtv.value)) : '—'}
          unit="LINGO / staker"
          sub={
            avgLtv
              ? `Avg across ${avgLtv.userCount.toLocaleString()} stakers who first staked ${avgLtv.rangeLabel}`
              : 'Average total LTV per staker who joined in the last 3 months'
          }
          accent="#5EB851"
          loading={isLoading && !avgLtv}
        />
      </div>
    </div>
  );
}
