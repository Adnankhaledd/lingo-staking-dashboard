import { useState, useMemo } from 'react';
import { ExternalLink, ChevronLeft, ChevronRight, ArrowUpDown } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import type { DecubateAPYClaimerRow } from '../../hooks/useDuneQuery';

interface DecubateAPYClaimersTableProps {
  data: DecubateAPYClaimerRow[];
  isLoading?: boolean;
}

type SortField = 'total_claimed_lingo' | 'last_claim';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 15;

function truncateWallet(wallet: string): string {
  if (!wallet) return '\u2014';
  const clean = wallet.replace(/^0x0+/, '0x');
  if (clean.length <= 13) return clean;
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

function getCleanWallet(wallet: string): string {
  return wallet.replace(/^0x0+/, '0x');
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '\u2014';
  const d = new Date(dateStr);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

export function DecubateAPYClaimersTable({ data, isLoading }: DecubateAPYClaimersTableProps) {
  const [sortField, setSortField] = useState<SortField>('total_claimed_lingo');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  const sorted = useMemo(() => {
    if (!data || data.length === 0) return [];
    return [...data].sort((a, b) => {
      if (sortField === 'total_claimed_lingo') {
        return sortDir === 'desc'
          ? b.total_claimed_lingo - a.total_claimed_lingo
          : a.total_claimed_lingo - b.total_claimed_lingo;
      }
      // last_claim — compare as dates
      const da = new Date(a.last_claim).getTime();
      const db = new Date(b.last_claim).getTime();
      return sortDir === 'desc' ? db - da : da - db;
    });
  }, [data, sortField, sortDir]);

  const totalPages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageData = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir(d => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
    setPage(0);
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return null;
    return <span className="ml-1 text-[10px]">{sortDir === 'desc' ? '\u25BC' : '\u25B2'}</span>;
  };

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-white/5 relative z-10">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Decubate APY Claimers</h3>
          <p className="text-sm text-soft-gray mt-1">Top wallets by LINGO claimed from Decubate APY</p>
        </div>
        {/* Sort buttons */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-purple-gray mr-1">Sort:</span>
          <button
            onClick={() => toggleSort('total_claimed_lingo')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              sortField === 'total_claimed_lingo'
                ? 'bg-purple/30 text-white border border-white/20'
                : 'bg-white/[0.04] text-soft-gray border border-white/[0.06] hover:text-white hover:bg-white/[0.08]'
            }`}
          >
            <ArrowUpDown className="w-3 h-3" />
            Amount
            {sortIndicator('total_claimed_lingo')}
          </button>
          <button
            onClick={() => toggleSort('last_claim')}
            className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
              sortField === 'last_claim'
                ? 'bg-purple/30 text-white border border-white/20'
                : 'bg-white/[0.04] text-soft-gray border border-white/[0.06] hover:text-white hover:bg-white/[0.08]'
            }`}
          >
            <ArrowUpDown className="w-3 h-3" />
            Date
            {sortIndicator('last_claim')}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="relative z-10">
        <table className="w-full">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6">
                Wallet
              </th>
              <th
                className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-4 cursor-pointer select-none hover:text-lavender transition-colors"
                onClick={() => toggleSort('total_claimed_lingo')}
              >
                LINGO Claimed{sortIndicator('total_claimed_lingo')}
              </th>
              <th
                className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-4 px-6 cursor-pointer select-none hover:text-lavender transition-colors"
                onClick={() => toggleSort('last_claim')}
              >
                Last Claim{sortIndicator('last_claim')}
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(10)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-4 px-6"><div className="skeleton h-5 w-32 rounded" /></td>
                  <td className="py-4 px-4"><div className="skeleton h-5 w-24 rounded ml-auto" /></td>
                  <td className="py-4 px-6"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                </tr>
              ))
            ) : (
              pageData.map(row => (
                <tr
                  key={row.wallet}
                  className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group"
                >
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-purple/20 to-sosiska/20 flex items-center justify-center border border-white/8">
                        <span className="text-xs font-medium text-purple">
                          {truncateWallet(row.wallet).slice(2, 4).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-lavender/80 group-hover:text-lavender transition-colors">
                          {truncateWallet(row.wallet)}
                        </span>
                        <a
                          href={`https://basescan.org/address/${getCleanWallet(row.wallet)}`}
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
                      {formatNumber(Math.round(row.total_claimed_lingo))}
                    </span>
                  </td>
                  <td className="py-4 px-6 text-right text-soft-gray text-sm">
                    {formatDate(row.last_claim)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination Footer */}
      {sorted.length > 0 && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/5 bg-white/[0.02] relative z-10">
          <p className="text-xs text-purple-gray">
            Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, sorted.length)} of {sorted.length}
          </p>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] border border-white/[0.06] text-soft-gray hover:text-white hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:pointer-events-none"
            >
              <ChevronLeft className="w-3.5 h-3.5" />
              Prev
            </button>
            <span className="text-xs text-purple-gray px-2">
              {page + 1} / {totalPages}
            </span>
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] border border-white/[0.06] text-soft-gray hover:text-white hover:bg-white/[0.08] transition-all disabled:opacity-30 disabled:pointer-events-none"
            >
              Next
              <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
