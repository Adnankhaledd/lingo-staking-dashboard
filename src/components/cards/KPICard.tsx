import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { formatNumber, formatPercent } from '../../utils/formatters';
import type { KPIData } from '../../types';

interface KPICardProps {
  data: KPIData;
  index?: number;
}

export function KPICard({ data, index = 0 }: KPICardProps) {
  const { label, value, format, suffix, trend, trendValue } = data;

  const formattedValue = format === 'percent'
    ? formatPercent(value, 1)
    : format === 'currency'
    ? '$' + formatNumber(value)
    : formatNumber(value, 2);

  const TrendIcon = trend === 'up'
    ? TrendingUp
    : trend === 'down'
    ? TrendingDown
    : Minus;

  const trendColor = trend === 'up'
    ? 'text-emerald-400'
    : trend === 'down'
    ? 'text-red-400'
    : 'text-gray-400';

  const trendBg = trend === 'up'
    ? 'bg-emerald-400/10'
    : trend === 'down'
    ? 'bg-red-400/10'
    : 'bg-gray-400/10';

  return (
    <div
      className="relative rounded-2xl p-5 overflow-hidden group transition-all duration-300 hover:scale-[1.02]"
      style={{ animationDelay: `${index * 0.1}s` }}
    >
      {/* Card background with gradient border effect */}
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.08] to-white/[0.02] rounded-2xl" />
      <div className="absolute inset-[1px] bg-[#12121a] rounded-2xl" />

      {/* Gradient accent on hover */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#00D4FF]/5 to-[#7B61FF]/5 opacity-0 group-hover:opacity-100 transition-opacity duration-300 rounded-2xl" />

      {/* Glow effect */}
      <div className="absolute -top-20 -right-20 w-40 h-40 bg-[#00D4FF]/10 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" />

      <div className="relative z-10">
        <p className="text-[11px] text-white/40 font-medium uppercase tracking-wider mb-3">
          {label}
        </p>

        <div className="flex items-baseline gap-2 mb-3">
          <span className="text-2xl lg:text-3xl font-bold bg-gradient-to-r from-white to-white/80 bg-clip-text text-transparent">
            {formattedValue}
          </span>
          {suffix && format !== 'percent' && (
            <span className="text-sm text-white/30 font-medium">{suffix}</span>
          )}
        </div>

        {trendValue !== undefined && (
          <div className={`inline-flex items-center gap-1.5 px-2 py-1 rounded-lg ${trendBg}`}>
            <TrendIcon className={`w-3.5 h-3.5 ${trendColor}`} />
            <span className={`text-xs font-semibold ${trendColor}`}>
              {trendValue > 0 ? '+' : ''}{trendValue.toFixed(1)}%
            </span>
          </div>
        )}
      </div>

      {/* Bottom gradient line */}
      <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-gradient-to-r from-transparent via-[#00D4FF]/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300" />
    </div>
  );
}

export function KPICardSkeleton() {
  return (
    <div className="relative rounded-2xl p-5 overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-white/[0.08] to-white/[0.02] rounded-2xl" />
      <div className="absolute inset-[1px] bg-[#12121a] rounded-2xl" />
      <div className="relative z-10">
        <div className="skeleton h-3 w-20 rounded mb-3" />
        <div className="skeleton h-8 w-28 rounded mb-3" />
        <div className="skeleton h-6 w-16 rounded" />
      </div>
    </div>
  );
}
