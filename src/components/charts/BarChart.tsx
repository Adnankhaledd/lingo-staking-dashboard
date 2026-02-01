import {
  BarChart as RechartsBarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { formatChartDate, formatNumber } from '../../utils/formatters';

interface BarChartProps<T extends object> {
  data: T[];
  bars: Array<{
    dataKey: keyof T;
    name: string;
    color: string;
    stackId?: string;
  }>;
  xAxisKey?: keyof T;
  height?: number;
  showGrid?: boolean;
  showLegend?: boolean;
  formatXAxis?: (value: string) => string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; name: string; color: string }>;
  label?: string;
}

function CustomTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;

  return (
    <div className="custom-tooltip">
      <p className="text-white/60 text-xs mb-2">{formatChartDate(label || '')}</p>
      {payload.map((entry, index) => (
        <div key={index} className="flex items-center gap-2 mb-1">
          <div
            className="w-2 h-2 rounded-full"
            style={{ backgroundColor: entry.color }}
          />
          <span className="text-white/60 text-sm">{entry.name}:</span>
          <span className="text-white font-medium">{formatNumber(entry.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function BarChartComponent<T extends object>({
  data,
  bars,
  xAxisKey = 'date' as keyof T,
  height = 300,
  showGrid = true,
  showLegend = true,
  formatXAxis = formatChartDate,
}: BarChartProps<T>) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        barCategoryGap="20%"
      >
        <defs>
          {bars.map((bar) => (
            <linearGradient
              key={String(bar.dataKey)}
              id={`barGradient-${String(bar.dataKey)}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={bar.color} stopOpacity={1} />
              <stop offset="100%" stopColor={bar.color} stopOpacity={0.6} />
            </linearGradient>
          ))}
        </defs>

        {showGrid && (
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="rgba(255,255,255,0.05)"
            vertical={false}
          />
        )}

        <XAxis
          dataKey={xAxisKey as string}
          tickFormatter={formatXAxis}
          stroke="rgba(255,255,255,0.2)"
          tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          dy={10}
        />

        <YAxis
          tickFormatter={(value) => formatNumber(value, 0)}
          stroke="rgba(255,255,255,0.2)"
          tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          dx={-10}
          width={60}
        />

        <Tooltip content={<CustomTooltip />} cursor={{ fill: 'rgba(255,255,255,0.02)' }} />

        {showLegend && (
          <Legend
            wrapperStyle={{
              paddingTop: 20,
            }}
            formatter={(value) => (
              <span className="text-white/60 text-sm">{value}</span>
            )}
          />
        )}

        {bars.map((bar) => (
          <Bar
            key={String(bar.dataKey)}
            dataKey={bar.dataKey as string}
            name={bar.name}
            fill={`url(#barGradient-${String(bar.dataKey)})`}
            stackId={bar.stackId}
            radius={bar.stackId ? [0, 0, 0, 0] : [4, 4, 0, 0]}
            animationDuration={1000}
            animationEasing="ease-out"
          />
        ))}
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}

// Simple bar chart for monthly comparison
export function SimpleBarChart<T extends object>({
  data,
  dataKey,
  xAxisKey = 'month' as keyof T,
  color = '#00D4FF',
  height = 300,
}: {
  data: T[];
  dataKey: keyof T;
  xAxisKey?: keyof T;
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsBarChart
        data={data}
        margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
        barCategoryGap="25%"
      >
        <defs>
          <linearGradient id="simpleBarGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={1} />
            <stop offset="100%" stopColor={color} stopOpacity={0.4} />
          </linearGradient>
        </defs>

        <CartesianGrid
          strokeDasharray="3 3"
          stroke="rgba(255,255,255,0.05)"
          vertical={false}
        />

        <XAxis
          dataKey={xAxisKey as string}
          stroke="rgba(255,255,255,0.2)"
          tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          dy={10}
        />

        <YAxis
          tickFormatter={(value) => formatNumber(value, 0)}
          stroke="rgba(255,255,255,0.2)"
          tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          dx={-10}
          width={60}
        />

        <Tooltip
          content={({ active, payload, label }) => {
            if (!active || !payload || !payload.length) return null;
            return (
              <div className="custom-tooltip">
                <p className="text-white/60 text-xs mb-1">{label}</p>
                <p className="text-white font-semibold text-lg">
                  {formatNumber(payload[0].value as number)}
                </p>
              </div>
            );
          }}
          cursor={{ fill: 'rgba(255,255,255,0.02)' }}
        />

        <Bar
          dataKey={dataKey as string}
          fill="url(#simpleBarGradient)"
          radius={[6, 6, 0, 0]}
          animationDuration={1000}
          animationEasing="ease-out"
        />
      </RechartsBarChart>
    </ResponsiveContainer>
  );
}
