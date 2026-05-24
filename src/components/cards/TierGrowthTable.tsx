import { useMemo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import type { MonthlyTierGrowthRow } from '../../hooks/useDuneQuery';

interface TierGrowthTableProps {
  data: MonthlyTierGrowthRow[] | null;
  isLoading?: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUTOFF_MONTH_KEY = '2026-01'; // inclusive — table starts from Jan 2026

interface MonthlyRow {
  monthKey: string;       // "YYYY-MM"
  label: string;          // "Jan '26"
  totalStakers: number;
  below100: number;
  member: number;         // $100+
  holder: number;         // $250+
  elite: number;          // $1000+
  legend: number;         // $2500+
}

/** Normalize the Dune rows to a tidy local shape and filter to Jan 2026 onward. */
function normalize(rows: MonthlyTierGrowthRow[]): MonthlyRow[] {
  return rows
    .map(row => {
      const monthKey = (row.month ?? '').split(/[T\s]/)[0].slice(0, 7);
      return { row, monthKey };
    })
    .filter(({ monthKey }) => monthKey >= CUTOFF_MONTH_KEY)
    .sort((a, b) => a.monthKey.localeCompare(b.monthKey))
    .map(({ row, monthKey }) => {
      const [, m] = monthKey.split('-').map(Number);
      const yearShort = monthKey.slice(2, 4);
      return {
        monthKey,
        label: `${MONTH_NAMES[m - 1]} '${yearShort}`,
        totalStakers: row.total_stakers ?? 0,
        below100: row['below $100'] ?? 0,
        member: row['member ($100+)'] ?? 0,
        holder: row['holder ($250+)'] ?? 0,
        elite: row['elite ($1000+)'] ?? 0,
        legend: row['legend ($2500+)'] ?? 0,
      };
    });
}

/** Inline cell: big number on top, small Δ + % below (em-dash for first row). */
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
  const rows = useMemo(() => (data ? normalize(data) : []), [data]);

  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">Tier Growth (Monthly)</h3>
        <p className="text-sm text-soft-gray mt-1">
          Month-over-month staker counts by named tier, from Jan 2026 onward
        </p>
      </div>

      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[820px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Month
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Total Stakers
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Below $100
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Member ($100+)
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Holder ($250+)
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Elite ($1k+)
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Legend ($2.5k+)
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(4)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-16 rounded" /></td>
                  {[...Array(6)].map((__, j) => (
                    <td key={j} className="py-3 px-4"><div className="skeleton h-10 w-20 rounded ml-auto" /></td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-soft-gray text-sm">
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
                      <GrowthCell value={row.below100} prev={prev?.below100 ?? null} />
                    </td>
                    <td className="py-3 px-4">
                      <GrowthCell value={row.member} prev={prev?.member ?? null} />
                    </td>
                    <td className="py-3 px-4">
                      <GrowthCell value={row.holder} prev={prev?.holder ?? null} />
                    </td>
                    <td className="py-3 px-4">
                      <GrowthCell value={row.elite} prev={prev?.elite ?? null} />
                    </td>
                    <td className="py-3 px-6">
                      <GrowthCell value={row.legend} prev={prev?.legend ?? null} />
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
