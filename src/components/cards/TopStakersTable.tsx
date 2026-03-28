import { useState } from 'react';
import { Download, ExternalLink, Trophy, Medal, Award, Search, X } from 'lucide-react';
import { formatNumber, formatCurrency, exportToCSV } from '../../utils/formatters';
import { GlowButton } from '../ui/GlowButton';
import type { TopStakerRow } from '../../hooks/useDuneQuery';

interface TopStakersTableProps {
  data: TopStakerRow[];
  isLoading?: boolean;
}

function truncateWallet(wallet: string): string {
  if (!wallet) return '—';
  // Remove leading zeros from Dune's format
  const cleanWallet = wallet.replace(/^0x0+/, '0x');
  if (cleanWallet.length <= 13) return cleanWallet;
  return `${cleanWallet.slice(0, 6)}...${cleanWallet.slice(-4)}`;
}

function getCleanWalletAddress(wallet: string): string {
  // Remove leading zeros for etherscan link
  return wallet.replace(/^0x0+/, '0x');
}

function normalizeWallet(wallet: string): string {
  return wallet.replace(/^0x0+/, '0x').toLowerCase();
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

export function TopStakersTable({ data, isLoading }: TopStakersTableProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const hasLocalCuration = data.some(s => s.local_curation);

  const handleExport = () => {
    const exportData = data.map(staker => ({
      Rank: staker.rank,
      Wallet: getCleanWalletAddress(staker.wallet),
      'LINGO Staked': staker.lingo_staked,
      'USD Value': staker.usd_value,
      '% of Total': staker.pct_of_total,
      ...(hasLocalCuration ? { 'Local Curation': staker.local_curation ?? '' } : {}),
    }));
    exportToCSV(exportData, 'lingo_top_stakers');
  };

  // Filter: if search is active, show only matching wallet; otherwise show all
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
          <p className="text-sm text-soft-gray mt-1">Top 300 wallets by LINGO staked</p>
        </div>
        <GlowButton
          onClick={handleExport}
          disabled={!data || data.length === 0}
        >
          <Download className="w-4 h-4" />
          <span className="text-sm">Export</span>
        </GlowButton>
      </div>

      {/* Search bar */}
      <div className="px-6 py-4 border-b border-white/5 relative z-10">
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

        {/* Search result summary */}
        {isSearchActive && (
          <div className="mt-2">
            {searchResult ? (
              <p className="text-xs text-green1">
                Found at rank <span className="font-semibold">#{searchResult.rank}</span> — {formatNumber(searchResult.lingo_staked ?? 0)} LINGO ({formatCurrency(searchResult.usd_value ?? 0)})
                {searchResult.local_curation ? <span className="text-purple-gray"> · {searchResult.local_curation}</span> : null}
              </p>
            ) : (
              <p className="text-xs text-red-400">Wallet not found in top 300</p>
            )}
          </div>
        )}
      </div>

      {/* Table Container with Scroll */}
      <div className="max-h-[600px] overflow-y-auto relative z-10">
        <table className="w-full">
          <thead className="sticky top-0 z-10" style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6">
                Rank
              </th>
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                Wallet
              </th>
              {hasLocalCuration && (
                <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                  Local Curation
                </th>
              )}
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                LINGO Staked
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                USD Value
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6">
                % of Total
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(10)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-4 px-6">
                    <div className="skeleton w-9 h-9 rounded-xl" />
                  </td>
                  <td className="py-4 px-4">
                    <div className="skeleton h-5 w-28 rounded" />
                  </td>
                  {hasLocalCuration && (
                    <td className="py-4 px-4">
                      <div className="skeleton h-5 w-20 rounded" />
                    </td>
                  )}
                  <td className="py-4 px-4">
                    <div className="skeleton h-5 w-24 rounded ml-auto" />
                  </td>
                  <td className="py-4 px-4">
                    <div className="skeleton h-5 w-20 rounded ml-auto" />
                  </td>
                  <td className="py-4 px-6">
                    <div className="skeleton h-5 w-16 rounded ml-auto" />
                  </td>
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
                    {getRankDisplay(staker.rank)}
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
                  {hasLocalCuration && (
                    <td className="py-4 px-4">
                      {staker.local_curation ? (
                        <span className="text-xs px-2 py-1 rounded-lg bg-purple/10 text-purple border border-purple/20">
                          {staker.local_curation}
                        </span>
                      ) : (
                        <span className="text-xs text-soft-gray/40">—</span>
                      )}
                    </td>
                  )}
                  <td className="py-4 px-4 text-right">
                    <span className="font-semibold text-lavender">
                      {formatNumber(staker.lingo_staked ?? 0)}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right text-soft-gray">
                    {formatCurrency(staker.usd_value ?? 0)}
                  </td>
                  <td className="py-4 px-6 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-dark3 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-purple to-sosiska rounded-full"
                          style={{ width: `${Math.min((staker.pct_of_total ?? 0) * 10, 100)}%` }}
                        />
                      </div>
                      <span className="text-sm text-soft-gray w-12 text-right">
                        {(staker.pct_of_total ?? 0).toFixed(2)}%
                      </span>
                    </div>
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
            Showing {isSearchActive ? `${displayData.length} result${displayData.length !== 1 ? 's' : ''} of` : ''} {data.length} wallets &bull; Data from Dune Analytics
          </p>
        </div>
      )}
    </div>
  );
}
