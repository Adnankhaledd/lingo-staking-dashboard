import type { StakingTiersByLockRow } from '../../hooks/useDuneQuery';
import { formatNumber } from '../../utils/formatters';

interface StakingTiersByLockTableProps {
  data: StakingTiersByLockRow[] | null;
  isLoading?: boolean;
}

const LOCK_PERIODS = [
  { usersKey: 'flexible_users', lingoKey: 'flexible_lingo', label: 'Flexible', color: 'text-emerald-400', bg: 'bg-emerald-400/15' },
  { usersKey: '3mo_users', lingoKey: '3mo_lingo', label: '3 Months', color: 'text-blue-400', bg: 'bg-blue-400/15' },
  { usersKey: '6mo_users', lingoKey: '6mo_lingo', label: '6 Months', color: 'text-purple', bg: 'bg-purple/15' },
  { usersKey: '12mo_users', lingoKey: '12mo_lingo', label: '12 Months', color: 'text-amber-400', bg: 'bg-amber-400/15' },
] as const;

const THRESHOLD_CONFIG: Record<string, { label: string; color: string; icon: string }> = {
  '$100+':  { label: 'Bronze',  color: 'text-orange-400', icon: '🥉' },
  '$500+':  { label: 'Silver',  color: 'text-gray-300',   icon: '🥈' },
  '$1000+': { label: 'Gold',    color: 'text-yellow-400', icon: '🥇' },
};

// Order thresholds from highest to lowest
const THRESHOLD_ORDER = ['$1000+', '$500+', '$100+'];

export function StakingTiersByLockTable({ data, isLoading }: StakingTiersByLockTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="skeleton h-16 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-white/40">
        No staking tier data available
      </div>
    );
  }

  // Sort by threshold order
  const sorted = [...data].sort((a, b) => {
    const ai = THRESHOLD_ORDER.indexOf(a.threshold);
    const bi = THRESHOLD_ORDER.indexOf(b.threshold);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  const priceUsed = sorted[0]?.price_used ?? 0;

  return (
    <div className="space-y-4">
      {/* Price info */}
      {priceUsed > 0 && (
        <div className="text-xs text-white/30 text-right">
          LINGO price used: ${priceUsed.toFixed(4)}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-white/10">
              <th className="text-left text-xs font-medium text-white/50 pb-3 pr-4 uppercase tracking-wider">
                Tier
              </th>
              {LOCK_PERIODS.map(lp => (
                <th key={lp.label} className="text-center text-xs font-medium text-white/50 pb-3 px-2 uppercase tracking-wider">
                  <span className={lp.color}>{lp.label}</span>
                </th>
              ))}
              <th className="text-center text-xs font-medium text-white/50 pb-3 pl-4 uppercase tracking-wider">
                Total
              </th>
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const config = THRESHOLD_CONFIG[row.threshold] ?? { label: row.threshold, color: 'text-white', icon: '' };
              return (
                <tr
                  key={row.threshold}
                  className="border-b border-white/5 hover:bg-white/[0.03] transition-colors"
                >
                  {/* Tier label */}
                  <td className="py-4 pr-4">
                    <div className="flex items-center gap-2">
                      <span className="text-base">{config.icon}</span>
                      <div>
                        <span className={`text-sm font-semibold ${config.color}`}>
                          {config.label}
                        </span>
                        <span className="block text-xs text-white/30">{row.threshold} USD</span>
                      </div>
                    </div>
                  </td>

                  {/* Lock period cells */}
                  {LOCK_PERIODS.map(lp => {
                    const users = row[lp.usersKey] as number;
                    const lingo = row[lp.lingoKey] as number;
                    return (
                      <td key={lp.label} className="py-4 px-2 text-center">
                        <div className={`inline-flex flex-col items-center rounded-xl px-3 py-1.5 ${lp.bg}`}>
                          <span className={`text-sm font-bold ${lp.color}`}>
                            {users.toLocaleString()}
                          </span>
                          <span className="text-[10px] text-white/40">
                            {formatNumber(lingo)} LINGO
                          </span>
                        </div>
                      </td>
                    );
                  })}

                  {/* Total */}
                  <td className="py-4 pl-4 text-center">
                    <div className="inline-flex flex-col items-center">
                      <span className="text-sm font-bold text-white">
                        {row.total_users.toLocaleString()}
                      </span>
                      <span className="text-[10px] text-white/40">
                        {formatNumber(row.total_lingo)} LINGO
                      </span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Totals row */}
      <div className="pt-3 border-t border-white/10">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <span className="text-xs font-medium text-white/40 uppercase tracking-wider">All Tiers Combined</span>
          <div className="flex items-center gap-4">
            {LOCK_PERIODS.map(lp => {
              const totalUsers = sorted.reduce((s, r) => s + (r[lp.usersKey] as number), 0);
              return (
                <span key={lp.label} className={`text-xs ${lp.color}`}>
                  {lp.label}: <span className="font-semibold">{totalUsers.toLocaleString()}</span>
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
