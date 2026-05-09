import { useState } from 'react';
import { Download, ExternalLink, Trophy, Medal, Award, Search, X, ArrowUp, ArrowDown, Minus, Sparkles } from 'lucide-react';
import { formatNumber, formatCurrency, exportToCSV } from '../../utils/formatters';
import { GlowButton } from '../ui/GlowButton';
import type { TopStakerRow } from '../../hooks/useDuneQuery';

interface TopStakersTableProps {
  data: TopStakerRow[];
  isLoading?: boolean;
}

function truncateWallet(wallet: string): string {
  if (!wallet) return '—';
  const cleanWallet = wallet.replace(/^0x0+/, '0x');
  if (cleanWallet.length <= 13) return cleanWallet;
  return `${cleanWallet.slice(0, 6)}...${cleanWallet.slice(-4)}`;
}

function getCleanWalletAddress(wallet: string): string {
  return wallet.replace(/^0x0+/, '0x');
}

function normalizeWallet(wallet: string): string {
  return wallet.replace(/^0x0+/, '0x').toLowerCase();
}

function formatDate(iso: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

/**
 * Pill rendered next to the rank badge showing how the wallet moved
 * relative to the previous Dune snapshot. Sized so the change is legible
 * at a glance — the whole point of the gamification.
 */
function RankChangeChip({ staker }: { staker: TopStakerRow }) {
  // No previous snapshot at all: nothing to compare against
  if (staker.previousSnapshotAt === undefined || staker.previousSnapshotAt === null) {
    return null;
  }

  // Wallet wasn't in the previous snapshot → brand new entrant to the top 300
  if (staker.previousRank == null) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-purple/15 border border-purple/30 text-sm font-bold text-purple"
        title="New to the leaderboard since last snapshot"
      >
        <Sparkles className="w-3.5 h-3.5" />
        NEW
      </span>
    );
  }

  const delta = staker.rankDelta ?? 0;
  if (delta > 0) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-green1/15 border border-green1/30 text-sm font-bold text-green1"
        title={`Up ${delta} ${delta === 1 ? 'spot' : 'spots'} from #${staker.previousRank}`}
      >
        <ArrowUp className="w-3.5 h-3.5" />
        {delta}
      </span>
    );
  }
  if (delta < 0) {
    return (
      <span
        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-red-400/15 border border-red-400/30 text-sm font-bold text-red-400"
        title={`Down ${-delta} ${-delta === 1 ? 'spot' : 'spots'} from #${staker.previousRank}`}
      >
        <ArrowDown className="w-3.5 h-3.5" />
        {-delta}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-white/[0.04] border border-white/[0.08] text-sm font-semibold text-soft-gray"
      title="No change since last snapshot"
    >
      <Minus className="w-3.5 h-3.5" />
    </span>
  );
}

function formatRelativeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || !Number.isFinite(ms)) return iso;
  const hours = ms / (1000 * 60 * 60);
  if (hours < 24) return `${Math.round(hours)}h ago`;
  const days = hours / 24;
  if (days < 30) return `${Math.round(days)}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function getRankDisplay(rank: number) {
  if (rank === 1) {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-soft to-orange1 flex items-center justify-center shadow-lg shadow-orange1/20">
        <Trophy className="w-4 h-4 text-white" />
      </div>
    );
  }
  if (rank === 2) {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-blue-gray to-purple-gray flex items-center justify-center">
        <Medal className="w-4 h-4 text-white" />
      </div>
    );
  }
  if (rank === 3) {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-orange2 to-orange1 flex items-center justify-center">
        <Award className="w-4 h-4 text-white" />
      </div>
    );
  }
  return (
    <div className="w-9 h-9 rounded-xl bg-dark3 flex items-center justify-center border border-white/8">
      <span className="text-sm font-semibold text-soft-gray">#{rank}</span>
    </div>
  );
}

const LOCK_COLORS: Record<string, string> = {
  flexible: '#3B82F6',
  three_months: '#8B5CF6',
  six_months: '#F59E0B',
  twelve_months: '#10B981',
};

function LockBreakdownBar({ staker }: { staker: TopStakerRow }) {
  const total = staker.total_staked || 1;
  const segments = [
    { key: 'twelve_months', label: '12M', value: staker.twelve_months ?? 0, color: LOCK_COLORS.twelve_months },
    { key: 'six_months', label: '6M', value: staker.six_months ?? 0, color: LOCK_COLORS.six_months },
    { key: 'three_months', label: '3M', value: staker.three_months ?? 0, color: LOCK_COLORS.three_months },
    { key: 'flexible', label: 'Flex', value: staker.flexible ?? 0, color: LOCK_COLORS.flexible },
  ].filter(s => s.value > 0);

  return (
    <div className="flex items-center gap-2 min-w-[120px]">
      <div className="flex-1 h-2 bg-dark3 rounded-full overflow-hidden flex">
        {segments.map(s => (
          <div
            key={s.key}
            className="h-full"
            style={{ width: `${(s.value / total) * 100}%`, backgroundColor: s.color }}
            title={`${s.label}: ${formatNumber(s.value)}`}
          />
        ))}
      </div>
    </div>
  );
}

export function TopStakersTable({ data, isLoading }: TopStakersTableProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const handleExport = () => {
    const exportData = data.map(staker => ({
      Rank: staker.rank,
      Wallet: getCleanWalletAddress(staker.wallet),
      'Total Staked': staker.total_staked,
      'USD Value': staker.total_usd,
      'Flexible': staker.flexible,
      '3 Month': staker.three_months,
      '6 Month': staker.six_months,
      '12 Month': staker.twelve_months,
      'Stake Events': staker.total_stake_events,
      'First Stake': staker.first_stake,
      'Last Stake': staker.last_stake,
    }));
    exportToCSV(exportData, 'lingo_top_stakers');
  };

  const trimmed = searchQuery.trim();
  const displayData = trimmed.length > 0
    ? data.filter(s => normalizeWallet(s.wallet).includes(trimmed.toLowerCase()))
    : data;

  const searchResult = trimmed.length > 0 ? displayData[0] ?? null : null;
  const isSearchActive = trimmed.length > 0;

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-white/5 relative z-10">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Top Stakers Leaderboard</h3>
          <p className="text-sm text-soft-gray mt-1">
            Top 300 wallets by LINGO staked (USD value, 12-month lock)
            {data && data[0]?.previousSnapshotAt && (
              <span className="text-purple-gray"> &bull; rank changes vs {formatRelativeAgo(data[0].previousSnapshotAt)}</span>
            )}
          </p>
        </div>
        <GlowButton
          onClick={handleExport}
          disabled={!data || data.length === 0}
        >
          <Download className="w-4 h-4" />
          <span className="text-sm">Export</span>
        </GlowButton>
      </div>

      {/* Lock duration legend */}
      <div className="flex items-center gap-4 px-6 pt-4 pb-2 relative z-10">
        {[
          { label: '12 Month', color: LOCK_COLORS.twelve_months },
          { label: '6 Month', color: LOCK_COLORS.six_months },
          { label: '3 Month', color: LOCK_COLORS.three_months },
          { label: 'Flexible', color: LOCK_COLORS.flexible },
        ].map(({ label, color }) => (
          <div key={label} className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: color }} />
            <span className="text-xs text-soft-gray">{label}</span>
          </div>
        ))}
      </div>

      {/* Search bar */}
      <div className="px-6 py-3 border-b border-white/5 relative z-10">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-soft-gray pointer-events-none" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search wallet address…"
            className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl pl-9 pr-9 py-2.5 text-sm text-lavender placeholder-soft-gray/50 focus:outline-none focus:border-purple/50 focus:bg-white/[0.06] transition-all font-mono"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-soft-gray hover:text-lavender transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          )}
        </div>

        {isSearchActive && (
          <div className="mt-2">
            {searchResult ? (
              <p className="text-xs text-green1">
                Found at rank <span className="font-semibold">#{searchResult.rank}</span> — {formatNumber(searchResult.total_staked)} LINGO ({formatCurrency(searchResult.total_usd)})
              </p>
            ) : (
              <p className="text-xs text-red-400">Wallet not found in top 300</p>
            )}
          </div>
        )}
      </div>

      {/* Table */}
      <div className="max-h-[600px] overflow-y-auto relative z-10">
        <table className="w-full">
          <thead className="sticky top-0 z-10" style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6">Rank</th>
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">Wallet</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">Total Staked</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">USD Value</th>
              <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">Lock Breakdown</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">Events</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6">Last Stake</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(10)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-4 px-6"><div className="skeleton w-9 h-9 rounded-xl" /></td>
                  <td className="py-4 px-4"><div className="skeleton h-5 w-28 rounded" /></td>
                  <td className="py-4 px-4"><div className="skeleton h-5 w-24 rounded ml-auto" /></td>
                  <td className="py-4 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  <td className="py-4 px-4"><div className="skeleton h-2 w-24 rounded mx-auto" /></td>
                  <td className="py-4 px-4"><div className="skeleton h-5 w-10 rounded ml-auto" /></td>
                  <td className="py-4 px-6"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                </tr>
              ))
            ) : (
              displayData.map((staker) => (
                <tr
                  key={staker.wallet}
                  className={`border-b border-white/5 hover:bg-white/[0.02] transition-colors group ${
                    isSearchActive && searchResult?.wallet === staker.wallet ? 'bg-purple/5 border-purple/20' : ''
                  }`}
                >
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-2.5">
                      {getRankDisplay(staker.rank)}
                      <RankChangeChip staker={staker} />
                    </div>
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple/20 to-sosiska/20 flex items-center justify-center border border-white/8">
                        <span className="text-xs font-medium text-purple">
                          {truncateWallet(staker.wallet).slice(2, 4).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-lavender/80 group-hover:text-lavender transition-colors">
                          {truncateWallet(staker.wallet)}
                        </span>
                        <a
                          href={`https://etherscan.io/address/${getCleanWalletAddress(staker.wallet)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white/20 hover:text-purple transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-right">
                    <span className="font-semibold text-lavender">
                      {formatNumber(staker.total_staked)}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right text-soft-gray">
                    {formatCurrency(staker.total_usd)}
                  </td>
                  <td className="py-4 px-4">
                    <LockBreakdownBar staker={staker} />
                  </td>
                  <td className="py-4 px-4 text-right text-soft-gray text-sm">
                    {staker.total_stake_events}
                  </td>
                  <td className="py-4 px-6 text-right text-soft-gray text-sm">
                    {formatDate(staker.last_stake)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Footer */}
      {data && data.length > 0 && (
        <div className="px-6 py-4 border-t border-white/5 bg-white/[0.02] relative z-10">
          <p className="text-xs text-purple-gray text-center">
            Showing {isSearchActive ? `${displayData.length} result${displayData.length !== 1 ? 's' : ''} of ` : ''}{data.length} wallets &bull; Data from Dune Analytics
          </p>
        </div>
      )}
    </div>
  );
}
