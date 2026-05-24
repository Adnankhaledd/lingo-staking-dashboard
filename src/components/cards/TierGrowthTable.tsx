import { useMemo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { parseDuneDate } from '../../utils/dataTransformers';
import type { StakerTiersWeeklyRow } from '../../hooks/useDuneQuery';

interface TierGrowthTableProps {
  data: StakerTiersWeeklyRow[] | null;
  isLoading?: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUTOFF_MONTH_KEY = '2026-01'; // inclusive

interface MonthlyRow {
  monthKey: string;       // "YYYY-MM"
  label: string;          // "Jan '26"
  asOfWeek: string;       // "YYYY-MM-DD" — last week-end in the month
  totalStakers: number;
  stakers100: number;
  stakers500: number;
  stakers1000: number;
}

/** Take the latest week-end snapshot inside each month and keep months from Jan 2026 on. */
function aggregateMonthly(rows: StakerTiersWeeklyRow[]): MonthlyRow[] {
  const buckets = new Map<string, { week: string; row: StakerTiersWeeklyRow }>();
  for (const row of rows) {
    const week = parseDuneDate(row.week); // "YYYY-MM-DD"
    if (!week) continue;
    const monthKey = week.slice(0, 7);
    if (monthKey < CUTOFF_MONTH_KEY) continue;
    const existing = buckets.get(monthKey);
    if (!existing || week > existing.week) {
      buckets.set(monthKey, { week, row });
    }
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([monthKey, { week, row }]) => {
      const [, m] = monthKey.split('-').map(Number);
      const yearShort = monthKey.slice(2, 4);
      return {
        monthKey,
        label: `${MONTH_NAMES[m - 1]} '${yearShort}`,
        asOfWeek: week,
        totalStakers: row.total_stakers,
        stakers100: row.stakers_100_plus,
        stakers500: row.stakers_500_plus,
        stakers1000: row.stakers_1000_plus,
      };
    });
}

/** Inline cell: big number above, small Δ + % below (or em-dash for first row). */
function GrowthCell({ value, prev }: { value: number; prev: number | null }) {
  if (prev == null) {
    return (
      <div className="text-right">
        <div className="font-semibold text-lavender">{formatNumber(value)}</div>
        <div className="text-[10px] text-purple-gray mt-0.5">—</div>
      </div>
    );
  }
  const delta = value - prev;
  const pct = prev > 0 ? (delta / prev) * 100 : 0;
  const isUp = delta > 0;
  const isDown = delta < 0;
  const color = isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-soft-gray';
  const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
  return (
    <div className="text-right">
      <div className="font-semibold text-lavender">{formatNumber(value)}</div>
      <div className={`text-[10px] mt-0.5 flex items-center justify-end gap-0.5 ${color}`}>
        <Icon className="w-2.5 h-2.5" />
        {Math.abs(delta).toLocaleString()}
        <span className="text-purple-gray ml-1">({isUp ? '+' : isDown ? '' : ''}{pct.toFixed(1)}%)</span>
      </div>
    </div>
  );
}

export function TierGrowthTable({ data, isLoading }: TierGrowthTableProps) {
  const rows = useMemo(() => (data ? aggregateMonthly(data) : []), [data]);

  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">Tier Growth (Monthly)</h3>
        <p className="text-sm text-soft-gray mt-1">
          Month-end snapshots of staker counts by USD tier, from Jan 2026 onward
        </p>
      </div>

      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Month
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Total Stakers
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                ≥ $100
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                ≥ $500
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                ≥ $1k
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(4)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-16 rounded" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-10 w-24 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-10 w-20 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-10 w-20 rounded ml-auto" /></td>
                  <td className="py-3 px-6"><div className="skeleton h-10 w-20 rounded ml-auto" /></td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="py-12 text-center text-soft-gray text-sm">
                  No data available
                </td>
              </tr>
            ) : (
              rows.map((row, i) => {
                const prev = i > 0 ? rows[i - 1] : null;
                return (
                  <tr key={row.monthKey} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                    <td className="py-3 px-6 text-sm text-lavender font-medium whitespace-nowrap">
                      {row.label}
                    </td>
                    <td className="py-3 px-4">
                      <GrowthCell value={row.totalStakers} prev={prev?.totalStakers ?? null} />
                    </td>
                    <td className="py-3 px-4">
                      <GrowthCell value={row.stakers100} prev={prev?.stakers100 ?? null} />
                    </td>
                    <td className="py-3 px-4">
                      <GrowthCell value={row.stakers500} prev={prev?.stakers500 ?? null} />
                    </td>
                    <td className="py-3 px-6">
                      <GrowthCell value={row.stakers1000} prev={prev?.stakers1000 ?? null} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
