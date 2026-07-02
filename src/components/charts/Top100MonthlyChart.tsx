import { useMemo } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  LabelList,
} from 'recharts';
import { Clock } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import type { Top100MonthlyRow } from '../../hooks/useDuneQuery';

interface Top100MonthlyChartProps {
  data: Top100MonthlyRow[] | null;
  isLoading?: boolean;
  lastUpdated?: string | null;
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

interface Point {
  key: string;        // "YYYY-MM"
  label: string;      // "Jun '26"
  lingo: number;      // top-100 LINGO staked that month
  momPct: number | null;
  momAbs: number | null;
  pctOfTotal: number;
  avgPerTop: number;
  users: number;      // all stakers that month
  topCount: number;
}

function fmtLastUpdated(isoDate: string): string {
  const date = new Date(isoDate);
  const diffMs = Date.now() - date.getTime();
  const mins = Math.floor(diffMs / 60_000);
  const hrs = Math.floor(diffMs / 3_600_000);
  const days = Math.floor(diffMs / 86_400_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

/** MoM % label rendered above each bar — green for rises, red for drops. */
function renderMomLabel(points: Point[]) {
  return function MomLabel(props: unknown) {
    const { x, y, width, index } = props as { x?: number; y?: number; width?: number; index?: number };
    if (index == null || x == null || y == null || width == null) return null;
    const p = points[index];
    if (!p || p.momPct == null) return null;
    const up = p.momPct >= 0;
    return (
      <text
        x={x + width / 2}
        y={y - 8}
        textAnchor="middle"
        fontSize={11}
        fontWeight={700}
        fill={up ? '#5EB851' : '#F87171'}
      >
        {up ? '▲' : '▼'}{Math.abs(p.momPct).toFixed(0)}%
      </text>
    );
  };
}

export function Top100MonthlyChart({ data, isLoading, lastUpdated }: Top100MonthlyChartProps) {
  // Sort ascending, DROP the current (partial) month, compute MoM deltas.
  const points = useMemo<Point[]>(() => {
    if (!data || data.length === 0) return [];
    const nowKey = new Date().toISOString().slice(0, 7);
    const sorted = data
      .map(r => ({ ...r, key: (r.month ?? '').split(/[T\s]/)[0].slice(0, 7) }))
      .filter(r => r.key && r.key < nowKey) // exclude the in-progress month
      .sort((a, b) => a.key.localeCompare(b.key));

    return sorted.map((r, i) => {
      const prev = i > 0 ? sorted[i - 1] : null;
      const momAbs = prev ? r.top_100_lingo - prev.top_100_lingo : null;
      const momPct = prev && prev.top_100_lingo > 0
        ? ((r.top_100_lingo - prev.top_100_lingo) / prev.top_100_lingo) * 100
        : null;
      const [y, m] = r.key.split('-').map(Number);
      return {
        key: r.key,
        label: `${MONTH_NAMES[m - 1]} '${String(y).slice(2)}`,
        lingo: Math.round(r.top_100_lingo),
        momPct,
        momAbs,
        pctOfTotal: r.top_100_pct_of_total ?? 0,
        avgPerTop: Math.round(r.avg_per_top_user ?? 0),
        users: r.total_users_that_month ?? 0,
        topCount: r.top_100_count ?? 0,
      };
    });
  }, [data]);

  const latest = points[points.length - 1] ?? null;

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
      {/* Header */}
      <div className="flex items-start justify-between mb-4 relative z-10 flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold text-lavender">
            Top 100 Stakers — Monthly Staked
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            LINGO staked each month by that month&rsquo;s top 100 stakers &middot; label above each bar is the MoM change
          </p>
        </div>
        {lastUpdated && (
          <div className="flex items-center gap-1 text-xs text-purple-gray" title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}>
            <Clock className="w-3 h-3" />
            <span>{fmtLastUpdated(lastUpdated)}</span>
          </div>
        )}
      </div>

      {/* Headline: latest complete month */}
      {latest && (
        <div className="flex flex-col items-center gap-1.5 mb-5 relative z-10">
          <span className="text-xs text-soft-gray uppercase tracking-wider">
            {latest.label} &bull; Top {latest.topCount} Stakers
          </span>
          <span className="text-4xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent tracking-tight">
            {latest.lingo.toLocaleString()}
          </span>
          <div className="flex items-center gap-2 flex-wrap justify-center">
            {latest.momPct != null && latest.momAbs != null && (
              <span className={`text-sm font-semibold px-2.5 py-0.5 rounded-full ${
                latest.momPct >= 0 ? 'text-green1 bg-green1/10' : 'text-red-400 bg-red-400/10'
              }`}>
                {latest.momPct >= 0 ? '+' : ''}{latest.momPct.toFixed(1)}%
                <span className="font-normal ml-1">({latest.momAbs >= 0 ? '+' : ''}{formatNumber(latest.momAbs)})</span>
                <span className="text-purple-gray font-normal ml-1">MoM</span>
              </span>
            )}
            <span className="text-xs text-purple-gray">
              avg {formatNumber(latest.avgPerTop)} / staker &middot; {latest.pctOfTotal.toFixed(1)}% of all LINGO staked that month
            </span>
          </div>
        </div>
      )}

      {/* Chart */}
      <div className="h-[340px] relative z-10">
        {points.length > 0 ? (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={points} margin={{ top: 26, right: 10, left: 0, bottom: 0 }} barCategoryGap="22%">
              <defs>
                <linearGradient id="top100Grad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#FFD75E" stopOpacity={1} />
                  <stop offset="100%" stopColor="#FFD75E" stopOpacity={0.35} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis
                dataKey="label"
                stroke="rgba(255,255,255,0.15)"
                tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                dy={8}
              />
              <YAxis
                tickFormatter={(v) => formatNumber(Number(v))}
                stroke="rgba(255,255,255,0.15)"
                tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                dx={-6}
                width={64}
              />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                content={({ active, payload }) => {
                  if (!active || !payload || !payload.length) return null;
                  const p = payload[0].payload as Point;
                  return (
                    <div className="custom-tooltip">
                      <p className="text-soft-gray text-xs mb-2">{p.label} &bull; top {p.topCount} stakers</p>
                      <p className="text-lavender font-semibold text-lg mb-1">
                        {p.lingo.toLocaleString()} LINGO
                      </p>
                      {p.momPct != null && p.momAbs != null && (
                        <p className={`text-sm mb-1 ${p.momPct >= 0 ? 'text-green1' : 'text-red-400'}`}>
                          {p.momPct >= 0 ? '▲ +' : '▼ '}{p.momPct.toFixed(1)}% MoM ({p.momAbs >= 0 ? '+' : ''}{formatNumber(p.momAbs)})
                        </p>
                      )}
                      <p className="text-soft-gray text-xs">avg {formatNumber(p.avgPerTop)} / top staker</p>
                      <p className="text-soft-gray text-xs">{p.pctOfTotal.toFixed(1)}% of the month&rsquo;s total staking</p>
                      <p className="text-purple-gray text-xs">{p.users.toLocaleString()} stakers active that month</p>
                    </div>
                  );
                }}
              />
              <Bar
                dataKey="lingo"
                name="Top 100 staked"
                fill="url(#top100Grad)"
                radius={[6, 6, 0, 0]}
                animationDuration={900}
                animationEasing="ease-out"
              >
                <LabelList dataKey="lingo" content={renderMomLabel(points)} />
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-soft-gray text-sm">
            No data available
          </div>
        )}
      </div>

      <p className="text-[11px] text-purple-gray text-center mt-3 relative z-10">
        Current (incomplete) month excluded &middot; &ldquo;top 100&rdquo; is recomputed within each month
      </p>
    </div>
  );
}
