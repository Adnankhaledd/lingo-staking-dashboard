import { useMemo } from 'react';
import {
  PieChart,
  Pie,
  Cell,
  ResponsiveContainer,
  Tooltip,
} from 'recharts';
import { Clock } from 'lucide-react';
import type { LockDistributionRow } from '../../hooks/useDuneQuery';

interface LockDistributionChartProps {
  data: LockDistributionRow[] | null;
  isLoading?: boolean;
  lastUpdated?: string | null;
}

const COLORS: Record<string, string> = {
  'Flexible': '#7B68AE',
  '3 months': '#C4B5D4',
  '6 months': '#5EB851',
  '12 months': '#FF7847',
};

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
  const chartData = useMemo(() => {
    if (!data || data.length === 0) return [];

    return data
      .filter(row => row.lock_period !== 'TOTAL')
      .map(row => ({
        name: row.lock_period,
        value: Math.round(row.lingo_staked),
        usd: Math.round(row.usd_value),
        pct: row.percentage_of_total.toFixed(1),
        color: COLORS[row.lock_period] ?? '#888',
      }))
      .filter(s => s.value > 0);
  }, [data]);

  const totalRow = data?.find(r => r.lock_period === 'TOTAL');

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
            Current LINGO staked by lock period
          </p>
        </div>
        {lastUpdated && (
          <div className="flex items-center gap-1 text-xs text-purple-gray" title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}>
            <Clock className="w-3 h-3" />
            <span>{formatLastUpdated(lastUpdated)}</span>
          </div>
        )}
      </div>

      {/* Total staked summary */}
      {totalRow && (
        <div className="text-center mb-4 relative z-10">
          <span className="text-2xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent">
            {Math.round(totalRow.lingo_staked).toLocaleString()}
          </span>
          <span className="text-sm text-soft-gray ml-2">LINGO total</span>
        </div>
      )}

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
                          {entry.value.toLocaleString()} LINGO
                        </span>
                        <span className="text-purple-gray text-xs ml-2">
                          ({entry.pct}%)
                        </span>
                        <div className="text-purple-gray text-xs mt-1">
                          ${entry.usd.toLocaleString()} USD
                        </div>
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
                  {entry.value.toLocaleString()} LINGO
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
