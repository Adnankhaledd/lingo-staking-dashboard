import { useState, useMemo } from 'react';
import {
  BarChart,
  Bar,
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
import { formatNumber, formatCurrency } from '../../utils/formatters';

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

interface SummaryData {
  week: string;
  num_claims: number;
  unique_claimers: number;
  total_lingo_claimed: number;
  usd_value: number;
  avg_claim_size: number;
  cumulative_claimed: number;
}

interface ClaimsSummaryChartProps {
  data: SummaryData[];
  isLoading?: boolean;
  lastUpdated?: string | null;
}

type ToggleKey = 'claims' | 'claimers' | 'lingo' | 'usd';
type ViewMode = 'bar' | 'cumulative';
type TimePeriod = 'week' | 'month' | 'quarter' | 'year';

const TOGGLE_CONFIG: Record<ToggleKey, { label: string; color: string; dataKey: string; format: (v: number) => string }> = {
  claims: { label: 'Claims', color: '#7B68AE', dataKey: 'num_claims', format: (v) => formatNumber(v) },
  claimers: { label: 'Unique Claimers', color: '#5EB851', dataKey: 'unique_claimers', format: (v) => formatNumber(v) },
  lingo: { label: 'LINGO Claimed', color: '#E8B100', dataKey: 'total_lingo_claimed', format: (v) => `${formatNumber(v)} LINGO` },
  usd: { label: 'USD Value', color: '#3B82F6', dataKey: 'usd_value', format: (v) => formatCurrency(v) },
};

const PERIOD_OPTIONS: { key: TimePeriod; label: string }[] = [
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'quarter', label: 'Q' },
  { key: 'year', label: 'Y' },
];

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

function aggregateData(data: SummaryData[], period: TimePeriod): SummaryData[] {
  if (period === 'week') return data;

  const buckets = new Map<string, SummaryData>();

  for (const row of data) {
    const key = getGroupKey(row.week, period);
    const existing = buckets.get(key);
    if (existing) {
      existing.num_claims += row.num_claims;
      existing.unique_claimers += row.unique_claimers;
      existing.total_lingo_claimed += row.total_lingo_claimed;
      existing.usd_value += row.usd_value;
    } else {
      buckets.set(key, { ...row, week: key });
    }
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => ({
      ...val,
      week: formatGroupLabel(key, period),
      num_claims: Math.round(val.num_claims),
      unique_claimers: Math.round(val.unique_claimers),
      total_lingo_claimed: Math.round(val.total_lingo_claimed),
      usd_value: Math.round(val.usd_value * 100) / 100,
      avg_claim_size: val.num_claims > 0 ? Math.round(val.total_lingo_claimed / val.num_claims) : 0,
    }));
}

export function ClaimsSummaryChart({ data, isLoading, lastUpdated }: ClaimsSummaryChartProps) {
  const [activeToggles, setActiveToggles] = useState<Set<ToggleKey>>(
    new Set(['lingo'])
  );
  const [period, setPeriod] = useState<TimePeriod>('week');
  const [viewMode, setViewMode] = useState<ViewMode>('bar');

  const chartData = useMemo(() => aggregateData(data, period), [data, period]);

  // Build cumulative data from sorted chartData
  const cumulativeData = useMemo(() => {
    return data
      .slice()
      .sort((a, b) => a.week.localeCompare(b.week))
      .map((row) => {
        const d = new Date(row.week);
        return {
          ...row,
          week: d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
        };
      });
  }, [data]);

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
            {viewMode === 'bar' ? 'Claim Activity' : 'Cumulative Claims'}
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            {viewMode === 'bar'
              ? 'Weekly claiming metrics'
              : 'Running total of LINGO claimed over time'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="flex items-center gap-1 text-xs text-purple-gray" title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}>
              <Clock className="w-3 h-3" />
              <span>{formatLastUpdated(lastUpdated)}</span>
            </div>
          )}

          {/* View mode toggle */}
          <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
            <button
              onClick={() => setViewMode('bar')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                viewMode === 'bar'
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Weekly
            </button>
            <button
              onClick={() => setViewMode('cumulative')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                viewMode === 'cumulative'
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Cumulative
            </button>
          </div>

          {viewMode === 'bar' && (
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
          )}
        </div>
      </div>

      {viewMode === 'bar' && (
        <div className="flex flex-wrap gap-2 mb-5 relative z-10">
          {(Object.entries(TOGGLE_CONFIG) as [ToggleKey, typeof TOGGLE_CONFIG[ToggleKey]][]).map(
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
      )}

      <div className="h-80 relative z-10">
        {viewMode === 'cumulative' ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart
              data={cumulativeData}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            >
              <defs>
                <linearGradient id="cumClaimedGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#E8B100" stopOpacity={0.3} />
                  <stop offset="100%" stopColor="#E8B100" stopOpacity={0} />
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
                  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(0)}M`;
                  if (value >= 1000) return `${(value / 1000).toFixed(0)}K`;
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
                      <div className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#E8B100' }} />
                        <span className="text-soft-gray text-sm">Cumulative:</span>
                        <span className="text-lavender font-medium">
                          {formatNumber(payload[0].value as number)} LINGO
                        </span>
                      </div>
                    </div>
                  );
                }}
              />

              <Area
                type="monotone"
                dataKey="cumulative_claimed"
                stroke="#E8B100"
                strokeWidth={2}
                fill="url(#cumClaimedGrad)"
                animationDuration={800}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={chartData}
              margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
              barCategoryGap="15%"
            >
              <defs>
                {Object.entries(TOGGLE_CONFIG).map(([key, { color }]) => (
                  <linearGradient key={key} id={`summary-${key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={color} stopOpacity={1} />
                    <stop offset="100%" stopColor={color} stopOpacity={0.5} />
                  </linearGradient>
                ))}
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
                      {payload.map((entry, index) => {
                        const toggleKey = Object.entries(TOGGLE_CONFIG).find(
                          ([, v]) => v.dataKey === entry.dataKey
                        );
                        const formatter = toggleKey ? TOGGLE_CONFIG[toggleKey[0] as ToggleKey].format : formatNumber;
                        return (
                          <div key={index} className="flex items-center gap-2 mb-1">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                            <span className="text-soft-gray text-sm">{entry.name}:</span>
                            <span className="text-lavender font-medium">
                              {formatter(entry.value as number)}
                            </span>
                          </div>
                        );
                      })}
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

              {activeToggles.has('claims') && (
                <Bar dataKey="num_claims" name="Claims" fill="url(#summary-claims)" radius={[4, 4, 0, 0]} animationDuration={800} />
              )}
              {activeToggles.has('claimers') && (
                <Bar dataKey="unique_claimers" name="Unique Claimers" fill="url(#summary-claimers)" radius={[4, 4, 0, 0]} animationDuration={800} />
              )}
              {activeToggles.has('lingo') && (
                <Bar dataKey="total_lingo_claimed" name="LINGO Claimed" fill="url(#summary-lingo)" radius={[4, 4, 0, 0]} animationDuration={800} />
              )}
              {activeToggles.has('usd') && (
                <Bar dataKey="usd_value" name="USD Value" fill="url(#summary-usd)" radius={[4, 4, 0, 0]} animationDuration={800} />
              )}
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
