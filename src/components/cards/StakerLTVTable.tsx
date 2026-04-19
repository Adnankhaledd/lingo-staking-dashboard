import { useState, useMemo } from 'react';
import { ExternalLink, ChevronLeft, ChevronRight, Filter, X, TrendingUp } from 'lucide-react';
import { formatNumber, formatCurrency } from '../../utils/formatters';
import type { StakerLTVRow } from '../../hooks/useDuneQuery';

interface StakerLTVTableProps {
  data: StakerLTVRow[];
  isLoading?: boolean;
}

type SortField =
  | 'first_stake_date'
  | 'last_stake_date'
  | 'first_stake'
  | 'first_stake_usd'
  | 'total_staked'
  | 'total_staked_usd'
  | 'num_stakes'
  | 'days_active'
  | 'growth_multiplier';

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

// Extract YYYY-MM-DD from Dune's "YYYY-MM-DD HH:MM:SS UTC" or ISO
function parseDateISO(raw: string): string {
  if (!raw) return '';
  return raw.split(/[T\s]/)[0];
}

function formatDateDisplay(raw: string): string {
  const iso = parseDateISO(raw);
  if (!iso) return '\u2014';
  const [y, m, d] = iso.split('-').map(Number);
  const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTH_NAMES[m - 1]} ${d}, ${String(y).slice(2)}`;
}

function dateToMillis(raw: string): number {
  const iso = parseDateISO(raw);
  if (!iso) return 0;
  return new Date(iso + 'T00:00:00Z').getTime();
}

export function StakerLTVTable({ data, isLoading }: StakerLTVTableProps) {
  const [sortField, setSortField] = useState<SortField>('total_staked');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [page, setPage] = useState(0);

  // Filters
  const [firstFrom, setFirstFrom] = useState('');     // YYYY-MM-DD
  const [firstTo, setFirstTo] = useState('');
  const [lastFrom, setLastFrom] = useState('');
  const [lastTo, setLastTo] = useState('');
  const [minFirstUsd, setMinFirstUsd] = useState('');
  const [minTotalUsd, setMinTotalUsd] = useState('');
  const [minStakes, setMinStakes] = useState('');

  const hasActiveFilters =
    firstFrom || firstTo || lastFrom || lastTo || minFirstUsd || minTotalUsd || minStakes;

  const filtered = useMemo(() => {
    if (!data || data.length === 0) return [];
    const firstFromMs = firstFrom ? new Date(firstFrom + 'T00:00:00Z').getTime() : null;
    const firstToMs = firstTo ? new Date(firstTo + 'T23:59:59Z').getTime() : null;
    const lastFromMs = lastFrom ? new Date(lastFrom + 'T00:00:00Z').getTime() : null;
    const lastToMs = lastTo ? new Date(lastTo + 'T23:59:59Z').getTime() : null;
    const minFirstUsdNum = minFirstUsd !== '' ? parseFloat(minFirstUsd) : null;
    const minTotalUsdNum = minTotalUsd !== '' ? parseFloat(minTotalUsd) : null;
    const minStakesNum = minStakes !== '' ? parseFloat(minStakes) : null;

    return data.filter(r => {
      const fs = dateToMillis(r.first_stake_date);
      const ls = dateToMillis(r.last_stake_date);
      if (firstFromMs != null && fs < firstFromMs) return false;
      if (firstToMs != null && fs > firstToMs) return false;
      if (lastFromMs != null && ls < lastFromMs) return false;
      if (lastToMs != null && ls > lastToMs) return false;
      if (minFirstUsdNum != null && (r.first_stake_usd ?? 0) < minFirstUsdNum) return false;
      if (minTotalUsdNum != null && (r.total_staked_usd ?? 0) < minTotalUsdNum) return false;
      if (minStakesNum != null && (r.num_stakes ?? 0) < minStakesNum) return false;
      return true;
    });
  }, [data, firstFrom, firstTo, lastFrom, lastTo, minFirstUsd, minTotalUsd, minStakes]);

  const sorted = useMemo(() => {
    return [...filtered].sort((a, b) => {
      let va: number;
      let vb: number;
      if (sortField === 'first_stake_date' || sortField === 'last_stake_date') {
        va = dateToMillis(a[sortField]);
        vb = dateToMillis(b[sortField]);
      } else {
        va = a[sortField] ?? 0;
        vb = b[sortField] ?? 0;
      }
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
    setFirstFrom(''); setFirstTo('');
    setLastFrom(''); setLastTo('');
    setMinFirstUsd(''); setMinTotalUsd(''); setMinStakes('');
    setPage(0);
  };

  const sortIndicator = (field: SortField) => {
    if (sortField !== field) return <span className="text-white/10 ml-1 text-[9px]">{'\u2195'}</span>;
    return <span className="ml-1 text-[10px] text-purple">{sortDir === 'desc' ? '\u25BC' : '\u25B2'}</span>;
  };

  const headerCell = (field: SortField, label: string, align: 'left' | 'right' = 'right') => (
    <th
      onClick={() => toggleSort(field)}
      className={`${align === 'right' ? 'text-right' : 'text-left'} text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 cursor-pointer select-none hover:text-lavender transition-colors`}
    >
      {label}{sortIndicator(field)}
    </th>
  );

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-white/5 relative z-10 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Staker LTV</h3>
          <p className="text-sm text-soft-gray mt-1">
            Per-wallet lifetime staking activity &bull; click any column header to sort
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

      {/* Filter row */}
      <div className="flex flex-wrap items-center gap-3 px-6 py-4 border-b border-white/5 relative z-10 bg-white/[0.01]">
        <div className="flex items-center gap-1.5 text-xs text-purple-gray">
          <Filter className="w-3.5 h-3.5" />
          <span>Filters:</span>
        </div>

        {/* First stake date range */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">First stake</label>
          <input
            type="date"
            value={firstFrom}
            onChange={e => { setFirstFrom(e.target.value); setPage(0); }}
            className="px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender focus:outline-none focus:border-purple/40"
          />
          <span className="text-xs text-purple-gray">to</span>
          <input
            type="date"
            value={firstTo}
            onChange={e => { setFirstTo(e.target.value); setPage(0); }}
            className="px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender focus:outline-none focus:border-purple/40"
          />
        </div>

        {/* Last stake date range */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">Last stake</label>
          <input
            type="date"
            value={lastFrom}
            onChange={e => { setLastFrom(e.target.value); setPage(0); }}
            className="px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender focus:outline-none focus:border-purple/40"
          />
          <span className="text-xs text-purple-gray">to</span>
          <input
            type="date"
            value={lastTo}
            onChange={e => { setLastTo(e.target.value); setPage(0); }}
            className="px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender focus:outline-none focus:border-purple/40"
          />
        </div>

        {/* Amount + count filters */}
        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">First $ &ge;</label>
          <input
            type="number"
            value={minFirstUsd}
            onChange={e => { setMinFirstUsd(e.target.value); setPage(0); }}
            placeholder="0"
            className="w-20 px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender placeholder:text-purple-gray/50 focus:outline-none focus:border-purple/40"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray">Total $ &ge;</label>
          <input
            type="number"
            value={minTotalUsd}
            onChange={e => { setMinTotalUsd(e.target.value); setPage(0); }}
            placeholder="0"
            className="w-24 px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender placeholder:text-purple-gray/50 focus:outline-none focus:border-purple/40"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <label className="text-xs text-soft-gray"># Stakes &ge;</label>
          <input
            type="number"
            value={minStakes}
            onChange={e => { setMinStakes(e.target.value); setPage(0); }}
            placeholder="0"
            className="w-16 px-2 py-1 rounded-lg text-xs bg-white/[0.04] border border-white/[0.08] text-lavender placeholder:text-purple-gray/50 focus:outline-none focus:border-purple/40"
          />
        </div>

        {hasActiveFilters && (
          <span className="text-xs text-purple ml-auto">
            {filtered.length} of {data?.length ?? 0} shown
          </span>
        )}
      </div>

      {/* Table */}
      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[960px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Wallet
              </th>
              {headerCell('first_stake_date', 'First Stake', 'left')}
              {headerCell('last_stake_date', 'Last Stake', 'left')}
              {headerCell('first_stake_usd', 'First Stake ($)', 'right')}
              {headerCell('total_staked', 'Total LINGO', 'right')}
              {headerCell('total_staked_usd', 'Total ($)', 'right')}
              {headerCell('num_stakes', '# Stakes', 'right')}
              {headerCell('days_active', 'Days', 'right')}
              {headerCell('growth_multiplier', 'Growth', 'right')}
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(10)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  {[...Array(9)].map((__, j) => (
                    <td key={j} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded" /></td>
                  ))}
                </tr>
              ))
            ) : pageData.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-12 text-center text-soft-gray text-sm">
                  {hasActiveFilters ? 'No wallets match the current filters' : 'No data available'}
                </td>
              </tr>
            ) : (
              pageData.map(row => (
                <tr
                  key={row.wallet}
                  className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group"
                >
                  <td className="py-3 px-6">
                    <div className="flex items-center gap-2">
                      <div className="w-7 h-7 rounded-full bg-gradient-to-br from-purple/20 to-sosiska/20 flex items-center justify-center border border-white/8">
                        <span className="text-[10px] font-medium text-purple">
                          {truncateWallet(row.wallet).slice(2, 4).toUpperCase()}
                        </span>
                      </div>
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
                  </td>
                  <td className="py-3 px-4 text-sm text-soft-gray whitespace-nowrap">
                    {formatDateDisplay(row.first_stake_date)}
                  </td>
                  <td className="py-3 px-4 text-sm text-soft-gray whitespace-nowrap">
                    {formatDateDisplay(row.last_stake_date)}
                  </td>
                  <td className="py-3 px-4 text-right text-sm">
                    <div className="text-lavender">{formatCurrency(row.first_stake_usd)}</div>
                    <div className="text-[10px] text-purple-gray">{formatNumber(Math.round(row.first_stake))} LINGO</div>
                  </td>
                  <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                    {formatNumber(Math.round(row.total_staked))}
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-lavender">
                    {formatCurrency(row.total_staked_usd)}
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {formatNumber(row.num_stakes)}
                  </td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {formatNumber(row.days_active)}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-md bg-green1/10 border border-green1/20 text-green1">
                      <TrendingUp className="w-3 h-3" />
                      {row.growth_multiplier >= 100
                        ? `${formatNumber(Math.round(row.growth_multiplier))}\u00D7`
                        : `${row.growth_multiplier.toFixed(2)}\u00D7`}
                    </span>
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
            <span className="text-xs text-purple-gray px-2">{page + 1} / {totalPages}</span>
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
