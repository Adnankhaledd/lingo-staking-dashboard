import type { ReactNode } from 'react';
import { Download, Clock } from 'lucide-react';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onExport?: () => void;
  isLoading?: boolean;
  className?: string;
  lastUpdated?: string | null;
}

function formatLastUpdated(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ChartCard({
  title,
  subtitle,
  children,
  onExport,
  isLoading,
  className = '',
  lastUpdated,
}: ChartCardProps) {
  return (
    <div className={`glass rounded-2xl p-6 ${className}`}>
      <div className="flex items-start justify-between mb-6">
        <div>
          <h3 className="text-lg font-semibold text-white">{title}</h3>
          {subtitle && (
            <p className="text-sm text-white/40 mt-1">{subtitle}</p>
          )}
        </div>

        <div className="flex items-center gap-2">
          {lastUpdated && (
            <div className="flex items-center gap-1 text-xs text-white/30" title={`Query executed: ${new Date(lastUpdated).toLocaleString()}`}>
              <Clock className="w-3 h-3" />
              <span>{formatLastUpdated(lastUpdated)}</span>
            </div>
          )}
          {onExport && (
            <button
              onClick={onExport}
              className="p-2 rounded-lg hover:bg-white/5 text-white/40 hover:text-white/70 transition-colors"
              title="Export to CSV"
            >
              <Download className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="relative">
        {children}

        {isLoading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-sm rounded-xl">
            <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>
    </div>
  );
}

export function ChartCardSkeleton({ className = '' }: { className?: string }) {
  return (
    <div className={`glass rounded-2xl p-6 ${className}`}>
      <div className="flex items-start justify-between mb-6">
        <div>
          <div className="skeleton h-6 w-40 rounded mb-2" />
          <div className="skeleton h-4 w-24 rounded" />
        </div>
      </div>
      <div className="skeleton h-64 rounded-xl" />
    </div>
  );
}
