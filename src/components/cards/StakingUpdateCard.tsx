import { useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { parseDuneDate } from '../../utils/dataTransformers';
import type { TotalStakedRow } from '../../hooks/useDuneQuery';

type Period = 'week' | 'month' | 'quarter' | 'year';

interface PeriodData {
  current: number;
  previous: number;
  change: number;
  changePct: number;
  currentLabel: string;
  previousLabel: string;
}

function calculatePeriodData(data: TotalStakedRow[], period: Period): PeriodData | null {
  if (!data || data.length < 2) return null;

  // Sort by date ascending
  const sorted = [...data].sort((a, b) =>
    parseDuneDate(a.day).localeCompare(parseDuneDate(b.day))
  );

  const latest = sorted[sorted.length - 1];
  const latestDate = new Date(parseDuneDate(latest.day));
  const currentValue = latest.total_staked;

  // Calculate how many days back to look
  let daysBack: number;
  let periodLabel: string;
  switch (period) {
    case 'week':
      daysBack = 7;
      periodLabel = 'Last week';
      break;
    case 'month':
      daysBack = 30;
      periodLabel = 'Last month';
      break;
    case 'quarter':
      daysBack = 90;
      periodLabel = 'Last quarter';
      break;
    case 'year':
      daysBack = 365;
      periodLabel = 'Last year';
      break;
  }

  const targetDate = new Date(latestDate);
  targetDate.setDate(targetDate.getDate() - daysBack);
  const targetStr = targetDate.toISOString().split('T')[0];

  // Find the closest data point to the target date
  let closest = sorted[0];
  let closestDiff = Infinity;
  for (const row of sorted) {
    const rowDate = parseDuneDate(row.day);
    const diff = Math.abs(new Date(rowDate).getTime() - new Date(targetStr).getTime());
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = row;
    }
  }

  const previousValue = closest.total_staked;
  const change = currentValue - previousValue;
  const changePct = previousValue > 0 ? (change / previousValue) * 100 : 0;

  const formatDateLabel = (d: Date) =>
    d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  return {
    current: currentValue,
    previous: previousValue,
    change,
    changePct,
    currentLabel: formatDateLabel(latestDate),
    previousLabel: `${periodLabel} (${formatDateLabel(new Date(parseDuneDate(closest.day)))})`,
  };
}

const PERIOD_OPTIONS: { value: Period; label: string }[] = [
  { value: 'week', label: 'Week' },
  { value: 'month', label: 'Month' },
  { value: 'quarter', label: 'Quarter' },
  { value: 'year', label: 'Year' },
];

interface StakingUpdateCardProps {
  data: TotalStakedRow[] | null;
  isLoading: boolean;
}

export function StakingUpdateCard({ data, isLoading }: StakingUpdateCardProps) {
  const [period, setPeriod] = useState<Period>('week');

  const periodData = useMemo(() => {
    if (!data) return null;
    return calculatePeriodData(data, period);
  }, [data, period]);

  if (isLoading) {
    return (
      <div className="flagship-card p-6">
        <div className="skeleton h-4 w-40 rounded mb-4" />
        <div className="skeleton h-10 w-56 rounded mb-3" />
        <div className="skeleton h-6 w-32 rounded" />
      </div>
    );
  }

  if (!periodData) return null;

  const isUp = periodData.changePct > 0;
  const isDown = periodData.changePct < 0;
  const isNeutral = periodData.changePct === 0;

  const TrendIcon = isUp ? TrendingUp : isDown ? TrendingDown : Minus;
  const trendColor = isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-gray-400';
  const trendBg = isUp ? 'bg-green1/10' : isDown ? 'bg-red-400/10' : 'bg-gray-400/10';

  return (
    <div className="flagship-card p-6 group transition-all duration-300 hover:scale-[1.01]">
      {/* Gradient accent on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-purple/5 to-light1/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-purple/8 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

      <div className="relative z-10">
        {/* Header with period selector */}
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[11px] text-soft-gray font-medium uppercase tracking-wider">
            Staking Update
          </h3>
          <div className="flex gap-1 bg-card-bg/60 rounded-lg p-0.5 border border-white/5">
            {PERIOD_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setPeriod(opt.value)}
                className={`px-2.5 py-1 text-[11px] font-medium rounded-md transition-all duration-200 ${
                  period === opt.value
                    ? 'bg-purple/20 text-lavender shadow-sm'
                    : 'text-purple-gray hover:text-lavender hover:bg-white/5'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* Current value */}
        <div className="flex items-baseline gap-2 mb-1">
          <span className="text-3xl lg:text-4xl font-bold text-lavender">
            {formatNumber(periodData.current, 1)}
          </span>
          <span className="text-sm text-purple-gray font-medium">LINGO</span>
        </div>

        {/* Change indicator */}
        <div className="flex items-center gap-3 mb-4">
          <div className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg ${trendBg}`}>
            <TrendIcon className={`w-3.5 h-3.5 ${trendColor}`} />
            <span className={`text-xs font-semibold ${trendColor}`}>
              {isUp ? '+' : ''}{periodData.changePct.toFixed(2)}%
            </span>
          </div>
          <span className="text-xs text-purple-gray">
            {isUp ? '+' : ''}{formatNumber(periodData.change, 1)} LINGO
          </span>
        </div>

        {/* Comparison line */}
        <div className="flex items-center justify-between pt-3 border-t border-white/5">
          <div className="text-center flex-1">
            <p className="text-[10px] text-soft-gray uppercase tracking-wider mb-1">
              {periodData.previousLabel}
            </p>
            <p className="text-sm font-semibold text-purple-gray">
              {formatNumber(periodData.previous, 1)} LINGO
            </p>
          </div>
          <div className="w-px h-8 bg-white/10 mx-3" />
          <div className="text-center flex-1">
            <p className="text-[10px] text-soft-gray uppercase tracking-wider mb-1">Now</p>
            <p className="text-sm font-semibold text-lavender">
              {formatNumber(periodData.current, 1)} LINGO
            </p>
          </div>
        </div>
      </div>

      {/* Bottom gradient line */}
      <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-gradient-to-r from-transparent via-purple/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10" />
    </div>
  );
}
