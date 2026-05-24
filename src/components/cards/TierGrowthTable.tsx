import { useMemo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import type { MonthlyTierGrowthRow } from '../../hooks/useDuneQuery';

interface TierGrowthTableProps {
  data: MonthlyTierGrowthRow[] | null;
  isLoading?: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUTOFF_MONTH_KEY = '2026-01'; // inclusive

// Only the four real engagement tiers — Total / Below-$100 intentionally hidden.
type TierKey = 'member' | 'holder' | 'elite' | 'legend';

const TIERS: Array<{ key: TierKey; label: string; threshold: string; dot: string }> = [
  { key: 'member', label: 'Member', threshold: '$100+',  dot: '#C4B5D4' },
  { key: 'holder', label: 'Holder', threshold: '$250+',  dot: '#5EB851' },
  { key: 'elite',  label: 'Elite',  threshold: '$1k+',   dot: '#FF7847' },
  { key: 'legend', label: 'Legend', threshold: '$2.5k+', dot: '#FFD75E' },
];

interface MonthlyPoint {
  monthKey: string;
  label: string; // "Jan '26"
  member: number;
  holder: number;
  elite: number;
  legend: number;
}

function normalize(rows: MonthlyTierGrowthRow[]): MonthlyPoint[] {
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
        member: row['member ($100+)'] ?? 0,
        holder: row['holder ($250+)'] ?? 0,
        elite:  row['elite ($1000+)'] ?? 0,
        legend: row['legend ($2500+)'] ?? 0,
      };
    });
}

/**
 * Map a percent change to a heatmap background colour. Greater magnitude →
 * deeper tint. Returns inline-style background so we can mix arbitrary alpha.
 */
function heatmapBg(pct: number | null): { background: string } {
  if (pct == null || !Number.isFinite(pct)) {
    return { background: 'transparent' };
  }
  // Clamp at ±25% so the scale doesn't get washed out by huge outliers.
  const clamped = Math.max(-25, Math.min(25, pct));
  const intensity = Math.abs(clamped) / 25; // 0..1
  if (clamped > 0) {
    // green1 #5EB851 → rgba(94,184,81, α)
    return { background: `rgba(94, 184, 81, ${(intensity * 0.35).toFixed(3)})` };
  }
  if (clamped < 0) {
    // red-400 ish → rgba(248,113,113, α)
    return { background: `rgba(248, 113, 113, ${(intensity * 0.35).toFixed(3)})` };
  }
  return { background: 'rgba(255,255,255,0.02)' };
}

function HeatmapCell({ value, prev }: { value: number; prev: number | null }) {
  const delta = prev != null ? value - prev : null;
  const pct = prev != null && prev > 0 ? ((value - prev) / prev) * 100 : null;
  const style = heatmapBg(pct);
  const isUp = (delta ?? 0) > 0;
  const isDown = (delta ?? 0) < 0;
  const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
  const deltaColor = isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-purple-gray';

  return (
    <td className="py-3 px-4 text-right transition-colors" style={style}>
      <div className="font-semibold text-lavender text-base leading-tight">
        {formatNumber(value)}
      </div>
      {delta == null || pct == null ? (
        <div className="text-[10px] text-purple-gray mt-0.5">—</div>
      ) : (
        <div className={`text-[11px] mt-0.5 flex items-center justify-end gap-0.5 ${deltaColor}`}>
          <Icon className="w-2.5 h-2.5" />
          <span className="font-semibold">{isUp ? '+' : isDown ? '−' : ''}{Math.abs(delta).toLocaleString()}</span>
          <span className="text-purple-gray font-medium ml-1">({isUp ? '+' : isDown ? '−' : ''}{Math.abs(pct).toFixed(1)}%)</span>
        </div>
      )}
    </td>
  );
}

export function TierGrowthTable({ data, isLoading }: TierGrowthTableProps) {
  const rows = useMemo(() => (data ? normalize(data) : []), [data]);

  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10 flex items-baseline justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Tier Growth (Monthly)</h3>
          <p className="text-sm text-soft-gray mt-1">
            Cells are tinted by month-over-month change &middot; deeper green = stronger growth, deeper red = bigger drop
          </p>
        </div>
        {/* Legend strip */}
        <div className="flex items-center gap-2 text-[11px] text-purple-gray">
          <span>−25%+</span>
          <span className="inline-flex h-3 rounded-sm overflow-hidden border border-white/[0.06]">
            <span className="w-4" style={{ background: 'rgba(248,113,113,0.35)' }} />
            <span className="w-4" style={{ background: 'rgba(248,113,113,0.18)' }} />
            <span className="w-4" style={{ background: 'rgba(255,255,255,0.02)' }} />
            <span className="w-4" style={{ background: 'rgba(94,184,81,0.18)' }} />
            <span className="w-4" style={{ background: 'rgba(94,184,81,0.35)' }} />
          </span>
          <span>+25%+</span>
        </div>
      </div>

      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[640px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Month
              </th>
              {TIERS.map(t => (
                <th
                  key={t.key}
                  className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4"
                >
                  <span className="inline-flex items-center gap-1.5 justify-end">
                    <span className="w-2 h-2 rounded-full" style={{ backgroundColor: t.dot }} />
                    {t.label}
                    <span className="text-[10px] text-purple-gray font-normal normal-case">{t.threshold}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(4)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-16 rounded" /></td>
                  {[...Array(4)].map((__, j) => (
                    <td key={j} className="py-3 px-4"><div className="skeleton h-10 w-20 rounded ml-auto" /></td>
                  ))}
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
                  <tr key={row.monthKey} className="border-b border-white/5">
                    <td className="py-3 px-6 text-sm text-lavender font-medium whitespace-nowrap">
                      {row.label}
                    </td>
                    {TIERS.map(t => (
                      <HeatmapCell
                        key={t.key}
                        value={row[t.key]}
                        prev={prev ? prev[t.key] : null}
                      />
                    ))}
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
