import { useMemo } from 'react';
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';
import { AreaChart, Area, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { formatNumber } from '../../utils/formatters';
import type { MonthlyTierGrowthRow } from '../../hooks/useDuneQuery';

interface TierGrowthTableProps {
  data: MonthlyTierGrowthRow[] | null;
  isLoading?: boolean;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CUTOFF_MONTH_KEY = '2026-01';

// The four "real" engagement tiers (Total + Below-$100 intentionally hidden).
type TierKey = 'member' | 'holder' | 'elite' | 'legend';

const TIERS: Array<{
  key: TierKey;
  label: string;
  threshold: string;
  color: string;
  gradientId: string;
}> = [
  { key: 'member', label: 'Member', threshold: '$100+',  color: '#C4B5D4', gradientId: 'tierGradMember' },
  { key: 'holder', label: 'Holder', threshold: '$250+',  color: '#5EB851', gradientId: 'tierGradHolder' },
  { key: 'elite',  label: 'Elite',  threshold: '$1k+',   color: '#FF7847', gradientId: 'tierGradElite'  },
  { key: 'legend', label: 'Legend', threshold: '$2.5k+', color: '#FFD75E', gradientId: 'tierGradLegend' },
];

interface MonthlyPoint {
  monthKey: string;
  label: string;       // "Jan '26"
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

function ChangeChip({ delta, pct }: { delta: number; pct: number }) {
  const isUp = delta > 0;
  const isDown = delta < 0;
  const Icon = isUp ? ArrowUp : isDown ? ArrowDown : Minus;
  const bg = isUp ? 'bg-green1/15 border-green1/30 text-green1'
    : isDown ? 'bg-red-400/15 border-red-400/30 text-red-400'
    : 'bg-white/[0.04] border-white/[0.08] text-soft-gray';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-semibold border ${bg}`}>
      <Icon className="w-3 h-3" />
      {isUp ? '+' : isDown ? '−' : ''}{Math.abs(delta).toLocaleString()}
      <span className="text-purple-gray font-medium ml-0.5">({isUp ? '+' : isDown ? '−' : ''}{Math.abs(pct).toFixed(1)}%)</span>
    </span>
  );
}

/** Compact area sparkline showing the full trajectory of a tier since cutoff. */
function TierSparkline({
  points,
  tierKey,
  color,
  gradientId,
}: {
  points: MonthlyPoint[];
  tierKey: TierKey;
  color: string;
  gradientId: string;
}) {
  return (
    <ResponsiveContainer width="100%" height={80}>
      <AreaChart data={points} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.45} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        {/* Axes are hidden visually but still inform the layout for the tooltip. */}
        <XAxis dataKey="label" hide />
        <YAxis hide domain={['dataMin', 'dataMax']} />
        <Tooltip
          cursor={{ stroke: 'rgba(255,255,255,0.1)', strokeDasharray: '3 3' }}
          contentStyle={{
            background: 'rgba(20,20,31,0.95)',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: '8px',
            fontSize: '12px',
          }}
          formatter={(value: number) => [formatNumber(value), '']}
          labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
          itemStyle={{ color }}
          separator=""
        />
        <Area
          type="monotone"
          dataKey={tierKey}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          dot={false}
          activeDot={{ r: 3, fill: color }}
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

function TierCard({
  label, threshold, color, gradientId,
  current, prev, points, tierKey,
}: {
  label: string;
  threshold: string;
  color: string;
  gradientId: string;
  current: number;
  prev: number | null;
  points: MonthlyPoint[];
  tierKey: TierKey;
}) {
  const delta = prev != null ? current - prev : 0;
  const pct = prev && prev > 0 ? (delta / prev) * 100 : 0;

  return (
    <div className="flagship-card p-5 group transition-all duration-300 hover:scale-[1.01]">
      <div
        className="absolute -top-12 -right-12 w-24 h-24 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ backgroundColor: `${color}25` }}
      />
      <div className="relative z-10">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: color }} />
            <span className="text-sm font-semibold text-lavender">{label}</span>
            <span className="text-xs text-purple-gray">{threshold}</span>
          </div>
        </div>

        <div className="flex items-baseline justify-between gap-2 mb-2">
          <span className="text-3xl font-bold text-lavender tracking-tight">
            {formatNumber(current)}
          </span>
          {prev != null ? <ChangeChip delta={delta} pct={pct} /> : (
            <span className="text-xs text-purple-gray">—</span>
          )}
        </div>

        <div className="h-20 -mx-1">
          {points.length > 1 ? (
            <TierSparkline points={points} tierKey={tierKey} color={color} gradientId={gradientId} />
          ) : (
            <div className="h-full flex items-center justify-center text-xs text-purple-gray">
              Need ≥2 months for trend
            </div>
          )}
        </div>

        {points.length > 0 && (
          <p className="text-[10px] text-purple-gray mt-1 text-center">
            {points[0].label} → {points[points.length - 1].label}
          </p>
        )}
      </div>
    </div>
  );
}

export function TierGrowthTable({ data, isLoading }: TierGrowthTableProps) {
  const points = useMemo(() => (data ? normalize(data) : []), [data]);
  const latest = points[points.length - 1] ?? null;
  const prev = points.length > 1 ? points[points.length - 2] : null;

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="flagship-card p-5">
            <div className="skeleton h-4 w-24 rounded mb-3" />
            <div className="skeleton h-8 w-20 rounded mb-3" />
            <div className="skeleton h-20 w-full rounded" />
          </div>
        ))}
      </div>
    );
  }

  if (points.length === 0) {
    return (
      <div className="flagship-card p-12 text-center text-soft-gray text-sm">
        No tier data available yet
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between mb-3 px-1">
        <h3 className="text-lg font-semibold text-lavender">Tier Growth</h3>
        <p className="text-xs text-purple-gray">
          Monthly snapshots since Jan 2026 &bull; hover sparklines for values
        </p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {TIERS.map(tier => (
          <TierCard
            key={tier.key}
            label={tier.label}
            threshold={tier.threshold}
            color={tier.color}
            gradientId={tier.gradientId}
            current={latest ? latest[tier.key] : 0}
            prev={prev ? prev[tier.key] : null}
            points={points}
            tierKey={tier.key}
          />
        ))}
      </div>
    </div>
  );
}
