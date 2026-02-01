import {
  AreaChart as RechartsAreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { formatChartDate, formatNumber } from '../../utils/formatters';

interface AreaChartProps<T extends object> {
  data: T[];
  dataKey: keyof T;
  xAxisKey?: keyof T;
  color?: string;
  gradientId?: string;
  height?: number;
  showGrid?: boolean;
  formatValue?: (value: number) => string;
}

interface CustomTooltipProps {
  active?: boolean;
  payload?: Array<{ value: number; dataKey: string }>;
  label?: string;
  formatValue?: (value: number) => string;
}

function CustomTooltip({ active, payload, label, formatValue }: CustomTooltipProps) {
  if (!active || !payload || !payload.length) return null;

  const value = payload[0].value;
  const formattedValue = formatValue ? formatValue(value) : formatNumber(value);

  return (
    <div className="custom-tooltip">
      <p className="text-white/60 text-xs mb-1">{formatChartDate(label || '')}</p>
      <p className="text-white font-semibold text-lg">{formattedValue}</p>
    </div>
  );
}

export function AreaChartComponent<T extends object>({
  data,
  dataKey,
  xAxisKey = 'date' as keyof T,
  color = '#00D4FF',
  gradientId = 'areaGradient',
  height = 300,
  showGrid = true,
  formatValue,
}: AreaChartProps<T>) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <RechartsAreaChart
        data={data}
        margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="50%" stopColor={color} stopOpacity={0.1} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
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
          tickFormatter={formatChartDate}
          stroke="rgba(255,255,255,0.2)"
          tick={{ fill: 'rgba(255,255,255,0.4)', fontSize: 12 }}
          axisLine={false}
          tickLine={false}
          dy={10}
          interval="preserveStartEnd"
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
          content={<CustomTooltip formatValue={formatValue} />}
          cursor={{
            stroke: color,
            strokeWidth: 1,
            strokeDasharray: '5 5',
          }}
        />

        <Area
          type="monotone"
          dataKey={dataKey as string}
          stroke={color}
          strokeWidth={2}
          fill={`url(#${gradientId})`}
          animationDuration={1000}
          animationEasing="ease-out"
        />
      </RechartsAreaChart>
    </ResponsiveContainer>
  );
}
