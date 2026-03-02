import { useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  ReferenceLine,
} from 'recharts';
import { formatChartDate, formatNumber } from '../../utils/formatters';

interface BuyPressureData {
  week: string;
  buyVolume: number;
  sellVolume: number;
  netBuyPressure: number;
  trades: number;
  totalVolume: number;
}

interface BuyPressureChartProps {
  data: BuyPressureData[];
  isLoading?: boolean;
}

type ToggleKey = 'buy' | 'sell' | 'net';

const TOGGLE_CONFIG: Record<ToggleKey, { label: string; color: string }> = {
  buy: { label: 'Buy Volume', color: '#5EB851' },
  sell: { label: 'Sell Volume', color: '#E85757' },
  net: { label: 'Net Buy Pressure', color: '#7B68AE' },
};

export function BuyPressureChart({ data, isLoading }: BuyPressureChartProps) {
  const [activeToggles, setActiveToggles] = useState<Set<ToggleKey>>(
    new Set(['buy', 'sell', 'net'])
  );

  const toggleSeries = (key: ToggleKey) => {
    setActiveToggles(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        // Don't allow turning off all toggles
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
            Buy & Sell Pressure
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            Weekly trading volume breakdown (USD)
          </p>
        </div>
      </div>

      {/* Toggle buttons */}
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
        <ResponsiveContainer width="100%" height="100%">
          <BarChart
            data={data}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            barCategoryGap="15%"
          >
            <defs>
              <linearGradient id="buyGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5EB851" stopOpacity={1} />
                <stop offset="100%" stopColor="#5EB851" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="sellGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#E85757" stopOpacity={1} />
                <stop offset="100%" stopColor="#E85757" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="netGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7B68AE" stopOpacity={1} />
                <stop offset="100%" stopColor="#7B68AE" stopOpacity={0.5} />
              </linearGradient>
            </defs>

            <CartesianGrid
              strokeDasharray="3 3"
              stroke="rgba(255,255,255,0.04)"
              vertical={false}
            />

            <XAxis
              dataKey="week"
              tickFormatter={formatChartDate}
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              dy={10}
              interval="preserveStartEnd"
            />

            <YAxis
              tickFormatter={(value) => {
                if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(0)}K`;
                return `$${value}`;
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
                    <p className="text-soft-gray text-xs mb-2">
                      {formatChartDate(String(label || ''))}
                    </p>
                    {payload.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2 mb-1">
                        <div
                          className="w-2 h-2 rounded-full"
                          style={{ backgroundColor: entry.color }}
                        />
                        <span className="text-soft-gray text-sm">{entry.name}:</span>
                        <span className="text-lavender font-medium">
                          ${formatNumber(Math.abs(entry.value as number))}
                        </span>
                      </div>
                    ))}
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
            />

            {activeToggles.has('net') && (
              <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
            )}

            <Legend
              wrapperStyle={{ paddingTop: 15 }}
              formatter={(value) => (
                <span className="text-soft-gray text-sm">{value}</span>
              )}
            />

            {activeToggles.has('buy') && (
              <Bar
                dataKey="buyVolume"
                name="Buy Volume"
                fill="url(#buyGrad)"
                radius={[4, 4, 0, 0]}
                animationDuration={800}
              />
            )}

            {activeToggles.has('sell') && (
              <Bar
                dataKey="sellVolume"
                name="Sell Volume"
                fill="url(#sellGrad)"
                radius={[4, 4, 0, 0]}
                animationDuration={800}
              />
            )}

            {activeToggles.has('net') && (
              <Bar
                dataKey="netBuyPressure"
                name="Net Buy Pressure"
                fill="url(#netGrad)"
                radius={[4, 4, 0, 0]}
                animationDuration={800}
              />
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
