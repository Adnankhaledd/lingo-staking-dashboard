import { Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

interface MixpanelKPICardProps {
  title: string;
  value: number;
  icon: LucideIcon;
  color?: string;
  isLoading?: boolean;
  changePercent?: number | null;
  formatValue?: (v: number) => string;
  userCount?: number | null;
}

export function MixpanelKPICard({
  title,
  value,
  icon: Icon,
  color = '#C4B5D4',
  isLoading,
  changePercent,
  formatValue,
  userCount,
}: MixpanelKPICardProps) {
  if (isLoading) {
    return (
      <div className="flagship-card p-6">
        <div className="flex items-center justify-between mb-4 relative z-10">
          <div className="skeleton h-4 w-24 rounded" />
          <div className="skeleton h-10 w-10 rounded-xl" />
        </div>
        <div className="skeleton h-8 w-32 rounded relative z-10" />
      </div>
    );
  }

  const displayValue = formatValue ? formatValue(value) : value.toLocaleString();

  return (
    <div className="flagship-card p-6 group transition-all duration-300 hover:scale-[1.02]">
      {/* Glow effect on hover */}
      <div className="absolute -top-16 -right-16 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500" style={{ backgroundColor: `${color}15` }} />

      <div className="relative z-10">
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
          {changePercent != null && (
            <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${
              changePercent > 0
                ? 'text-green1 bg-green1/10'
                : changePercent < 0
                  ? 'text-red-400 bg-red-400/10'
                  : 'text-soft-gray bg-white/5'
            }`}>
              {changePercent > 0 ? '+' : ''}{changePercent === 0 ? '0.0' : changePercent.toFixed(1)}%
            </span>
          )}
        </div>
        {userCount != null && userCount > 0 && (
          <div className="flex items-center gap-1.5 mt-2">
            <Users className="w-3 h-3 text-purple-gray" />
            <span className="text-xs text-purple-gray">
              {userCount.toLocaleString()} users
            </span>
          </div>
        )}
      </div>

      {/* Bottom gradient line */}
      <div className="absolute bottom-0 left-4 right-4 h-[2px] bg-gradient-to-r from-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 z-10" style={{ backgroundImage: `linear-gradient(to right, transparent, ${color}40, transparent)` }} />
    </div>
  );
}
