import type { ReactNode } from 'react';
import { Download } from 'lucide-react';

interface ChartCardProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onExport?: () => void;
  isLoading?: boolean;
  className?: string;
}

export function ChartCard({
  title,
  subtitle,
  children,
  onExport,
  isLoading,
  className = '',
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
