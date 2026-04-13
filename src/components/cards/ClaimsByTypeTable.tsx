import { useMemo } from 'react';
import { formatNumber } from '../../utils/formatters';
import type { ClaimsByTypeRow } from '../../hooks/useDuneQuery';

interface ClaimsByTypeTableProps {
  data: ClaimsByTypeRow[];
  isLoading?: boolean;
}

function formatTypeName(raw: string): string {
  // "PrivateRoundF" → "Private Round F", "LingoIslandsAirdrop" → "Lingo Islands Airdrop"
  return raw.replace(/([a-z])([A-Z])/g, '$1 $2');
}

export function ClaimsByTypeTable({ data, isLoading }: ClaimsByTypeTableProps) {
  const sorted = useMemo(() => {
    if (!data || data.length === 0) return [];
    return [...data].sort((a, b) => b.total_claimed - a.total_claimed);
  }, [data]);

  const totals = useMemo(() => {
    if (sorted.length === 0) return null;
    return {
      claimers: sorted.reduce((s, r) => s + r.num_claimers, 0),
      allocated: sorted.reduce((s, r) => s + r.total_allocated_known, 0),
      claimed: sorted.reduce((s, r) => s + r.total_claimed, 0),
      remaining: sorted.reduce((s, r) => s + r.remaining_to_claim, 0),
    };
  }, [sorted]);

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header */}
      <div className="p-6 border-b border-white/5 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">Claims by Type</h3>
        <p className="text-sm text-soft-gray mt-1">Allocation breakdown by beneficiary category</p>
      </div>

      {/* Table */}
      <div className="relative z-10 overflow-x-auto">
        <table className="w-full">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Type
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Claimers
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Allocated
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Claimed
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Remaining
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                % Claimed
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(6)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-32 rounded" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-14 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  <td className="py-3 px-6"><div className="skeleton h-5 w-14 rounded ml-auto" /></td>
                </tr>
              ))
            ) : (
              sorted.map(row => (
                <tr
                  key={row.beneficiary_type}
                  className="border-b border-white/5 hover:bg-white/[0.02] transition-colors"
                >
                  <td className="py-3 px-6">
                    <span className="text-sm font-medium text-lavender">
                      {formatTypeName(row.beneficiary_type)}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {formatNumber(row.num_claimers)}
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {formatNumber(Math.round(row.total_allocated_known))}
                  </td>
                  <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                    {formatNumber(Math.round(row.total_claimed))}
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {formatNumber(Math.round(row.remaining_to_claim))}
                  </td>
                  <td className="py-3 px-6 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${Math.min(100, row.pct_claimed)}%`,
                            background: row.pct_claimed >= 75 ? '#5EB851' : row.pct_claimed >= 50 ? '#E8B100' : '#7B68AE',
                          }}
                        />
                      </div>
                      <span className="text-sm text-soft-gray w-12 text-right">
                        {row.pct_claimed.toFixed(1)}%
                      </span>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
          {/* Totals row */}
          {totals && (
            <tfoot>
              <tr className="border-t border-white/10 bg-white/[0.02]">
                <td className="py-3 px-6 text-sm font-semibold text-lavender">Total</td>
                <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                  {formatNumber(totals.claimers)}
                </td>
                <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                  {formatNumber(Math.round(totals.allocated))}
                </td>
                <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                  {formatNumber(Math.round(totals.claimed))}
                </td>
                <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                  {formatNumber(Math.round(totals.remaining))}
                </td>
                <td className="py-3 px-6 text-right text-sm font-semibold text-lavender">
                  {totals.allocated > 0 ? ((totals.claimed / totals.allocated) * 100).toFixed(1) : '0.0'}%
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
