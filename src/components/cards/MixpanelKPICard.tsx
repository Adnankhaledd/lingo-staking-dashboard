import type { LucideIcon } from 'lucide-react';

interface MixpanelKPICardProps {
  title: string;
  value: number;
  icon: LucideIcon;
  color?: string;
  isLoading?: boolean;
}

export function MixpanelKPICard({
  title,
  value,
  icon: Icon,
  color = '#00D4FF',
  isLoading,
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

  return (
    <div className="glass-card rounded-2xl p-6 hover:border-white/20 transition-all duration-300">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm text-gray-400">{title}</span>
        <div
          className="w-10 h-10 rounded-xl flex items-center justify-center"
          style={{ backgroundColor: `${color}20` }}
        >
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
      </div>
      <div className="text-2xl font-bold text-white">
        {value.toLocaleString()}
      </div>
    </div>
  );
}
