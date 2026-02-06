import type { MonthlyRetentionData } from '../../utils/dataTransformers';

interface RetentionTableProps {
  data: MonthlyRetentionData[];
  isLoading?: boolean;
}

function getRetentionColor(value: number): string {
  if (value >= 85) return 'text-emerald-400';
  if (value >= 75) return 'text-cyan-400';
  if (value >= 65) return 'text-yellow-400';
  if (value >= 50) return 'text-orange-400';
  return 'text-red-400';
}

function getRetentionBg(value: number): string {
  if (value >= 85) return 'bg-emerald-400/20';
  if (value >= 75) return 'bg-cyan-400/20';
  if (value >= 65) return 'bg-yellow-400/20';
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

  // Calculate totals
  const totalNewStakers = data.reduce((sum, d) => sum + d.newStakers, 0);
  const totalStillStaking = data.reduce((sum, d) => sum + d.stillStaking, 0);
  const overallRetention = totalNewStakers > 0
    ? Math.round((totalStillStaking / totalNewStakers) * 1000) / 10
    : 0;

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left text-sm font-medium text-white/50 pb-4 pr-4">
              Cohort
            </th>
            <th className="text-right text-sm font-medium text-white/50 pb-4 px-4">
              New Stakers
            </th>
            <th className="text-right text-sm font-medium text-white/50 pb-4 px-4">
              Still Staking
            </th>
            <th className="text-right text-sm font-medium text-white/50 pb-4 pl-4">
              Retention
            </th>
          </tr>
        </thead>
        <tbody>
          {data.map((row) => (
            <tr
              key={row.month}
              className="border-b border-white/5 hover:bg-white/5 transition-colors"
            >
              <td className="py-3 pr-4">
                <span className="text-sm font-medium text-white">
                  {row.month}
                </span>
              </td>
              <td className="py-3 px-4 text-right">
                <span className="text-sm text-white/70">
                  {row.newStakers.toLocaleString()}
                </span>
              </td>
              <td className="py-3 px-4 text-right">
                <span className="text-sm text-emerald-400">
                  {row.stillStaking.toLocaleString()}
                </span>
              </td>
              <td className="py-3 pl-4 text-right">
                <span
                  className={`
                    inline-flex items-center justify-center
                    px-3 py-1 rounded-lg text-sm font-semibold
                    ${getRetentionBg(row.retentionPct)}
                    ${getRetentionColor(row.retentionPct)}
                  `}
                >
                  {row.retentionPct}%
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="mt-4 pt-4 border-t border-white/10">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white">Total</span>
          <div className="flex items-center gap-8">
            <span className="text-sm text-white/70">
              {totalNewStakers.toLocaleString()} stakers
            </span>
            <span className="text-sm text-emerald-400">
              {totalStillStaking.toLocaleString()} still staking
            </span>
            <span
              className={`
                inline-flex items-center justify-center
                px-3 py-1 rounded-lg text-sm font-semibold
                ${getRetentionBg(overallRetention)}
                ${getRetentionColor(overallRetention)}
              `}
            >
              {overallRetention}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
