import { Download, ExternalLink, Trophy, Medal, Award } from 'lucide-react';
import { formatNumber, formatCurrency, exportToCSV } from '../../utils/formatters';
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

function getRankDisplay(rank: number) {
  if (rank === 1) {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-yellow-400 to-amber-600 flex items-center justify-center shadow-lg shadow-yellow-500/20">
        <Trophy className="w-4 h-4 text-white" />
      </div>
    );
  }
  if (rank === 2) {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-slate-300 to-slate-500 flex items-center justify-center">
        <Medal className="w-4 h-4 text-white" />
      </div>
    );
  }
  if (rank === 3) {
    return (
      <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-600 to-amber-800 flex items-center justify-center">
        <Award className="w-4 h-4 text-white" />
      </div>
    );
  }
  return (
    <div className="w-9 h-9 rounded-xl bg-white/5 flex items-center justify-center border border-white/10">
      <span className="text-sm font-semibold text-white/50">#{rank}</span>
    </div>
  );
}

export function TopStakersTable({ data, isLoading }: TopStakersTableProps) {
  const handleExport = () => {
    const exportData = data.map(staker => ({
      Rank: staker.rank,
      Wallet: getCleanWalletAddress(staker.wallet),
      'LINGO Staked': staker.lingo_staked,
      'USD Value': staker.usd_value,
      '% of Total': staker.pct_of_total,
    }));
    exportToCSV(exportData, 'lingo_top_stakers');
  };

  return (
    <div className="glass rounded-2xl overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-white/5">
        <div>
          <h3 className="text-lg font-semibold text-white">Top Stakers Leaderboard</h3>
          <p className="text-sm text-white/40 mt-1">Top 50 wallets by LINGO staked</p>
        </div>
        <button
          onClick={handleExport}
          disabled={!data || data.length === 0}
          className="flex items-center gap-2 px-4 py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 text-white/60 hover:text-white transition-all duration-200 disabled:opacity-50"
        >
          <Download className="w-4 h-4" />
          <span className="text-sm">Export</span>
        </button>
      </div>

      {/* Table Container with Scroll */}
      <div className="max-h-[600px] overflow-y-auto">
        <table className="w-full">
          <thead className="sticky top-0 bg-[#12121a]/95 backdrop-blur-sm z-10">
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-white/40 uppercase tracking-wider py-4 px-6">
                Rank
              </th>
              <th className="text-left text-xs font-medium text-white/40 uppercase tracking-wider py-4 px-4">
                Wallet
              </th>
              <th className="text-right text-xs font-medium text-white/40 uppercase tracking-wider py-4 px-4">
                LINGO Staked
              </th>
              <th className="text-right text-xs font-medium text-white/40 uppercase tracking-wider py-4 px-4">
                USD Value
              </th>
              <th className="text-right text-xs font-medium text-white/40 uppercase tracking-wider py-4 px-6">
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
              data.map((staker) => (
                <tr
                  key={staker.wallet}
                  className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group"
                >
                  <td className="py-4 px-6">
                    {getRankDisplay(staker.rank)}
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 flex items-center justify-center border border-white/10">
                        <span className="text-xs font-medium text-cyan-400">
                          {truncateWallet(staker.wallet).slice(2, 4).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-white/80 group-hover:text-white transition-colors">
                          {truncateWallet(staker.wallet)}
                        </span>
                        <a
                          href={`https://etherscan.io/address/${getCleanWalletAddress(staker.wallet)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white/20 hover:text-cyan-400 transition-colors"
                        >
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-4 text-right">
                    <span className="font-semibold text-white">
                      {formatNumber(staker.lingo_staked)}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right text-white/60">
                    {formatCurrency(staker.usd_value)}
                  </td>
                  <td className="py-4 px-6 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 rounded-full"
                          style={{ width: `${Math.min(staker.pct_of_total * 10, 100)}%` }}
                        />
                      </div>
                      <span className="text-sm text-white/50 w-12 text-right">
                        {staker.pct_of_total.toFixed(2)}%
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
        <div className="px-6 py-4 border-t border-white/5 bg-white/[0.02]">
          <p className="text-xs text-white/30 text-center">
            Showing {data.length} wallets • Data from Dune Analytics
          </p>
        </div>
      )}
    </div>
  );
}
