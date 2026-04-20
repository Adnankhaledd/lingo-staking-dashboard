import { useMemo } from 'react';
import { Users } from 'lucide-react';
import { formatNumber, formatCurrency } from '../../utils/formatters';
import type { TopStakerRow } from '../../hooks/useDuneQuery';

interface StakerConcentrationCardProps {
  topStakers: TopStakerRow[] | null;
  totalStakedAllWallets: number | null; // from the live contract balance (useLiveTotalStaked)
  isLoading?: boolean;
}

const TIERS = [10, 50, 100, 200, 300] as const;

interface TierStat {
  tier: number;
  count: number;       // actual count (may be lower than tier if dataset smaller)
  lingo: number;
  usd: number;
  pctOfTotal: number | null; // null when total denominator unknown
}

function computeTiers(topStakers: TopStakerRow[], total: number | null): TierStat[] {
  // Defensive: sort by total_staked desc in case the rank isn't pre-sorted
  const sorted = [...topStakers].sort((a, b) => (b.total_staked ?? 0) - (a.total_staked ?? 0));
  return TIERS.map(tier => {
    const slice = sorted.slice(0, tier);
    const lingo = slice.reduce((s, r) => s + (r.total_staked ?? 0), 0);
    const usd = slice.reduce((s, r) => s + (r.total_usd ?? 0), 0);
    const pct = total && total > 0 ? (lingo / total) * 100 : null;
    return {
      tier,
      count: slice.length,
      lingo: Math.round(lingo),
      usd: Math.round(usd * 100) / 100,
      pctOfTotal: pct,
    };
  });
}

export function StakerConcentrationCard({
  topStakers,
  totalStakedAllWallets,
  isLoading,
}: StakerConcentrationCardProps) {
  const tiers = useMemo(
    () => (topStakers ? computeTiers(topStakers, totalStakedAllWallets) : []),
    [topStakers, totalStakedAllWallets],
  );

  if (isLoading) {
    return (
      <div className="flagship-card rounded-2xl p-6">
        <div className="skeleton h-6 w-48 rounded mb-2 relative z-10" />
        <div className="skeleton h-4 w-64 rounded mb-6 relative z-10" />
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 relative z-10">
          {TIERS.map(t => (
            <div key={t} className="skeleton h-24 rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flagship-card rounded-2xl p-6">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 relative z-10 flex-wrap gap-3">
        <div className="flex items-start gap-3">
          <div className="w-9 h-9 rounded-xl bg-purple/15 border border-purple/25 flex items-center justify-center">
            <Users className="w-4 h-4 text-purple" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-lavender">Staker Concentration</h3>
            <p className="text-sm text-soft-gray mt-0.5">
              How much of total staked LINGO the top N wallets control
            </p>
          </div>
        </div>
        {totalStakedAllWallets != null && totalStakedAllWallets > 0 && (
          <div className="text-right">
            <p className="text-xs text-soft-gray uppercase tracking-wider">Total Staked</p>
            <p className="text-lg font-semibold text-lavender">{formatNumber(totalStakedAllWallets)} LINGO</p>
          </div>
        )}
      </div>

      {/* Tier pills */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 relative z-10">
        {tiers.map(t => (
          <div
            key={t.tier}
            className="rounded-xl bg-white/[0.02] border border-white/[0.06] p-4 hover:bg-white/[0.04] transition-colors"
          >
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">
                Top {t.tier}
              </span>
              {t.count < t.tier && (
                <span className="text-[10px] text-purple-gray" title={`Only ${t.count} wallets in dataset`}>
                  ({t.count})
                </span>
              )}
            </div>
            <p className="text-lg font-bold text-lavender">{formatNumber(t.lingo)}</p>
            <p className="text-[11px] text-purple-gray mt-0.5">{formatCurrency(t.usd)}</p>

            {/* Percentage with mini progress bar */}
            {t.pctOfTotal != null && (
              <>
                <div className="mt-2 h-1 rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{
                      width: `${Math.min(100, t.pctOfTotal)}%`,
                      background: t.pctOfTotal >= 50
                        ? 'linear-gradient(90deg, #E85757, #FF7847)'
                        : t.pctOfTotal >= 25
                          ? 'linear-gradient(90deg, #E8B100, #FF7847)'
                          : 'linear-gradient(90deg, #7B68AE, #5EB851)',
                    }}
                  />
                </div>
                <p className="text-xs text-soft-gray mt-1">
                  <span className="text-lavender font-semibold">{t.pctOfTotal.toFixed(1)}%</span>
                  <span className="text-purple-gray"> of total</span>
                </p>
              </>
            )}
          </div>
        ))}
      </div>

      {totalStakedAllWallets == null && (
        <p className="mt-4 text-xs text-purple-gray relative z-10">
          % of total unavailable — waiting for live total staked from contract.
        </p>
      )}
    </div>
  );
}
