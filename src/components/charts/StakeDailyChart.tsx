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

// Row shape consumed by this chart — Dashboard builds it from the Dune query.
export interface StakeDailyRow {
  date: string;               // YYYY-MM-DD
  lock_3mo_amount: number;
  lock_6mo_amount: number;
  lock_12mo_amount: number;
  lock_3mo_count: number;
  lock_6mo_count: number;
  lock_12mo_count: number;
  new_wallet_amount: number;
  old_wallet_amount: number;
  new_wallet_count: number;
  old_wallet_count: number;
  total_amount: number;
  total_events: number;
}

function formatLastUpdated(isoDate: string): string {
  const date = new Date(isoDate);
  const diffMs = Date.now() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

interface StakeDailyChartProps {
  days: StakeDailyRow[] | null;
  isLoading?: boolean;
  lastUpdated?: string | null;
}

type ViewMode = 'lock' | 'wallet';
type Metric = 'amount' | 'count';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}`;
}

export function StakeDailyChart({ days, isLoading, lastUpdated }: StakeDailyChartProps) {
  const [viewMode, setViewMode] = useState<ViewMode>('lock');
  const [metric, setMetric] = useState<Metric>('amount');

  const chartData = useMemo(() => {
    if (!days) return [];
    return days.map(d => ({
      date: d.date,
      label: formatDateLabel(d.date),
      lock_3mo: metric === 'amount' ? d.lock_3mo_amount : d.lock_3mo_count,
      lock_6mo: metric === 'amount' ? d.lock_6mo_amount : d.lock_6mo_count,
      lock_12mo: metric === 'amount' ? d.lock_12mo_amount : d.lock_12mo_count,
      new_wallet: metric === 'amount' ? d.new_wallet_amount : d.new_wallet_count,
      old_wallet: metric === 'amount' ? d.old_wallet_amount : d.old_wallet_count,
    }));
  }, [days, metric]);

  // Totals for header context
  const totals = useMemo(() => {
    if (!days || days.length === 0) return null;
    return days.reduce(
      (acc, d) => ({
        lock_3mo: acc.lock_3mo + d.lock_3mo_amount,
        lock_6mo: acc.lock_6mo + d.lock_6mo_amount,
        lock_12mo: acc.lock_12mo + d.lock_12mo_amount,
        new_amount: acc.new_amount + d.new_wallet_amount,
        old_amount: acc.old_amount + d.old_wallet_amount,
        new_count: acc.new_count + d.new_wallet_count,
        old_count: acc.old_count + d.old_wallet_count,
      }),
      { lock_3mo: 0, lock_6mo: 0, lock_12mo: 0, new_amount: 0, old_amount: 0, new_count: 0, old_count: 0 }
    );
  }, [days]);

  const valueFormatter = (v: number) =>
    metric === 'amount' ? `${formatNumber(v)} LINGO` : `${formatNumber(v)} stakes`;

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
      {/* Header */}
      <div className="flex items-start justify-between mb-4 relative z-10 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Daily Stake Breakdown</h3>
          <p className="text-sm text-soft-gray mt-1">
            Last 6 months by {viewMode === 'lock' ? 'lock duration' : 'wallet type (new vs returning)'}
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {lastUpdated && (
            <div
              className="flex items-center gap-1 text-xs text-purple-gray"
              title={`Data refreshed: ${new Date(lastUpdated).toLocaleString()}`}
            >
              <Clock className="w-3 h-3" />
              <span>{formatLastUpdated(lastUpdated)}</span>
            </div>
          )}

          {/* View mode toggle */}
          <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
            <button
              onClick={() => setViewMode('lock')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                viewMode === 'lock'
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              By Lock Duration
            </button>
            <button
              onClick={() => setViewMode('wallet')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                viewMode === 'wallet'
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              New vs Returning
            </button>
          </div>

          {/* Metric toggle */}
          <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
            <button
              onClick={() => setMetric('amount')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                metric === 'amount'
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Amount
            </button>
            <button
              onClick={() => setMetric('count')}
              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                metric === 'count'
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              Count
            </button>
          </div>
        </div>
      </div>

      {/* Totals pills */}
      {totals && (
        <div className="flex flex-wrap gap-2 mb-4 relative z-10">
          {viewMode === 'lock' ? (
            <>
              <TotalPill color="#5EB851" label="3mo" value={`${formatNumber(Math.round(totals.lock_3mo))} LINGO`} />
              <TotalPill color="#FF7847" label="6mo" value={`${formatNumber(Math.round(totals.lock_6mo))} LINGO`} />
              <TotalPill color="#E8B100" label="12mo" value={`${formatNumber(Math.round(totals.lock_12mo))} LINGO`} />
            </>
          ) : (
            <>
              <TotalPill
                color="#7B68AE"
                label="New wallets"
                value={`${formatNumber(totals.new_count)} \u00B7 ${formatNumber(Math.round(totals.new_amount))} LINGO`}
              />
              <TotalPill
                color="#C4B5D4"
                label="Returning"
                value={`${formatNumber(totals.old_count)} \u00B7 ${formatNumber(Math.round(totals.old_amount))} LINGO`}
              />
            </>
          )}
        </div>
      )}

      {/* Chart */}
      <div className="h-80 relative z-10">
        <ResponsiveContainer minWidth={0} width="100%" height={320}>
          <BarChart
            data={chartData}
            margin={{ top: 10, right: 10, left: 0, bottom: 0 }}
            barCategoryGap="10%"
          >
            <defs>
              <linearGradient id="stk-3mo" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5EB851" stopOpacity={1} />
                <stop offset="100%" stopColor="#5EB851" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="stk-6mo" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#FF7847" stopOpacity={1} />
                <stop offset="100%" stopColor="#FF7847" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="stk-12mo" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#E8B100" stopOpacity={1} />
                <stop offset="100%" stopColor="#E8B100" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="stk-new" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#7B68AE" stopOpacity={1} />
                <stop offset="100%" stopColor="#7B68AE" stopOpacity={0.5} />
              </linearGradient>
              <linearGradient id="stk-old" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#C4B5D4" stopOpacity={1} />
                <stop offset="100%" stopColor="#C4B5D4" stopOpacity={0.5} />
              </linearGradient>
            </defs>

            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />

            <XAxis
              dataKey="label"
              stroke="rgba(255,255,255,0.15)"
              tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              dy={10}
              interval="preserveStartEnd"
              minTickGap={40}
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
                const total = payload.reduce((s, p) => s + ((p.value as number) || 0), 0);
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-2">{String(label || '')}</p>
                    {payload.map((entry, index) => (
                      <div key={index} className="flex items-center gap-2 mb-1">
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: entry.color }} />
                        <span className="text-soft-gray text-sm">{entry.name}:</span>
                        <span className="text-lavender font-medium">
                          {valueFormatter(entry.value as number)}
                        </span>
                      </div>
                    ))}
                    {payload.length > 1 && (
                      <div className="flex items-center gap-2 mt-2 pt-2 border-t border-white/10">
                        <span className="text-soft-gray text-sm">Total:</span>
                        <span className="text-lavender font-semibold">
                          {valueFormatter(total)}
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
              formatter={(value) => <span className="text-soft-gray text-sm">{value}</span>}
            />

            {viewMode === 'lock' ? (
              <>
                <Bar dataKey="lock_3mo" name="3 Months" stackId="s" fill="url(#stk-3mo)" animationDuration={600} />
                <Bar dataKey="lock_6mo" name="6 Months" stackId="s" fill="url(#stk-6mo)" animationDuration={600} />
                <Bar dataKey="lock_12mo" name="12 Months" stackId="s" fill="url(#stk-12mo)" radius={[4, 4, 0, 0]} animationDuration={600} />
              </>
            ) : (
              <>
                <Bar dataKey="new_wallet" name="New Wallets" stackId="s" fill="url(#stk-new)" animationDuration={600} />
                <Bar dataKey="old_wallet" name="Returning" stackId="s" fill="url(#stk-old)" radius={[4, 4, 0, 0]} animationDuration={600} />
              </>
            )}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function TotalPill({ color, label, value }: { color: string; label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-white/[0.03] border border-white/[0.06]">
      <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
      <span className="text-xs text-soft-gray">{label}</span>
      <span className="text-xs text-lavender font-medium">{value}</span>
    </div>
  );
}
