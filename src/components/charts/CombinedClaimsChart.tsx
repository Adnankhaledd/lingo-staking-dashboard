import { useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { Clock } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';

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

interface CombinedRow {
  week: string;  // YYYY-MM-DD
  mainContract: number;
  decubate: number;
  mainCumulative: number;
  decubateCumulative: number;
}

interface CombinedClaimsChartProps {
  data: CombinedRow[];
  isLoading?: boolean;
  lastUpdated?: string | null;
}

type TimePeriod = 'week' | 'month' | 'year' | 'all';

const PERIOD_OPTIONS: { key: TimePeriod; label: string }[] = [
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'year', label: 'Y' },
  { key: 'all', label: 'All Time' },
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface AggRow {
  bucket: string;
  label: string;
  mainContract: number;
  decubate: number;
}

function aggregateData(data: CombinedRow[], period: TimePeriod): AggRow[] {
  if (data.length === 0) return [];

  if (period === 'all') {
    const sorted = [...data].sort((a, b) => a.week.localeCompare(b.week));
    const latest = sorted[sorted.length - 1];
    return [{
      bucket: 'all',
      label: 'All Time',
      mainContract: latest.mainCumulative,
      decubate: latest.decubateCumulative,
    }];
  }

  if (period === 'week') {
    return [...data]
      .sort((a, b) => a.week.localeCompare(b.week))
      .map(row => {
        const [, m, d] = row.week.split('-').map(Number);
        return {
          bucket: row.week,
          label: `${MONTH_NAMES[m - 1]} ${d}`,
          mainContract: row.mainContract,
          decubate: row.decubate,
        };
      });
  }

  const buckets = new Map<string, { main: number; decubate: number }>();
  for (const row of data) {
    const parts = row.week.split('-');
    const year = parts[0];
    const month = parts[1];
    const key = period === 'month' ? `${year}-${month}` : `${year}`;
    const existing = buckets.get(key) ?? { main: 0, decubate: 0 };
    existing.main += row.mainContract;
    existing.decubate += row.decubate;
    buckets.set(key, existing);
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => {
      let label: string;
      if (period === 'month') {
        const [y, m] = key.split('-').map(Number);
        label = `${MONTH_NAMES[m - 1]} '${String(y).slice(2)}`;
      } else {
        label = key;
      }
      return {
        bucket: key,
        label,
        mainContract: Math.round(val.main),
        decubate: Math.round(val.decubate),
      };
    });
}

export function CombinedClaimsChart({ data, isLoading, lastUpdated }: CombinedClaimsChartProps) {
  const [period, setPeriod] = useState<TimePeriod>('week');
  const chartData = useMemo(() => aggregateData(data, period), [data, period]);

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
            Combined Claims
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            Main contract vs Decubate LINGO claimed
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

      <div className="h-80 relative z-10">
        <ResponsiveContainer minWidth={0} width="100%" height={320}>
          <BarChart
            data={chartData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            barCategoryGap="15%"
          >
            <defs>
              <linearGradient id="mainContractGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7B68AE" stopOpacity={1} />
                <stop offset="100%" stopColor="#7B68AE" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="decubateGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#E8B100" stopOpacity={1} />
                <stop offset="100%" stopColor="#E8B100" stopOpacity={0.5} />
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
              interval="preserveStartEnd"
            />

            <YAxis
              tickFormatter={(value) => {
                const abs = Math.abs(value);
                if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
                if (abs >= 1000) return `${(value / 1000).toFixed(0)}K`;
                return `${value}`;
              }}
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              dx={-5}
              width={65}
            />

            <Tooltip
              content={({ active, payload, label }) => {
                if (!active || !payload || !payload.length) return null;
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-2">{String(label || '')}</p>
                    {payload.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-soft-gray text-sm">{entry.name}:</span>
                        <span className="text-lavender font-medium">
                          {formatNumber(entry.value as number)} LINGO
                        </span>
                      </div>
                    ))}
                    {payload.length === 2 && (
                      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
                        <span className="text-soft-gray text-sm">Total:</span>
                        <span className="text-lavender font-semibold">
                          {formatNumber((payload[0].value as number) + (payload[1].value as number))} LINGO
                        </span>
                      </div>
                    )}
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
            />

            <Legend
              wrapperStyle={{ paddingTop: 15 }}
              formatter={(value) => (
                <span className="text-soft-gray text-sm">{value}</span>
              )}
            />

            <Bar
              dataKey="mainContract"
              name="Main Contract"
              fill="url(#mainContractGrad)"
              radius={[4, 4, 0, 0]}
              animationDuration={800}
            />
            <Bar
              dataKey="decubate"
              name="Decubate"
              fill="url(#decubateGrad)"
              radius={[4, 4, 0, 0]}
              animationDuration={800}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
