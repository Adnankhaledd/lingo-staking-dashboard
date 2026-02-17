import type { MembershipTiersRow } from '../../hooks/useDuneQuery';

interface MembershipTiersTableProps {
  data: MembershipTiersRow[] | null;
  isLoading?: boolean;
}

const TIER_CONFIG = [
  { key: 'users_5000_plus' as const, label: 'Diamond', threshold: '$5,000+', color: 'text-cyan-300', bg: 'bg-cyan-400/20' },
  { key: 'users_1000_plus' as const, label: 'Gold', threshold: '$1,000+', color: 'text-yellow-400', bg: 'bg-yellow-400/20' },
  { key: 'users_500_plus' as const, label: 'Silver', threshold: '$500+', color: 'text-gray-300', bg: 'bg-gray-400/20' },
  { key: 'users_100_plus' as const, label: 'Bronze', threshold: '$100+', color: 'text-orange-400', bg: 'bg-orange-400/20' },
];

// Preferred display order for lock periods
const LOCK_ORDER = ['Flexible', '3 Months', '6 Months', '12 Months'];

export function MembershipTiersTable({ data, isLoading }: MembershipTiersTableProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="skeleton h-12 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="h-[200px] flex items-center justify-center text-white/40">
        No membership data available
      </div>
    );
  }

  const sorted = [...data].sort((a, b) => {
    const ai = LOCK_ORDER.indexOf(a.lock_period);
    const bi = LOCK_ORDER.indexOf(b.lock_period);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  // Calculate totals across all lock periods
  const totals = {
    users_100_plus: sorted.reduce((s, r) => s + r.users_100_plus, 0),
    users_500_plus: sorted.reduce((s, r) => s + r.users_500_plus, 0),
    users_1000_plus: sorted.reduce((s, r) => s + r.users_1000_plus, 0),
    users_5000_plus: sorted.reduce((s, r) => s + r.users_5000_plus, 0),
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-white/10">
            <th className="text-left text-sm font-medium text-white/50 pb-4 pr-4">
              Lock Period
            </th>
            {TIER_CONFIG.map(tier => (
              <th key={tier.key} className="text-right text-sm font-medium text-white/50 pb-4 px-4">
                <span className={tier.color}>{tier.label}</span>
                <span className="block text-xs text-white/30">{tier.threshold}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => (
            <tr
              key={row.lock_period}
              className="border-b border-white/5 hover:bg-white/5 transition-colors"
            >
              <td className="py-3 pr-4">
                <span className="text-sm font-medium text-white">
                  {row.lock_period}
                </span>
              </td>
              {TIER_CONFIG.map(tier => (
                <td key={tier.key} className="py-3 px-4 text-right">
                  <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-lg text-sm font-semibold ${tier.bg} ${tier.color}`}>
                    {row[tier.key].toLocaleString()}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Totals */}
      <div className="mt-4 pt-4 border-t border-white/10">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium text-white">Total</span>
          <div className="flex items-center gap-6">
            {TIER_CONFIG.map(tier => (
              <span key={tier.key} className={`inline-flex items-center gap-1 text-sm ${tier.color}`}>
                {tier.label}: {totals[tier.key].toLocaleString()}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
