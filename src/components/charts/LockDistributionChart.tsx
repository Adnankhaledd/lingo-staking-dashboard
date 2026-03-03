import { useMemo } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { Clock } from 'lucide-react';

interface LockDistributionData {
  month: string;
  flexible: number;
  threeMonth: number;
  sixMonth: number;
  twelveMonth: number;
  total: number;
}

interface LockDistributionChartProps {
  data: LockDistributionData[];
  isLoading?: boolean;
  lastUpdated?: string | null;
}

const SEGMENTS = [
  { key: 'flexible', label: 'Flexible', color: '#7B68AE' },
  { key: 'threeMonth', label: '3 Month', color: '#C4B5D4' },
  { key: 'sixMonth', label: '6 Month', color: '#5EB851' },
  { key: 'twelveMonth', label: '12 Month', color: '#FF7847' },
] as const;

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

export function LockDistributionChart({ data, isLoading, lastUpdated }: LockDistributionChartProps) {
  // Use the latest month's data
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];
    const latest = data[data.length - 1];
    const total = latest.flexible + latest.threeMonth + latest.sixMonth + latest.twelveMonth;
    if (total === 0) return [];

    return SEGMENTS.map(seg => ({
      name: seg.label,
      value: latest[seg.key],
      color: seg.color,
      pct: ((latest[seg.key] / total) * 100).toFixed(1),
    })).filter(s => s.value > 0);
  }, [data]);

  const latestMonth = data.length > 0 ? data[data.length - 1].month : '';

  if (isLoading) {
    return (
      <div className="flagship-card rounded-2xl p-6">
        <div className="skeleton h-6 w-48 rounded mb-2 relative z-10" />
        <div className="skeleton h-4 w-32 rounded mb-6 relative z-10" />
        <div className="skeleton h-72 w-full rounded-xl relative z-10" />
      </div>
    );
  }

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="flex items-start justify-between mb-4 relative z-10">
        <div>
          <h3 className="text-lg font-semibold text-lavender">
            Lock Duration Distribution
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            LINGO staked by lock period — {latestMonth}
          </p>
        </div>
        {lastUpdated && (
          <div className="flex items-center gap-1 text-xs text-purple-gray" title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}>
            <Clock className="w-3 h-3" />
            <span>{formatLastUpdated(lastUpdated)}</span>
          </div>
        )}
      </div>

      {chartData.length > 0 ? (
        <div className="flex flex-col sm:flex-row items-center gap-6 relative z-10">
          {/* Donut chart */}
          <div className="h-64 w-64 flex-shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={chartData}
                  cx="50%"
                  cy="50%"
                  innerRadius={65}
                  outerRadius={105}
                  paddingAngle={3}
                  dataKey="value"
                  stroke="none"
                  animationDuration={800}
                >
                  {chartData.map((entry, index) => (
                    <Cell key={index} fill={entry.color} />
                  ))}
                </Pie>
                <Tooltip
                  content={({ active, payload }) => {
                    if (!active || !payload || !payload.length) return null;
                    const entry = payload[0].payload;
                    return (
                      <div className="custom-tooltip">
                        <div className="flex items-center gap-2 mb-1">
                          <div
                            className="w-2.5 h-2.5 rounded-full"
                            style={{ backgroundColor: entry.color }}
                          />
                          <span className="text-soft-gray text-sm">{entry.name}</span>
                        </div>
                        <span className="text-lavender font-medium">
                          {Math.round(entry.value).toLocaleString()} LINGO
                        </span>
                        <span className="text-purple-gray text-xs ml-2">
                          ({entry.pct}%)
                        </span>
                      </div>
                    );
                  }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="flex-1 grid grid-cols-2 gap-3 w-full">
            {chartData.map((entry) => (
              <div
                key={entry.name}
                className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3"
              >
                <div className="flex items-center gap-2 mb-1">
                  <div
                    className="w-3 h-3 rounded-sm"
                    style={{ backgroundColor: entry.color }}
                  />
                  <span className="text-xs text-soft-gray">{entry.name}</span>
                </div>
                <div className="text-lg font-bold text-lavender">
                  {entry.pct}%
                </div>
                <div className="text-xs text-purple-gray">
                  {Math.round(entry.value).toLocaleString()} LINGO
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : (
        <div className="h-[280px] flex items-center justify-center text-soft-gray relative z-10">
          No data available
        </div>
      )}
    </div>
  );
}
