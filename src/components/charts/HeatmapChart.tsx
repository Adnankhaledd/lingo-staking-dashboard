import { useMemo } from 'react';
import type { RetentionCohortData } from '../../types';

interface HeatmapChartProps {
  data: RetentionCohortData[];
  height?: number;
}

function getColorIntensity(value: number): string {
  // Color scale from dark to bright cyan
  if (value >= 90) return 'bg-cyan-400/90';
  if (value >= 80) return 'bg-cyan-400/70';
  if (value >= 70) return 'bg-cyan-400/55';
  if (value >= 60) return 'bg-cyan-500/45';
  if (value >= 50) return 'bg-cyan-500/35';
  if (value >= 40) return 'bg-cyan-600/30';
  if (value >= 30) return 'bg-cyan-700/25';
  if (value >= 20) return 'bg-cyan-800/20';
  return 'bg-cyan-900/15';
}

function getTextColor(value: number): string {
  if (value >= 60) return 'text-white';
  return 'text-white/70';
}

export function HeatmapChart({ data }: HeatmapChartProps) {
  const columns = useMemo(() => [
    { key: 'week0', label: 'Week 0' },
    { key: 'week1', label: 'Week 1' },
    { key: 'week2', label: 'Week 2' },
    { key: 'week3', label: 'Week 3' },
    { key: 'week4Plus', label: 'Week 4+' },
  ], []);

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[500px]">
        <thead>
          <tr>
            <th className="text-left text-sm font-medium text-white/40 pb-4 pr-4">
              Cohort
            </th>
            {columns.map((col) => (
              <th
                key={col.key}
                className="text-center text-sm font-medium text-white/40 pb-4 px-2"
              >
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.map((row, rowIndex) => (
            <tr key={rowIndex}>
              <td className="text-sm text-white/70 py-2 pr-4 font-medium">
                {row.cohort}
              </td>
              {columns.map((col) => {
                const value = row[col.key as keyof RetentionCohortData] as number;
                return (
                  <td key={col.key} className="p-1">
                    <div
                      className={`
                        ${getColorIntensity(value)}
                        ${getTextColor(value)}
                        rounded-lg px-3 py-3
                        text-center text-sm font-semibold
                        transition-all duration-200
                        hover:scale-105 hover:shadow-lg hover:shadow-cyan-500/20
                        cursor-default
                      `}
                      title={`${row.cohort} - ${col.label}: ${value}%`}
                    >
                      {value}%
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Legend */}
      <div className="flex items-center justify-center gap-2 mt-6">
        <span className="text-xs text-white/40">Lower</span>
        <div className="flex gap-1">
          {[15, 25, 35, 45, 55, 70, 90].map((value) => (
            <div
              key={value}
              className={`w-6 h-3 rounded ${getColorIntensity(value)}`}
              title={`${value}%`}
            />
          ))}
        </div>
        <span className="text-xs text-white/40">Higher</span>
      </div>
    </div>
  );
}

export function HeatmapSkeleton() {
  return (
    <div className="space-y-2">
      {[...Array(6)].map((_, i) => (
        <div key={i} className="flex gap-2">
          <div className="skeleton h-10 w-20 rounded" />
          <div className="skeleton h-10 flex-1 rounded" />
          <div className="skeleton h-10 flex-1 rounded" />
          <div className="skeleton h-10 flex-1 rounded" />
          <div className="skeleton h-10 flex-1 rounded" />
          <div className="skeleton h-10 flex-1 rounded" />
        </div>
      ))}
    </div>
  );
}
