import { useState, useMemo } from 'react';
import { ExternalLink, ChevronLeft, ChevronRight, Filter, X } from 'lucide-react';
import { formatNumber, formatCurrency } from '../../utils/formatters';
import type { DecubateClaimFeedRow } from '../../hooks/useDuneQuery';

interface DecubateClaimFeedTableProps {
  data: DecubateClaimFeedRow[];
  isLoading?: boolean;
}

type SortField = 'claim_time' | 'lingo_claimed' | 'usd_value';
type SortDir = 'asc' | 'desc';

const PAGE_SIZE = 20;

function truncateWallet(wallet: string): string {
  if (!wallet) return '\u2014';
  const clean = wallet.replace(/^0x0+/, '0x');
  if (clean.length <= 13) return clean;
  return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
}

function getCleanHex(hex: string): string {
  return hex.replace(/^0x0+/, '0x');
}

function formatClaimTime(raw: string): string {
  if (!raw) return '\u2014';
  const d = new Date(raw);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' });
}

function formatClaimTimeFull(raw: string): string {
  if (!raw) return '';
  const d = new Date(raw);
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function DecubateClaimFeedTable({ data, isLoading }: DecubateClaimFeedTableProps) {
  const [sortField, setSortField] = useState<SortField>('claim_time');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  // Filters
  const [minUsd, setMinUsd] = useState('');
  const [maxUsd, setMaxUsd] = useState('');
  const [minLingo, setMinLingo] = useState('');
  const [vestingFilter, setVestingFilter] = useState('');

  // Extract unique vesting types for dropdown
  const vestingTypes = useMemo(() => {
    if (!data) return [];
    const types = new Set(data.map(r => r.vesting_type).filter(Boolean));
    return Array.from(types).sort();
  }, [data]);

  const hasActiveFilters = minUsd !== '' || maxUsd !== '' || minLingo !== '' || vestingFilter !== '';

  const filtered = useMemo(() => {
    if (!data || data.length === 0) return [];
    let result = data;

    const minUsdNum = minUsd !== '' ? parseFloat(minUsd) : null;
    const maxUsdNum = maxUsd !== '' ? parseFloat(maxUsd) : null;
    const minLingoNum = minLingo !== '' ? parseFloat(minLingo) : null;

    if (minUsdNum !== null) result = result.filter(r => r.usd_value >= minUsdNum);
    if (maxUsdNum !== null) result = result.filter(r => r.usd_value <= maxUsdNum);
    if (minLingoNum !== null) result = result.filter(r => r.lingo_claimed >= minLingoNum);
    if (vestingFilter) result = result.filter(r => r.vesting_type === vestingFilter);

    return result;
  }, [data, minUsd, maxUsd, minLingo, vestingFilter]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      if (sortField === 'claim_time') {
        const da = new Date(a.claim_time).getTime();
        const db = new Date(b.claim_time).getTime();
        return sortDir === 'desc' ? db - da : da - db;
      }
      const va = a[sortField];
      const vb = b[sortField];
      return sortDir === 'desc' ? vb - va : va - vb;
    });
  }, [filtered, sortField, sortDir]);

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

  const clearFilters = () => {
    setMinUsd('');
    setMaxUsd('');
    setMinLingo('');
    setVestingFilter('');
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
          <h3 className="text-lg font-semibold text-lavender">Decubate Claim Feed</h3>
          <p className="text-sm text-soft-gray mt-1">
            Recent individual claim transactions
            {filtered.length < (data?.length ?? 0) && (
              <span className="text-purple ml-2">
                ({filtered.length} of {data?.length ?? 0} shown)
              </span>
            )}
          </p>
        </div>
        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-purple/20 text-purple border border-purple/30 hover:bg-purple/30 transition-all"
          >
            <X className="w-3 h-3" />
            Clear Filters
          </button>
        )}
      </div>

      {/* Filter Row */}
      <div className="flex flex-wrap items-center gap-3 px-6 py-4 border-b border-white/5 relative z-10 bg-white/[0.01]">
        <div className="flex items-center gap-1.5 text-xs text-purple-gray">
          <Filter className="w-3.5 h-3.5" />
          <span>Filters:</span>
        </div>

        {/* Min USD */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">USD &ge;</label>
          <input
            type="number"
            value={minUsd}
            onChange={e => { setMinUsd(e.target.value); setPage(0); }}
            placeholder="0"
            className="w-20 px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender placeholder:text-purple-gray/50 focus:outline-none focus:border-purple/40"
          />
        </div>

        {/* Max USD */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">USD &le;</label>
          <input
            type="number"
            value={maxUsd}
            onChange={e => { setMaxUsd(e.target.value); setPage(0); }}
            placeholder="any"
            className="w-20 px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender placeholder:text-purple-gray/50 focus:outline-none focus:border-purple/40"
          />
        </div>

        {/* Min LINGO */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">LINGO &ge;</label>
          <input
            type="number"
            value={minLingo}
            onChange={e => { setMinLingo(e.target.value); setPage(0); }}
            placeholder="0"
            className="w-20 px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender placeholder:text-purple-gray/50 focus:outline-none focus:border-purple/40"
          />
        </div>

        {/* Vesting Type */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">Type:</label>
          <select
            value={vestingFilter}
            onChange={e => { setVestingFilter(e.target.value); setPage(0); }}
            className="px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender focus:outline-none focus:border-purple/40 appearance-none cursor-pointer pr-6"
            style={{ backgroundImage: 'url("data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'10\' height=\'6\' viewBox=\'0 0 10 6\'%3E%3Cpath d=\'M1 1l4 4 4-4\' stroke=\'%239090A7\' fill=\'none\' stroke-width=\'1.5\'/%3E%3C/svg%3E")', backgroundRepeat: 'no-repeat', backgroundPosition: 'right 6px center' }}
          >
            <option value="">All</option>
            {vestingTypes.map(t => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Table */}
      <div className="relative z-10">
        <table className="w-full">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Wallet
              </th>
              <th
                className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 cursor-pointer select-none hover:text-lavender transition-colors"
                onClick={() => toggleSort('lingo_claimed')}
              >
                LINGO{sortIndicator('lingo_claimed')}
              </th>
              <th
                className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 cursor-pointer select-none hover:text-lavender transition-colors"
                onClick={() => toggleSort('usd_value')}
              >
                USD{sortIndicator('usd_value')}
              </th>
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Type
              </th>
              <th
                className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 cursor-pointer select-none hover:text-lavender transition-colors"
                onClick={() => toggleSort('claim_time')}
              >
                Time{sortIndicator('claim_time')}
              </th>
              <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                TX
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(10)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-28 rounded" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-24 rounded" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-6 rounded mx-auto" /></td>
                </tr>
              ))
            ) : pageData.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-soft-gray text-sm">
                  {hasActiveFilters ? 'No claims match the current filters' : 'No data available'}
                </td>
              </tr>
            ) : (
              pageData.map((row, i) => (
                <tr
                  key={`${row.tx_hash}-${i}`}
                  className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group"
                >
                  <td className="py-3 px-6">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple/20 to-sosiska/20 flex items-center justify-center border border-white/8">
                        <span className="text-[10px] font-medium text-purple">
                          {truncateWallet(row.wallet).slice(2, 4).toUpperCase()}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm text-lavender/80 group-hover:text-lavender transition-colors">
                          {truncateWallet(row.wallet)}
                        </span>
                        <a
                          href={`https://basescan.org/address/${getCleanHex(row.wallet)}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-white/20 hover:text-purple transition-colors"
                        >
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      </div>
                    </div>
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="font-semibold text-lavender text-sm">
                      {formatNumber(Math.round(row.lingo_claimed))}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {formatCurrency(row.usd_value)}
                  </td>
                  <td className="py-3 px-4">
                    <span className="text-xs px-2 py-0.5 rounded-md bg-white/[0.04] border border-white/[0.06] text-purple-gray">
                      {row.vesting_type}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray" title={formatClaimTimeFull(row.claim_time)}>
                    {formatClaimTime(row.claim_time)}
                  </td>
                  <td className="py-3 px-4 text-center">
                    <a
                      href={`https://basescan.org/tx/${getCleanHex(row.tx_hash)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-white/20 hover:text-purple transition-colors"
                    >
                      <ExternalLink className="w-3.5 h-3.5 inline" />
                    </a>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
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
