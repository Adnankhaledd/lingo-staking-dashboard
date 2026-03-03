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

interface StakerTiersData {
  week: string;
  stakers100: number;
  stakers500: number;
  stakers1000: number;
  totalStakers: number;
}

interface StakerTiersChartProps {
  data: StakerTiersData[];
  isLoading?: boolean;
}

type ToggleKey = 's100' | 's500' | 's1000';
type TimePeriod = 'week' | 'month' | 'quarter' | 'year';

const TOGGLE_CONFIG: Record<ToggleKey, { label: string; color: string; dataKey: keyof StakerTiersData }> = {
  s1000: { label: '$1,000+', color: '#F59E0B', dataKey: 'stakers1000' },
  s500: { label: '$500+', color: '#8B5CF6', dataKey: 'stakers500' },
  s100: { label: '$100+', color: '#3B82F6', dataKey: 'stakers100' },
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

function aggregateData(data: StakerTiersData[], period: TimePeriod): StakerTiersData[] {
  if (period === 'week') return data;

  // For tier counts, take the latest value in each period (not sum)
  const buckets = new Map<string, StakerTiersData>();

  for (const row of data) {
    const key = getGroupKey(row.week, period);
    // Always overwrite — since data is sorted ascending, last entry = latest in period
    buckets.set(key, { ...row, week: key });
  }

  return Array.from(buckets.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, val]) => ({
      ...val,
      week: formatGroupLabel(key, period),
    }));
}

export function StakerTiersChart({ data, isLoading }: StakerTiersChartProps) {
  const [activeToggles, setActiveToggles] = useState<Set<ToggleKey>>(
    new Set(['s100', 's500', 's1000'])
  );
  const [period, setPeriod] = useState<TimePeriod>('week');

  const chartData = useMemo(() => aggregateData(data, period), [data, period]);

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

  // Latest values + week-over-week change
  const summaryData = useMemo(() => {
    if (data.length < 2) return null;
    const latest = data[data.length - 1];
    const prev = data[data.length - 2];
    return {
      s100: { value: latest.stakers100, change: latest.stakers100 - prev.stakers100 },
      s500: { value: latest.stakers500, change: latest.stakers500 - prev.stakers500 },
      s1000: { value: latest.stakers1000, change: latest.stakers1000 - prev.stakers1000 },
    };
  }, [data]);

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
            Staker Tiers Over Time
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            Users above USD thresholds per week
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

      {/* Summary cards */}
      {summaryData && (
        <div className="grid grid-cols-3 gap-3 mb-5 relative z-10">
          {(Object.entries(TOGGLE_CONFIG) as [ToggleKey, typeof TOGGLE_CONFIG[ToggleKey]][]).map(
            ([key, { label, color }]) => {
              const s = summaryData[key];
              return (
                <div
                  key={key}
                  className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center"
                >
                  <span className="text-xs text-soft-gray">{label}</span>
                  <div className="text-xl font-bold mt-0.5" style={{ color }}>
                    {s.value.toLocaleString()}
                  </div>
                  <span className={`text-xs font-medium ${s.change >= 0 ? 'text-green1' : 'text-red-400'}`}>
                    {s.change >= 0 ? '+' : ''}{s.change} <span className="text-purple-gray font-normal">WoW</span>
                  </span>
                </div>
              );
            }
          )}
        </div>
      )}

      {/* Series toggle buttons */}
      <div className="flex gap-2 mb-5 relative z-10">
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

      <div className="h-80 relative z-10">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart
            data={chartData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
          >
            <defs>
              <linearGradient id="tier100Grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#3B82F6" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#3B82F6" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="tier500Grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#8B5CF6" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#8B5CF6" stopOpacity={0.02} />
              </linearGradient>
              <linearGradient id="tier1000Grad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#F59E0B" stopOpacity={0.3} />
                <stop offset="100%" stopColor="#F59E0B" stopOpacity={0.02} />
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
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 12 }}
              axisLine={false}
              tickLine={false}
              dx={-5}
              width={50}
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
                          {(entry.value as number).toLocaleString()} users
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

            {activeToggles.has('s100') && (
              <Area
                type="monotone"
                dataKey="stakers100"
                name="$100+"
                stroke="#3B82F6"
                strokeWidth={2}
                fill="url(#tier100Grad)"
                animationDuration={800}
              />
            )}

            {activeToggles.has('s500') && (
              <Area
                type="monotone"
                dataKey="stakers500"
                name="$500+"
                stroke="#8B5CF6"
                strokeWidth={2}
                fill="url(#tier500Grad)"
                animationDuration={800}
              />
            )}

            {activeToggles.has('s1000') && (
              <Area
                type="monotone"
                dataKey="stakers1000"
                name="$1,000+"
                stroke="#F59E0B"
                strokeWidth={2}
                fill="url(#tier1000Grad)"
                animationDuration={800}
              />
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
