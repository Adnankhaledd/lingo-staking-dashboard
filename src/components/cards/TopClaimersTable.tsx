import { Download, ExternalLink, Trophy, Medal, Award } from 'lucide-react';
import { formatNumber, formatCurrency, exportToCSV } from '../../utils/formatters';
import { GlowButton } from '../ui/GlowButton';
import type { TopClaimerRow } from '../../hooks/useDuneQuery';

interface TopClaimersTableProps {
  data: TopClaimerRow[];
  isLoading?: boolean;
}

function truncateWallet(wallet: string): string {
  if (!wallet) return '\u2014';
  const cleanWallet = wallet.replace(/^0x0+/, '0x');
  if (cleanWallet.length <= 13) return cleanWallet;
  return `${cleanWallet.slice(0, 6)}...${cleanWallet.slice(-4)}`;
}

function getCleanWalletAddress(wallet: string): string {
  return wallet.replace(/^0x0+/, '0x');
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

function formatDate(dateStr: string): string {
  if (!dateStr) return '\u2014';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export function TopClaimersTable({ data, isLoading }: TopClaimersTableProps) {
  const handleExport = () => {
    const exportData = data.map((claimer, i) => ({
      Rank: i + 1,
      Wallet: getCleanWalletAddress(claimer.wallet),
      'Num Claims': claimer.num_claims,
      'Total LINGO Claimed': claimer.total_lingo_claimed,
      'USD Value': claimer.usd_value,
      'First Claim': claimer.first_claim,
      'Last Claim': claimer.last_claim,
    }));
    exportToCSV(exportData, 'lingo_top_claimers');
  };

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-white/5 relative z-10">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Top Claimers</h3>
          <p className="text-sm text-soft-gray mt-1">Top 100 wallets by LINGO claimed</p>
        </div>
        <GlowButton
          onClick={handleExport}
          disabled={!data || data.length === 0}
        >
          <Download className="w-4 h-4" />
          <span className="text-sm">Export</span>
        </GlowButton>
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
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                Claims
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                LINGO Claimed
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4">
                USD Value
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6">
                Last Claim
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
                    <div className="skeleton h-5 w-16 rounded ml-auto" />
                  </td>
                  <td className="py-4 px-4">
                    <div className="skeleton h-5 w-24 rounded ml-auto" />
                  </td>
                  <td className="py-4 px-4">
                    <div className="skeleton h-5 w-20 rounded ml-auto" />
                  </td>
                  <td className="py-4 px-6">
                    <div className="skeleton h-5 w-20 rounded ml-auto" />
                  </td>
                </tr>
              ))
            ) : (
              data.map((claimer, index) => (
                <tr
                  key={claimer.wallet}
                  className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group"
                >
                  <td className="py-4 px-6">
                    {getRankDisplay(index + 1)}
                  </td>
                  <td className="py-4 px-4">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple/20 to-sosiska/20 flex items-center justify-center border border-white/8">
                        <span className="text-xs font-medium text-purple">
                          {truncateWallet(claimer.wallet).slice(2, 4).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-lavender/80 group-hover:text-lavender transition-colors">
                          {truncateWallet(claimer.wallet)}
                        </span>
                        <a
                          href={`https://basescan.org/address/${getCleanWalletAddress(claimer.wallet)}`}
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
                    <span className="text-soft-gray">
                      {formatNumber(claimer.num_claims)}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right">
                    <span className="font-semibold text-lavender">
                      {formatNumber(claimer.total_lingo_claimed)}
                    </span>
                  </td>
                  <td className="py-4 px-4 text-right text-soft-gray">
                    {formatCurrency(claimer.usd_value)}
                  </td>
                  <td className="py-4 px-6 text-right text-soft-gray text-sm">
                    {formatDate(claimer.last_claim)}
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
            Showing {data.length} wallets &bull; Data from Dune Analytics
          </p>
        </div>
      )}
    </div>
  );
}
