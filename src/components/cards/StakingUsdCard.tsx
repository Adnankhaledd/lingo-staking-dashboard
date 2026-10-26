import { useMemo, useState } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  BarChart,
  Bar,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
  ReferenceLine,
} from 'recharts';
import { formatNumber } from '../../utils/formatters';
import type { DailyRow } from '../../hooks/useStakingMetrics';

/**
 * Staking Update in USD — a test companion to StakingUpdateCard. Same periods,
 * but each day's stakes, withdrawals and balance are valued at that day's
 * LINGO price from the pool's own trades, with the period's average price in
 * a strip underneath (its own scale: never a second y-axis on the bars).
 */

type Period = 'week' | 'month' | 'quarter' | 'year';
type Metric = 'deposited' | 'net' | 'value';
type Range = '12m' | 'all';

export interface UsdPeriod {
  key: string;
  label: string;
  isCurrent: boolean;
  depositedUsd: number;
  depositedLingo: number;
  withdrawnUsd: number;
  withdrawnLingo: number;
  netUsd: number;
  netLingo: number;
  /** Staked balance at the end of the period (live total for the current one). */
  valueUsd: number;
  valueLingo: number;
  avgPrice: number;
  endPrice: number;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY_MS = 86_400_000;

function periodKey(day: string, period: Period): string {
  switch (period) {
    case 'week': {
      const d = new Date(day + 'T00:00:00Z');
      const sinceMonday = (d.getUTCDay() + 6) % 7;
      return new Date(d.getTime() - sinceMonday * DAY_MS).toISOString().slice(0, 10);
    }
    case 'month': return day.slice(0, 7);
    case 'quarter': return `${day.slice(0, 4)}-Q${Math.floor((Number(day.slice(5, 7)) - 1) / 3) + 1}`;
    case 'year': return day.slice(0, 4);
  }
}

function periodLabel(key: string, period: Period): string {
  const yy = key.slice(2, 4);
  switch (period) {
    case 'week': return `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;
    case 'month': return `${MONTHS[Number(key.slice(5, 7)) - 1]} '${yy}`;
    case 'quarter': return `${key.slice(5)} '${yy}`;
    case 'year': return key;
  }
}

/** Each day's price: that day's pool price, else the last earlier one, else the first known. */
export function fillPrices(days: string[], prices: Array<[string, number]>): Map<string, number> {
  const out = new Map<string, number>();
  if (!prices.length) return out;
  const sorted = [...prices].sort((a, b) => a[0].localeCompare(b[0]));
  let i = 0;
  let last = sorted[0][1];
  for (const day of [...days].sort()) {
    while (i < sorted.length && sorted[i][0] <= day) { last = sorted[i][1]; i++; }
    out.set(day, last);
  }
  return out;
}

export function buildUsdPeriods(
  daily: DailyRow[],
  prices: Array<[string, number]>,
  period: Period,
  liveTotal?: number | null,
): UsdPeriod[] {
  if (!daily.length || !prices.length) return [];
  const rows = [...daily].sort((a, b) => a.day.localeCompare(b.day));
  const priceOf = fillPrices(rows.map(r => r.day), prices);

  const buckets = new Map<string, UsdPeriod & { priceSum: number; days: number }>();
  for (const r of rows) {
    const p = priceOf.get(r.day)!;
    const key = periodKey(r.day, period);
    const b = buckets.get(key) ?? {
      key, label: periodLabel(key, period), isCurrent: false,
      depositedUsd: 0, depositedLingo: 0, withdrawnUsd: 0, withdrawnLingo: 0, netUsd: 0, netLingo: 0,
      valueUsd: 0, valueLingo: 0, avgPrice: 0, endPrice: 0, priceSum: 0, days: 0,
    };
    b.depositedUsd += r.staked * p;
    b.depositedLingo += r.staked;
    b.withdrawnUsd += r.unstaked * p;
    b.withdrawnLingo += r.unstaked;
    b.valueLingo = r.total_staked;      // rows are in order, so the last day wins
    b.endPrice = p;
    b.priceSum += p;
    b.days++;
    buckets.set(key, b);
  }

  const out = [...buckets.values()].map(({ priceSum, days, ...b }) => ({
    ...b,
    netUsd: b.depositedUsd - b.withdrawnUsd,
    netLingo: b.depositedLingo - b.withdrawnLingo,
    valueUsd: b.valueLingo * b.endPrice,
    avgPrice: priceSum / days,
  }));
  const cur = out[out.length - 1];
  cur.isCurrent = true;
  if (liveTotal != null) { cur.valueLingo = liveTotal; cur.valueUsd = liveTotal * cur.endPrice; }
  return out;
}

const usd = (n: number) => {
  const a = Math.abs(n), s = n < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${s}$${(a / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  return `${s}$${Math.round(a)}`;
};
const price = (p: number) => `$${p.toFixed(p < 0.1 ? 4 : 3)}`;

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];
const METRIC_OPTIONS: { value: Metric; label: string }[] = [
  { value: 'deposited', label: 'Deposited' },
  { value: 'net', label: 'Net added' },
  { value: 'value', label: 'Staked value' },
];
const RANGE_OPTIONS: { value: Range; label: string }[] = [
  { value: '12m', label: 'Last 12 months' },
  { value: 'all', label: 'All time' },
];
// Launch (Dec 2024, ~$0.40) dwarfs every later period in USD, so week and month
// views open on the last 12 months, like the New Users charts. Quarters and years
// are few enough to always show in full.
const RECENT_BARS: Partial<Record<Period, number>> = { week: 52, month: 12 };

const METRIC_KEY: Record<Metric, 'depositedUsd' | 'netUsd' | 'valueUsd'> = { deposited: 'depositedUsd', net: 'netUsd', value: 'valueUsd' };

// Validated together against the card surface (#14141f): purple / red / teal.
const BAR = '#7B68AE';
const BAR_CURRENT = '#C4B5D4';
const BAR_NEGATIVE = '#E5534B';
const PRICE = '#3BA99C';

const AXIS = { stroke: 'rgba(255,255,255,0.15)', tick: { fill: 'rgba(255,255,255,0.35)', fontSize: 11 }, axisLine: false, tickLine: false } as const;
const CHART_MARGIN = { top: 10, right: 10, left: 0, bottom: 0 };
const Y_WIDTH = 62;

function Toggle<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex gap-1 bg-card-bg/60 rounded-lg p-0.5 border border-white/5">
      {options.map(opt => (
        <button
          key={opt.value}
          onClick={() => onChange(opt.value)}
          className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-200 ${
            value === opt.value ? 'bg-purple/20 text-lavender shadow-sm' : 'text-purple-gray hover:text-lavender hover:bg-white/5'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

function Chip({ pct }: { pct: number | null }) {
  if (pct == null || !Number.isFinite(pct)) return null;
  const up = pct > 0, down = pct < 0;
  const Icon = up ? TrendingUp : down ? TrendingDown : Minus;
  const color = up ? 'text-green1' : down ? 'text-red-400' : 'text-gray-400';
  const bg = up ? 'bg-green1/10' : down ? 'bg-red-400/10' : 'bg-gray-400/10';
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md ${bg}`}>
      <Icon className={`w-3.5 h-3.5 ${color}`} />
      <span className={`text-xs font-semibold ${color}`}>{up ? '+' : ''}{pct.toFixed(1)}%</span>
    </span>
  );
}

interface StakingUsdCardProps {
  daily: DailyRow[] | null;
  prices: Array<[string, number]> | null;
  liveTotal?: number | null;
  isLoading: boolean;
  priceError?: string | null;
}

export function StakingUsdCard({ daily, prices, liveTotal, isLoading, priceError }: StakingUsdCardProps) {
  const [period, setPeriod] = useState<Period>('month');
  const [metric, setMetric] = useState<Metric>('deposited');
  const [range, setRange] = useState<Range>('12m');

  const all = useMemo(
    () => (daily && prices ? buildUsdPeriods(daily, prices, period, liveTotal) : []),
    [daily, prices, period, liveTotal],
  );
  const recent = RECENT_BARS[period];
  // The hero always compares with the period before, even when the chart is trimmed.
  const data = range === '12m' && recent ? all.slice(-recent) : all;

  if (isLoading) {
    return (
      <div className="flagship-card p-6">
        <div className="skeleton h-4 w-40 rounded mb-4" />
        <div className="skeleton h-[380px] w-full rounded" />
      </div>
    );
  }
  if (!all.length) {
    return (
      <div className="flagship-card p-6 text-sm text-soft-gray">
        Staking Update · USD — {priceError ? `price history unavailable (${priceError})` : 'no data yet'}
      </div>
    );
  }

  const key = METRIC_KEY[metric];
  const cur = all[all.length - 1];
  const prev = all.length > 1 ? all[all.length - 2] : null;
  const pctVs = (a: number, b: number | undefined) => (b ? ((a - b) / Math.abs(b)) * 100 : null);
  const periodWord = period === 'week' ? 'week' : period;

  return (
    <div className="flagship-card p-6 group transition-all duration-300">
      <div className="absolute inset-0 bg-gradient-to-br from-purple/5 to-light1/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />

      <div className="relative z-10">
        <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
          <h3 className="text-[11px] text-soft-gray font-medium uppercase tracking-wider flex items-center gap-2">
            Staking Update · USD
            <span className="normal-case tracking-normal text-[10px] px-1.5 py-0.5 rounded bg-white/5 text-purple-gray">test</span>
          </h3>
          <div className="flex flex-wrap gap-2">
            {recent && <Toggle options={RANGE_OPTIONS} value={range} onChange={setRange} />}
            <Toggle options={METRIC_OPTIONS} value={metric} onChange={setMetric} />
            <Toggle options={PERIOD_OPTIONS} value={period} onChange={setPeriod} />
          </div>
        </div>

        {/* Hero: the chosen measure for this period, and the period's average price */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 my-5">
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[11px] text-purple-gray uppercase tracking-wider">
              {metric === 'value' ? 'Staked value now' : `${metric === 'net' ? 'Net added' : 'Deposited'} this ${periodWord} so far`}
            </span>
            <span className="text-4xl sm:text-5xl font-bold bg-gradient-to-r from-purple via-light1 to-lavender bg-clip-text text-transparent tracking-tight">
              {usd(cur[key])}
            </span>
            <span className="flex items-center gap-2 text-sm text-purple-gray">
              {metric === 'value'
                ? <>{formatNumber(cur.valueLingo)} LINGO <Chip pct={pctVs(cur.valueUsd, prev?.valueUsd)} /></>
                : <>{formatNumber(metric === 'net' ? cur.netLingo : cur.depositedLingo)} LINGO · last {periodWord} {prev ? usd(prev[key]) : '—'}</>}
            </span>
          </div>
          <div className="flex flex-col items-center gap-1.5">
            <span className="text-[11px] text-purple-gray uppercase tracking-wider">Avg LINGO price this {periodWord}</span>
            <span className="text-4xl sm:text-5xl font-bold text-lavender tracking-tight">{price(cur.avgPrice)}</span>
            <span className="flex items-center gap-2 text-sm text-purple-gray">
              last {periodWord} {prev ? price(prev.avgPrice) : '—'} <Chip pct={pctVs(cur.avgPrice, prev?.avgPrice)} />
            </span>
          </div>
        </div>

        {/* USD bars */}
        <ResponsiveContainer minWidth={0} width="100%" height={240}>
          <BarChart data={data} margin={CHART_MARGIN} barCategoryGap="18%" syncId="stakingUsd">
            <defs>
              <linearGradient id="usdBar" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={BAR} stopOpacity={1} />
                <stop offset="100%" stopColor={BAR} stopOpacity={0.4} />
              </linearGradient>
              <linearGradient id="usdBarCurrent" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={BAR_CURRENT} stopOpacity={1} />
                <stop offset="100%" stopColor={BAR_CURRENT} stopOpacity={0.5} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="label" hide />
            <YAxis {...AXIS} width={Y_WIDTH} tickFormatter={v => usd(Number(v))} />
            {metric === 'net' && <ReferenceLine y={0} stroke="rgba(255,255,255,0.2)" />}
            <Tooltip
              cursor={{ fill: 'rgba(255,255,255,0.03)' }}
              content={({ active, payload }) => {
                if (!active || !payload?.length) return null;
                const d = payload[0].payload as UsdPeriod;
                const row = (label: string, v: string, sub?: string, strong?: boolean) => (
                  <div className="flex items-baseline justify-between gap-4">
                    <span className="text-soft-gray text-xs">{label}</span>
                    <span className={strong ? 'text-lavender font-semibold' : 'text-lavender'}>
                      {v}{sub && <span className="text-purple-gray text-xs ml-1.5">{sub}</span>}
                    </span>
                  </div>
                );
                return (
                  <div className="custom-tooltip min-w-[230px] space-y-1">
                    <p className="text-soft-gray text-xs mb-1">{period === 'week' ? `Week of ${d.label}` : d.label}{d.isCurrent ? ' (so far)' : ''}</p>
                    {row('Deposited', usd(d.depositedUsd), `${formatNumber(d.depositedLingo)} LINGO`, metric === 'deposited')}
                    {row('Withdrawn', usd(d.withdrawnUsd), `${formatNumber(d.withdrawnLingo)} LINGO`)}
                    {row('Net added', usd(d.netUsd), `${formatNumber(d.netLingo)} LINGO`, metric === 'net')}
                    {row('Staked value', usd(d.valueUsd), `${formatNumber(d.valueLingo)} LINGO`, metric === 'value')}
                    {row('Avg LINGO price', price(d.avgPrice))}
                  </div>
                );
              }}
            />
            <Bar dataKey={key} radius={[4, 4, 0, 0]} animationDuration={800} animationEasing="ease-out">
              {data.map((d, i) => (
                <Cell key={i} fill={d[key] < 0 ? BAR_NEGATIVE : d.isCurrent ? 'url(#usdBarCurrent)' : 'url(#usdBar)'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>

        {/* Average price strip — same periods, its own scale */}
        <p className="text-[11px] text-purple-gray mt-3 mb-1 ml-1">Average LINGO price</p>
        <ResponsiveContainer minWidth={0} width="100%" height={120}>
          <LineChart data={data} margin={CHART_MARGIN} syncId="stakingUsd">
            <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
            <XAxis dataKey="label" {...AXIS} dy={8} />
            <YAxis {...AXIS} width={Y_WIDTH} tickFormatter={v => price(Number(v))} tickCount={3} />
            <Tooltip content={() => null} cursor={{ stroke: 'rgba(255,255,255,0.15)' }} />
            <Line type="linear" dataKey="avgPrice" stroke={PRICE} strokeWidth={2} dot={false} activeDot={{ r: 4, stroke: '#14141f', strokeWidth: 2 }} animationDuration={800} />
          </LineChart>
        </ResponsiveContainer>

        <p className="text-[11px] text-purple-gray mt-4 leading-relaxed">
          USD at each day's LINGO price from the LINGO/WETH pool's own trades. Deposited counts every stake, including
          re-stakes of unlocked LINGO; Net added subtracts withdrawals. Flows run to the last nightly snapshot; staked value uses the live total.
        </p>
      </div>
    </div>
  );
}
