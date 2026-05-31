import { useMemo, useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { formatNumber } from '../../utils/formatters';
import type { TotalStakedRow } from '../../hooks/useDuneQuery';

interface TotalStakedHeroChartProps {
  data: TotalStakedRow[] | null;
  liveTotalStaked: number | null;
  isLoading?: boolean;
}

type Period = 'week' | 'month' | 'quarter';

const PERIOD_OPTIONS: Array<{ key: Period; label: string }> = [
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'quarter', label: 'Q' },
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Point {
  bucketKey: string;
  label: string;
  total: number;
}

function bucketKey(dayISO: string, period: Period): string {
  const [yStr, mStr, dStr] = dayISO.split('-');
  const y = parseInt(yStr, 10);
  const m = parseInt(mStr, 10);
  const d = parseInt(dStr, 10);
  if (period === 'month') return `${yStr}-${mStr}`;
  if (period === 'quarter') {
    const q = Math.floor((m - 1) / 3) + 1;
    return `${yStr}-Q${q}`;
  }
  // week — group by ISO-ish Monday-anchored week
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

function bucketLabel(key: string, period: Period): string {
  if (period === 'month') {
    const [y, m] = key.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} '${String(y).slice(2)}`;
  }
  if (period === 'quarter') return key; // "2026-Q2"
  // week — render as month + day of Monday
  const [y, m, d] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/**
 * Aggregate daily total_staked snapshots into the chosen period.
 * Each bucket's value is the LATEST day in that bucket — i.e. a period-end
 * snapshot of the cumulative balance, which is what makes sense for a
 * running-total chart.
 */
function aggregate(rows: TotalStakedRow[], period: Period): Point[] {
  if (!rows || rows.length === 0) return [];
  const buckets = new Map<string, { day: string; total: number }>();
  for (const row of rows) {
    const day = (row.day ?? '').split(/[T\s]/)[0];
    if (!day) continue;
    const key = bucketKey(day, period);
    const existing = buckets.get(key);
    if (!existing || day > existing.day) {
      buckets.set(key, { day, total: row.total_staked });
    }
  }
  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => ({
      bucketKey: key,
      label: bucketLabel(key, period),
      total: Math.round(val.total),
    }));
}

export function TotalStakedHeroChart({ data, liveTotalStaked, isLoading }: TotalStakedHeroChartProps) {
  const [period, setPeriod] = useState<Period>('month');

  const points = useMemo(() => aggregate(data ?? [], period), [data, period]);

  // Headline totals: prefer live balance for the big number; period-over-period
  // change is computed from the aggregated series so it always matches the toggle.
  const latestRow = data?.[data.length - 1] ?? null;
  const displayTotal = liveTotalStaked ?? Math.round(latestRow?.total_staked ?? 0);

  const { delta, pct } = useMemo(() => {
    if (points.length < 2) return { delta: null as number | null, pct: null as number | null };
    const last = points[points.length - 1].total;
    const prev = points[points.length - 2].total;
    const d = last - prev;
    const p = prev > 0 ? (d / prev) * 100 : null;
    return { delta: d, pct: p };
  }, [points]);

  const deltaLabel = period === 'week' ? 'WoW' : period === 'month' ? 'MoM' : 'QoQ';

  if (isLoading) {
    return (
      <div className="flagship-card p-6 rounded-2xl">
        <div className="skeleton h-5 w-40 rounded mb-3" />
        <div className="skeleton h-12 w-64 rounded mb-4" />
        <div className="skeleton h-[280px] w-full rounded" />
      </div>
    );
  }

  return (
    <div className="flagship-card p-6 rounded-2xl">
      <div className="relative z-10">
        {/* Header row */}
        <div className="flex items-start justify-between gap-3 flex-wrap mb-2">
          <div>
            <h3 className="text-[11px] text-soft-gray font-medium uppercase tracking-wider">
              Total LINGO Staked
            </h3>
            <p className="text-xs text-purple-gray mt-1">
              Period-end snapshots &middot; {points.length > 0 ? `${points[0].label} → ${points[points.length - 1].label}` : '—'}
            </p>
          </div>

          <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
            {PERIOD_OPTIONS.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setPeriod(key)}
                className={`px-3 py-1.5 text-xs font-medium transition-all ${
                  period === key
                    ? 'bg-purple/30 text-white'
                    : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* Big total + period delta chip */}
        <div className="flex items-end gap-3 flex-wrap mb-5">
          <span className="text-5xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent tracking-tight leading-none">
            {displayTotal.toLocaleString()}
          </span>
          <span className="text-sm text-soft-gray pb-1">LINGO</span>
          {liveTotalStaked !== null && (
            <span className="text-[10px] font-medium text-green1 bg-green1/10 px-1.5 py-0.5 rounded-full uppercase tracking-wider pb-0.5">
              Live
            </span>
          )}
          {delta != null && pct != null && (
            <span
              className={`text-sm font-semibold px-2.5 py-1 rounded-lg ml-auto ${
                delta >= 0 ? 'text-green1 bg-green1/10' : 'text-red-400 bg-red-400/10'
              }`}
            >
              {delta >= 0 ? '+' : ''}{formatNumber(delta)}
              <span className="text-xs ml-1">({delta >= 0 ? '+' : ''}{pct.toFixed(1)}%)</span>
              <span className="text-purple-gray font-medium ml-1">{deltaLabel}</span>
            </span>
          )}
        </div>

        {/* Area chart */}
        <div className="h-[280px]">
          {points.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="heroStakedGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#FFD75E" stopOpacity={0.45} />
                    <stop offset="100%" stopColor="#FFD75E" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis
                  dataKey="label"
                  stroke="rgba(255,255,255,0.15)"
                  tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  interval="preserveStartEnd"
                  dy={6}
                />
                <YAxis
                  stroke="rgba(255,255,255,0.15)"
                  tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v) => formatNumber(Number(v))}
                  width={70}
                />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(20,20,31,0.95)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '8px',
                    fontSize: '12px',
                  }}
                  labelStyle={{ color: 'rgba(255,255,255,0.5)' }}
                  formatter={(value) => [formatNumber(Number(value ?? 0)) + ' LINGO', 'Total Staked']}
                />
                <Area
                  type="monotone"
                  dataKey="total"
                  stroke="#FFD75E"
                  strokeWidth={2.5}
                  fill="url(#heroStakedGradient)"
                  activeDot={{ r: 4, fill: '#FFD75E' }}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-full flex items-center justify-center text-soft-gray text-sm">
              No data available
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
