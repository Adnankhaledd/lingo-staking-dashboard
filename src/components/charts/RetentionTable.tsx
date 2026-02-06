import type { MonthlyRetentionData } from '../../utils/dataTransformers';

interface RetentionTableProps {
  data: MonthlyRetentionData[];
  isLoading?: boolean;
}

function getRetentionColor(value: number): string {
  if (value >= 80) return 'text-emerald-400';
  if (value >= 70) return 'text-cyan-400';
  if (value >= 60) return 'text-yellow-400';
  if (value >= 50) return 'text-orange-400';
  return 'text-red-400';
}

function getRetentionBg(value: number): string {
  if (value >= 80) return 'bg-emerald-400/20';
  if (value >= 70) return 'bg-cyan-400/20';
  if (value >= 60) return 'bg-yellow-400/20';
  if (value >= 50) return 'bg-orange-400/20';
  return 'bg-red-400/20';
}

export function RetentionTable({ data, isLoading }: RetentionTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="skeleton h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-white/40">
        No retention data available
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left text-sm font-medium text-white/50 pb-4 pr-4">
              Cohort Month
            </th>
            <th className="text-right text-sm font-medium text-white/50 pb-4 px-4">
              Users
            </th>
            <th className="text-right text-sm font-medium text-white/50 pb-4 pl-4">
              Retained
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={row.month}
              className="border-b border-white/5 hover:bg-white/5 transition-colors"
            >
              <td className="py-4 pr-4">
                <span className="text-sm font-medium text-white">
                  {row.month}
                </span>
              </td>
              <td className="py-4 px-4 text-right">
                <span className="text-sm text-white/70">
                  {row.cohortSize.toLocaleString()}
                </span>
              </td>
              <td className="py-4 pl-4 text-right">
                <span
                  className={`
                    inline-flex items-center justify-center
                    px-3 py-1.5 rounded-lg text-sm font-semibold
                    ${getRetentionBg(row.retained)}
                    ${getRetentionColor(row.retained)}
                  `}
                >
                  {row.retained}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Summary */}
      <div className="mt-6 pt-4 border-t border-white/10">
        <div className="flex items-center justify-between text-sm">
          <span className="text-white/50">Average Retention</span>
          <span className={`font-semibold ${getRetentionColor(
            data.reduce((sum, d) => sum + d.retained, 0) / data.length
          )}`}>
            {(data.reduce((sum, d) => sum + d.retained, 0) / data.length).toFixed(1)}%
          </span>
        </div>
      </div>
    </div>
  );
}
