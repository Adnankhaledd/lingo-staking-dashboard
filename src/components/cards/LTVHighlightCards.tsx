import { useMemo } from 'react';
import { formatNumber } from '../../utils/formatters';
import type { LTVByThresholdRow } from '../../hooks/useDuneQuery';

interface LTVHighlightCardsProps {
  data: LTVByThresholdRow[] | null;
  isLoading?: boolean;
}

/** Which row of LTV_BY_THRESHOLD to surface (matches "Min 2k LINGO" label). */
const THRESHOLD_LABEL = 'Min 2k LINGO';

function pickThresholdRow(data: LTVByThresholdRow[]): LTVByThresholdRow | null {
  // Exact match first; otherwise look for any row whose label includes "2k".
  return (
    data.find(r => r.min_threshold === THRESHOLD_LABEL) ??
    data.find(r => /\b2k\b/i.test(r.min_threshold ?? '')) ??
    null
  );
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
  const row = useMemo(() => (data ? pickThresholdRow(data) : null), [data]);

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 px-1 flex-wrap gap-2">
        <h3 className="text-lg font-semibold text-lavender">LTV Highlights</h3>
        <p className="text-xs text-purple-gray">
          Stakers whose first stake was at least 2,000 LINGO &middot; all-time avg from Dune 7350883
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <StatCard
          label="Avg First Deposit"
          value={row ? formatNumber(Math.round(row.avg_first_deposit)) : '—'}
          unit="LINGO / staker"
          sub={
            row
              ? `Across ${row.total_users.toLocaleString()} stakers above the 2k LINGO threshold`
              : 'Average first-stake size for stakers above the 2k LINGO threshold'
          }
          accent="#C4B5D4"
          loading={isLoading && !row}
        />
        <StatCard
          label="Avg LTV"
          value={row ? formatNumber(Math.round(row.avg_ltv)) : '—'}
          unit="LINGO / staker"
          sub={
            row
              ? `${row.avg_ltv_multiplier.toFixed(1)}× avg first deposit · ${parseFloat(row.pct_repeat).toFixed(0)}% repeat-stakers`
              : 'Average total LTV per staker above the 2k LINGO threshold'
          }
          accent="#5EB851"
          loading={isLoading && !row}
        />
      </div>
    </div>
  );
}
