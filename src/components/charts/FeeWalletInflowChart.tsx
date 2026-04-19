import { useState, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import { Clock } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';

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

export interface FeeWalletInflowRow {
  day: string;              // YYYY-MM-DD (parent sanitizes)
  lingo_received: number;
  num_transfers: number;
  unique_senders: number;
  cumulative_lingo: number;
}

interface FeeWalletInflowChartProps {
  data: FeeWalletInflowRow[];
  isLoading?: boolean;
  lastUpdated?: string | null;
}

type Period = 'day' | 'week' | 'month' | 'quarter' | 'year';

const PERIOD_OPTIONS: { key: Period; label: string }[] = [
  { key: 'day', label: 'D' },
  { key: 'week', label: 'W' },
  { key: 'month', label: 'M' },
  { key: 'quarter', label: 'Q' },
  { key: 'year', label: 'Y' },
];

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDay(raw: string): string {
  if (!raw) return '';
  return raw.split(/[T\s]/)[0];
}

// Monday-start ISO-like week
function startOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay(); // 0 = Sun
  const diff = dow === 0 ? -6 : 1 - dow;
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

function getBucketKey(dateStr: string, period: Period): string {
  const [y, m] = dateStr.split('-').map(Number);
  switch (period) {
    case 'day': return dateStr;
    case 'week': return startOfWeek(dateStr);
    case 'month': return `${y}-${String(m).padStart(2, '0')}`;
    case 'quarter': {
      const q = Math.ceil(m / 3);
      return `${y}-Q${q}`;
    }
    case 'year': return `${y}`;
  }
}

function formatBucketLabel(key: string, period: Period): string {
  switch (period) {
    case 'day': {
      const [, m, d] = key.split('-').map(Number);
      return `${MONTH_NAMES[m - 1]} ${d}`;
    }
    case 'week': {
      const [, m, d] = key.split('-').map(Number);
      return `${MONTH_NAMES[m - 1]} ${d}`;
    }
    case 'month': {
      const [y, m] = key.split('-').map(Number);
      return `${MONTH_NAMES[m - 1]} '${String(y).slice(2)}`;
    }
    case 'quarter': return key;
    case 'year': return key;
  }
}

interface AggRow {
  bucket: string;
  label: string;
  lingo_received: number;
  num_transfers: number;
  unique_senders: number;
}

function aggregate(data: FeeWalletInflowRow[], period: Period): AggRow[] {
  if (!data || data.length === 0) return [];

  const buckets = new Map<string, AggRow>();
  for (const row of data) {
    const day = parseDay(row.day);
    if (!day) continue;
    const bucket = getBucketKey(day, period);
    let b = buckets.get(bucket);
    if (!b) {
      b = {
        bucket,
        label: formatBucketLabel(bucket, period),
        lingo_received: 0,
        num_transfers: 0,
        unique_senders: 0,
      };
      buckets.set(bucket, b);
    }
    b.lingo_received += row.lingo_received ?? 0;
    b.num_transfers += row.num_transfers ?? 0;
    // unique_senders summed is approximate (unions aren't computable per-day);
    // treated as "sender-days" when aggregated. Shown in the tooltip as such.
    b.unique_senders += row.unique_senders ?? 0;
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.bucket.localeCompare(b.bucket))
    .map(r => ({
      ...r,
      lingo_received: Math.round(r.lingo_received),
    }));
}

export function FeeWalletInflowChart({ data, isLoading, lastUpdated }: FeeWalletInflowChartProps) {
  const [period, setPeriod] = useState<Period>('day');
  const chartData = useMemo(() => aggregate(data, period), [data, period]);

  // Totals
  const totals = useMemo(() => {
    if (!data || data.length === 0) return null;
    const sorted = [...data].sort((a, b) => parseDay(b.day).localeCompare(parseDay(a.day)));
    return {
      allTime: Math.round(sorted[0].cumulative_lingo),
      totalTransfers: data.reduce((s, r) => s + (r.num_transfers ?? 0), 0),
    };
  }, [data]);

  if (isLoading) {
    return (
      <div className="flagship-card rounded-2xl p-6">
        <div className="skeleton h-6 w-64 rounded mb-2 relative z-10" />
        <div className="skeleton h-4 w-40 rounded mb-6 relative z-10" />
        <div className="skeleton h-80 w-full rounded-xl relative z-10" />
      </div>
    );
  }

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="flex items-start justify-between mb-4 relative z-10 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Fee Wallet Inflow</h3>
          <p className="text-sm text-soft-gray mt-1">
            LINGO tokens entering the fee wallet
            {totals && (
              <>
                {' \u00B7 '}
                <span className="text-lavender font-medium">{formatNumber(totals.allTime)} LINGO</span>
                {' all-time'}
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div
              className="flex items-center gap-1 text-xs text-purple-gray"
              title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}
            >
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
                title={key === 'day' ? 'Daily' : key === 'week' ? 'Weekly' : key === 'month' ? 'Monthly' : key === 'quarter' ? 'Quarterly' : 'Yearly'}
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
              <linearGradient id="feeInflowGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#5EB851" stopOpacity={1} />
                <stop offset="100%" stopColor="#5EB851" stopOpacity={0.5} />
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
                if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
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
                const row = payload[0].payload as AggRow;
                return (
                  <div className="custom-tooltip">
                    <p className="text-soft-gray text-xs mb-2">{String(label || '')}</p>
                    <div className="flex items-center gap-2 mb-1">
                      <div className="w-2 h-2 rounded-full" style={{ backgroundColor: '#5EB851' }} />
                      <span className="text-soft-gray text-sm">Received:</span>
                      <span className="text-lavender font-medium">
                        {formatNumber(row.lingo_received)} LINGO
                      </span>
                    </div>
                    <div className="text-[11px] text-purple-gray mt-1">
                      {formatNumber(row.num_transfers)} transfers
                      {' \u00B7 '}
                      {formatNumber(row.unique_senders)} {period === 'day' ? 'senders' : 'sender-days'}
                    </div>
                  </div>
                );
              }}
              cursor={{ fill: 'rgba(255,255,255,0.02)' }}
            />

            <Bar
              dataKey="lingo_received"
              name="LINGO Received"
              fill="url(#feeInflowGrad)"
              radius={[4, 4, 0, 0]}
              animationDuration={600}
            />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
