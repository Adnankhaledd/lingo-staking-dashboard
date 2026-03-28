import { useState, useMemo } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Clock } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { parseDuneDate } from '../../utils/dataTransformers';
import type { WeeklyLockBreakdownRow } from '../../hooks/useDuneQuery';

interface WeeklyLockChartProps {
  data: WeeklyLockBreakdownRow[] | null;
  isLoading?: boolean;
  lastUpdated?: string | null;
}

type ToggleKey = 'flexible' | '3mo' | '6mo' | '12mo';
type TimePeriod = 'week' | 'month' | 'quarter' | 'year';

const TOGGLE_CONFIG: Record<ToggleKey, { label: string; color: string }> = {
  flexible: { label: 'Flexible', color: '#7B68AE' },
  '3mo': { label: '3 Month', color: '#C4B5D4' },
  '6mo': { label: '6 Month', color: '#5EB851' },
  '12mo': { label: '12 Month', color: '#FF7847' },
};

const PERIOD_OPTIONS: { key: TimePeriod; label: string }[] = [
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'quarter', label: 'Q' },
  { key: 'year', label: 'Y' },
];

interface ChartRow {
  week: string;
  flexible: number;
  threeMonth: number;
  sixMonth: number;
  twelveMonth: number;
  total: number;
}

function formatLastUpdated(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getGroupKey(dateStr: string, period: TimePeriod): string {
  const d = new Date(dateStr);
  const year = d.getFullYear();
  const month = d.getMonth();
  switch (period) {
    case 'week':
      return dateStr;
    case 'month':
      return `${year}-${String(month + 1).padStart(2, '0')}`;
    case 'quarter': {
      const q = Math.floor(month / 3) + 1;
      return `${year}-Q${q}`;
    }
    case 'year':
      return `${year}`;
  }
}

function formatGroupLabel(key: string, period: TimePeriod): string {
  switch (period) {
    case 'week': {
      const d = new Date(key);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
    case 'month': {
      const [y, m] = key.split('-');
      const d = new Date(parseInt(y), parseInt(m) - 1);
      return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
    }
    case 'quarter':
      return key;
    case 'year':
      return key;
  }
}

function aggregateData(data: ChartRow[], period: TimePeriod): ChartRow[] {
  if (period === 'week') return data;

  // Snapshot data — take latest in each period
  const buckets = new Map<string, ChartRow>();
  for (const row of data) {
    const key = getGroupKey(row.week, period);
    buckets.set(key, { ...row, week: key });
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => ({
      ...val,
      week: formatGroupLabel(key, period),
    }));
}

export function WeeklyLockChart({ data, isLoading, lastUpdated }: WeeklyLockChartProps) {
  const [activeToggles, setActiveToggles] = useState<Set<ToggleKey>>(
    new Set(['flexible', '3mo', '6mo', '12mo'])
  );
  const [period, setPeriod] = useState<TimePeriod>('week');

  // Transform raw data
  const transformedData = useMemo(() => {
    if (!data || data.length === 0) return [];
    return [...data]
      .sort((a, b) => parseDuneDate(a.week).localeCompare(parseDuneDate(b.week)))
      .map(row => ({
        week: parseDuneDate(row.week),
        flexible: Math.round(row.flexible_staked),
        threeMonth: Math.round(row['3mo_staked']),
        sixMonth: Math.round(row['6mo_staked']),
        twelveMonth: Math.round(row['12mo_staked']),
        total: Math.round(row.total_staked),
      }));
  }, [data]);

  const chartData = useMemo(() => aggregateData(transformedData, period), [transformedData, period]);

  // WoW summary from raw sorted data
  const summaryData = useMemo(() => {
    if (transformedData.length < 2) return null;
    const latest = transformedData[transformedData.length - 1];
    const prev = transformedData[transformedData.length - 2];

    const calc = (curr: number, previous: number) => ({
      value: curr,
      change: previous > 0 ? ((curr - previous) / previous) * 100 : 0,
      absolute: curr - previous,
    });

    return {
      flexible: calc(latest.flexible, prev.flexible),
      '3mo': calc(latest.threeMonth, prev.threeMonth),
      '6mo': calc(latest.sixMonth, prev.sixMonth),
      '12mo': calc(latest.twelveMonth, prev.twelveMonth),
    };
  }, [transformedData]);

  const toggleSeries = (key: ToggleKey) => {
    setActiveToggles(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  if (isLoading) {
    return (
      <div className="flagship-card rounded-2xl p-6">
        <div className="skeleton h-6 w-48 rounded mb-2 relative z-10" />
        <div className="skeleton h-4 w-32 rounded mb-6 relative z-10" />
        <div className="skeleton h-80 w-full rounded-xl relative z-10" />
      </div>
    );
  }

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="flex items-start justify-between mb-4 relative z-10">
        <div>
          <h3 className="text-lg font-semibold text-lavender">
            Staked LINGO by Lock Duration
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            Weekly breakdown of LINGO staked per lock period
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="flex items-center gap-1 text-xs text-purple-gray" title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}>
              <Clock className="w-3 h-3" />
              <span>{formatLastUpdated(lastUpdated)}</span>
            </div>
          )}
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
      </div>

      {/* WoW Summary Cards */}
      {summaryData && (
        <div className="grid grid-cols-4 gap-3 mb-5 relative z-10">
          {(Object.entries(TOGGLE_CONFIG) as [ToggleKey, { label: string; color: string }][]).map(
            ([key, { label, color }]) => {
              const s = summaryData[key];
              return (
                <div
                  key={key}
                  className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3"
                >
                  <div className="flex items-center gap-2 mb-1">
                    <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
                    <span className="text-xs text-soft-gray">{label}</span>
                  </div>
                  <div className="text-lg font-bold text-lavender">
                    {formatNumber(s.value)}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-xs font-medium ${s.change >= 0 ? 'text-green1' : 'text-red-400'}`}>
                      {s.change >= 0 ? '+' : ''}{s.change.toFixed(1)}%
                    </span>
                    <span className="text-xs text-purple-gray">
                      {s.absolute >= 0 ? '+' : ''}{formatNumber(s.absolute)}
                    </span>
                    <span className="text-xs text-purple-gray">WoW</span>
                  </div>
                </div>
              );
            }
          )}
        </div>
      )}

      {/* Series toggle buttons */}
      <div className="flex gap-2 mb-5 relative z-10">
        {(Object.entries(TOGGLE_CONFIG) as [ToggleKey, { label: string; color: string }][]).map(
          ([key, { label, color }]) => {
            const isActive = activeToggles.has(key);
            return (
              <button
                key={key}
                onClick={() => toggleSeries(key)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                  isActive
                    ? 'bg-white/10 text-white border border-white/20'
                    : 'bg-white/[0.03] text-soft-gray border border-white/[0.06] opacity-50 hover:opacity-75'
                }`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-sm"
                  style={{ backgroundColor: isActive ? color : 'rgba(255,255,255,0.2)' }}
                />
                {label}
              </button>
            );
          }
        )}
      </div>

      <div className="h-80 relative z-10">
        <ResponsiveContainer minWidth={0} width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="lockFlexGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7B68AE" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#7B68AE" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="lock3moGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#C4B5D4" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#C4B5D4" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="lock6moGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5EB851" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#5EB851" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="lock12moGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FF7847" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#FF7847" stopOpacity={0.02} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.04)"
              vertical={false}
            />

            <XAxis
              dataKey="week"
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              dy={10}
              interval="preserveStartEnd"
            />

            <YAxis
              tickFormatter={(value) => {
                if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
                if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
                return `${value}`;
              }}
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              dx={-5}
              width={55}
            />

            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null;
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-2">
                      {String(label || '')}
                    </p>
                    {payload.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2 mb-1">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="text-soft-gray text-sm">{entry.name}:</span>
                        <span className="text-lavender font-medium">
                          {formatNumber(entry.value as number)} LINGO
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
              cursor={{ stroke: 'rgba(255,255,255,0.1)' }}
            />

            <Legend
              wrapperStyle={{ paddingTop: 15 }}
              formatter={(value) => (
                <span className="text-soft-gray text-sm">{value}</span>
              )}
            />

            {activeToggles.has('flexible') && (
              <Area
                type="monotone"
                dataKey="flexible"
                name="Flexible"
                stroke="#7B68AE"
                strokeWidth={2}
                fill="url(#lockFlexGrad)"
                stackId="lock"
                animationDuration={800}
              />
            )}

            {activeToggles.has('3mo') && (
              <Area
                type="monotone"
                dataKey="threeMonth"
                name="3 Month"
                stroke="#C4B5D4"
                strokeWidth={2}
                fill="url(#lock3moGrad)"
                stackId="lock"
                animationDuration={800}
              />
            )}

            {activeToggles.has('6mo') && (
              <Area
                type="monotone"
                dataKey="sixMonth"
                name="6 Month"
                stroke="#5EB851"
                strokeWidth={2}
                fill="url(#lock6moGrad)"
                stackId="lock"
                animationDuration={800}
              />
            )}

            {activeToggles.has('12mo') && (
              <Area
                type="monotone"
                dataKey="twelveMonth"
                name="12 Month"
                stroke="#FF7847"
                strokeWidth={2}
                fill="url(#lock12moGrad)"
                stackId="lock"
                animationDuration={800}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
