import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import type { DailyMetric } from '../../hooks/useMixpanelData';

interface MixpanelChartProps {
  title: string;
  subtitle?: string;
  data: DailyMetric[];
  color?: string;
  isLoading?: boolean;
}

export function MixpanelChart({
  title,
  subtitle,
  data,
  color = '#C4B5D4',
  isLoading,
}: MixpanelChartProps) {
  if (isLoading) {
    return (
      <div className="flagship-card p-6">
        <div className="skeleton h-6 w-48 rounded mb-2 relative z-10" />
        <div className="skeleton h-4 w-32 rounded mb-6 relative z-10" />
        <div className="skeleton h-64 w-full rounded-xl relative z-10" />
      </div>
    );
  }

  return (
    <div className="flagship-card p-6">
      <div className="mb-6 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">{title}</h3>
        {subtitle && (
          <p className="text-sm text-soft-gray mt-1">{subtitle}</p>
        )}
      </div>

      <div className="h-64 relative z-10">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data}>
            <defs>
              <linearGradient id={`gradient-${title.replace(/\s/g, '')}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor={color} stopOpacity={0.25} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" />
            <XAxis
              dataKey="date"
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
              interval="preserveStartEnd"
              tickMargin={8}
            />
            <YAxis
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 12 }}
              axisLine={{ stroke: 'rgba(255,255,255,0.06)' }}
              tickFormatter={(value) => {
                if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
                return value.toString();
              }}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'rgba(20, 20, 31, 0.95)',
                border: '1px solid rgba(255, 255, 255, 0.08)',
                borderRadius: '12px',
                boxShadow: '0 4px 20px rgba(0, 0, 0, 0.5)',
              }}
              labelStyle={{ color: 'rgba(255, 255, 255, 0.5)' }}
              itemStyle={{ color: color }}
              formatter={(value) => value != null ? [value.toLocaleString(), 'Users'] : ['0', 'Users']}
            />
            <Area
              type="monotone"
              dataKey="value"
              stroke={color}
              strokeWidth={2}
              fill={`url(#gradient-${title.replace(/\s/g, '')})`}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
