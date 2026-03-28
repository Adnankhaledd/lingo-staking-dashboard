import { useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts';
import { formatNumber } from '../../utils/formatters';
import { parseDuneDate } from '../../utils/dataTransformers';
import type { TotalStakedRow } from '../../hooks/useDuneQuery';

type Period = 'week' | 'month' | 'quarter' | 'year';

interface BarDataPoint {
  label: string;
  total: number;
  changePct: number | null;
  isCurrent: boolean;
}

function buildBarData(data: TotalStakedRow[], period: Period): BarDataPoint[] {
  if (!data || data.length < 2) return [];

  const sorted = [...data].sort((a, b) =>
    parseDuneDate(a.day).localeCompare(parseDuneDate(b.day))
  );

  // Group data into buckets based on period
  const buckets = new Map<string, { total: number; date: Date }>();

  for (const row of sorted) {
    const date = new Date(parseDuneDate(row.day));
    let key: string;

    switch (period) {
      case 'week': {
        // ISO week: get Monday of the week
        const d = new Date(date);
        const day = d.getDay();
        const diff = d.getDate() - day + (day === 0 ? -6 : 1);
        d.setDate(diff);
        key = d.toISOString().split('T')[0];
        break;
      }
      case 'month':
        key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        break;
      case 'quarter': {
        const q = Math.floor(date.getMonth() / 3) + 1;
        key = `${date.getFullYear()}-Q${q}`;
        break;
      }
      case 'year':
        key = `${date.getFullYear()}`;
        break;
    }

    // Always take the latest value in each bucket (total_staked is cumulative)
    buckets.set(key, { total: row.total_staked, date });
  }

  const sortedBuckets = Array.from(buckets.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  );

  // Show all data from the start
  const recent = sortedBuckets;

  return recent.map(([key, { total, date }], index) => {
    let label: string;
    switch (period) {
      case 'week':
        label = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        break;
      case 'month':
        label = date.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
        break;
      case 'quarter': {
        const parts = key.split('-');
        label = `${parts[1]} '${parts[0].slice(2)}`;
        break;
      }
      case 'year':
        label = key;
        break;
    }

    const prevTotal = index > 0 ? recent[index - 1][1].total : null;
    const changePct = prevTotal !== null && prevTotal > 0
      ? ((total - prevTotal) / prevTotal) * 100
      : null;

    return {
      label,
      total,
      changePct,
      isCurrent: index === recent.length - 1,
    };
  });
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

interface StakingUpdateCardProps {
  data: TotalStakedRow[] | null;
  isLoading: boolean;
}

export function StakingUpdateCard({ data, isLoading }: StakingUpdateCardProps) {
  const [period, setPeriod] = useState<Period>('week');

  const barData = useMemo(() => {
    if (!data) return [];
    return buildBarData(data, period);
  }, [data, period]);

  // Absolute latest total from raw data (matches the overview KPI)
  const currentTotal = useMemo(() => {
    if (!data || data.length === 0) return 0;
    const sorted = [...data].sort((a, b) =>
      parseDuneDate(a.day).localeCompare(parseDuneDate(b.day))
    );
    return sorted[sorted.length - 1].total_staked;
  }, [data]);

  // Use last completed bar for the % change comparison
  const latestChange = barData.length > 0 ? barData[barData.length - 1] : null;
  const prevBar = barData.length > 1 ? barData[barData.length - 2] : null;

  if (isLoading) {
    return (
      <div className="flagship-card p-6">
        <div className="skeleton h-4 w-40 rounded mb-4" />
        <div className="skeleton h-[300px] w-full rounded" />
      </div>
    );
  }

  if (barData.length === 0) return null;

  const isUp = (latestChange?.changePct ?? 0) > 0;
  const isDown = (latestChange?.changePct ?? 0) < 0;
  const TrendIcon = isUp ? TrendingUp : isDown ? TrendingDown : Minus;
  const trendColor = isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-gray-400';
  const trendBg = isUp ? 'bg-green1/10' : isDown ? 'bg-red-400/10' : 'bg-gray-400/10';

  const change = latestChange && prevBar
    ? latestChange.total - prevBar.total
    : 0;

  return (
    <div className="flagship-card p-6 group transition-all duration-300">
      {/* Gradient accent on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple/5 to-light1/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />

      <div className="relative z-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[11px] text-soft-gray font-medium uppercase tracking-wider">
            Staking Update
          </h3>
          <div className="flex gap-1 bg-card-bg/60 rounded-lg p-0.5 border border-white/5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-200 ${
                  period === opt.value
                    ? 'bg-purple/20 text-lavender shadow-sm'
                    : 'text-purple-gray hover:text-lavender hover:bg-white/5'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Hero number — centered, full amount */}
        <div className="flex flex-col items-center gap-2 my-5">
          <div className="flex items-baseline gap-2">
            <span className="text-4xl sm:text-5xl lg:text-6xl font-bold bg-gradient-to-r from-purple via-light1 to-lavender bg-clip-text text-transparent tracking-tight">
              {Math.round(currentTotal).toLocaleString('en-US')}
            </span>
            <span className="text-base sm:text-lg text-purple-gray font-medium">LINGO</span>
          </div>

          {latestChange?.changePct !== null && latestChange?.changePct !== undefined && (
            <div className="flex items-center gap-3">
              <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${trendBg}`}>
                <TrendIcon className={`w-4 h-4 ${trendColor}`} />
                <span className={`text-sm font-semibold ${trendColor}`}>
                  {isUp ? '+' : ''}{latestChange.changePct.toFixed(2)}%
                </span>
              </div>
              <span className="text-sm text-purple-gray">
                {change > 0 ? '+' : ''}{Math.round(Math.abs(change)).toLocaleString('en-US')} LINGO
              </span>
            </div>
          )}
        </div>

        {/* Bar Chart */}
        <ResponsiveContainer minWidth={0} width="100%" height={280}>
          <BarChart
            data={barData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            barCategoryGap="18%"
          >
            <defs>
              <linearGradient id="stakingBarGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7B68AE" stopOpacity={1} />
                <stop offset="100%" stopColor="#7B68AE" stopOpacity={0.4} />
              </linearGradient>
              <linearGradient id="stakingBarCurrentGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#C4B5D4" stopOpacity={1} />
                <stop offset="100%" stopColor="#C4B5D4" stopOpacity={0.5} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.04)"
              vertical={false}
            />

            <XAxis
              dataKey="label"
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              dy={10}
            />

            <YAxis
              tickFormatter={(value) => formatNumber(value, 0)}
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              dx={-10}
              width={55}
              domain={['dataMin - dataMin * 0.02', 'dataMax + dataMax * 0.01']}
            />

            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null;
                const d = payload[0].payload as BarDataPoint;
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-1.5">{label}</p>
                    <p className="text-lavender font-semibold text-lg mb-1">
                      {formatNumber(d.total, 1)} LINGO
                    </p>
                    {d.changePct !== null && (
                      <p className={`text-xs font-medium ${d.changePct >= 0 ? 'text-green1' : 'text-red-400'}`}>
                        {d.changePct >= 0 ? '+' : ''}{d.changePct.toFixed(2)}% vs prev {period}
                      </p>
                    )}
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
            />

            <Bar
              dataKey="total"
              radius={[6, 6, 0, 0]}
              animationDuration={800}
              animationEasing="ease-out"
            >
              {barData.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.isCurrent ? 'url(#stakingBarCurrentGradient)' : 'url(#stakingBarGradient)'}
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
