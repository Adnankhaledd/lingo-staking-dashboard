import type { LucideIcon } from 'lucide-react';

interface MixpanelKPICardProps {
  title: string;
  value: number;
  icon: LucideIcon;
  color?: string;
  isLoading?: boolean;
  changePercent?: number | null;
  formatValue?: (v: number) => string;
}

export function MixpanelKPICard({
  title,
  value,
  icon: Icon,
  color = '#C4B5D4',
  isLoading,
  changePercent,
  formatValue,
}: MixpanelKPICardProps) {
  if (isLoading) {
    return (
      <div className="glass-card rounded-2xl p-6">
        <div className="flex items-center justify-between mb-4">
          <div className="skeleton h-4 w-24 rounded" />
          <div className="skeleton h-10 w-10 rounded-xl" />
        </div>
        <div className="skeleton h-8 w-32 rounded" />
      </div>
    );
  }

  const displayValue = formatValue ? formatValue(value) : value.toLocaleString();

  return (
    <div className="glass-card rounded-2xl p-6 hover:border-white/15 transition-all duration-300">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-soft-gray">{title}</span>
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: `${color}18` }}
        >
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
      </div>
      <div className="flex items-baseline gap-2">
        <span className="text-2xl font-bold text-lavender">
          {displayValue}
        </span>
        {changePercent != null && changePercent !== 0 && (
          <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${
            changePercent > 0
              ? 'text-green1 bg-green1/10'
              : 'text-red-400 bg-red-400/10'
          }`}>
            {changePercent > 0 ? '+' : ''}{changePercent.toFixed(1)}%
          </span>
        )}
      </div>
    </div>
  );
}
