import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import type { StakeDailyBreakdownRow } from '../../hooks/useDuneQuery';

interface StakeBreakdownTableProps {
  data: StakeDailyBreakdownRow[];
  isLoading?: boolean;
}

type Period = 'day' | 'week' | 'month';

const PAGE_SIZE = 15;

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Parse YYYY-MM-DD or "YYYY-MM-DD HH:MM:SS UTC" safely
function parseDay(raw: string): string {
  if (!raw) return '';
  return raw.split(/[T\s]/)[0];
}

// Monday as start of week (ISO-like)
function startOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay(); // 0 = Sunday
  const diff = (day === 0 ? -6 : 1 - day);
  date.setUTCDate(date.getUTCDate() + diff);
  return date.toISOString().slice(0, 10);
}

function formatDayLabel(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${d}, ${String(y).slice(2)}`;
}

function formatWeekLabel(weekStart: string): string {
  const [y, m, d] = weekStart.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, d));
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 6);
  const sm = MONTH_NAMES[start.getUTCMonth()];
  const em = MONTH_NAMES[end.getUTCMonth()];
  if (sm === em) {
    return `${sm} ${start.getUTCDate()}\u2013${end.getUTCDate()}`;
  }
  return `${sm} ${start.getUTCDate()} \u2013 ${em} ${end.getUTCDate()}`;
}

function formatMonthLabel(key: string): string {
  const [y, m] = key.split('-').map(Number);
  return `${MONTH_NAMES[m - 1]} ${y}`;
}

interface AggregatedRow {
  key: string;
  label: string;
  daily_total: number;
  three_mo_total: number; three_mo_new: number; three_mo_old: number;
  three_mo_new_wallets: number; three_mo_old_wallets: number;
  six_mo_total: number; six_mo_new: number; six_mo_old: number;
  six_mo_new_wallets: number; six_mo_old_wallets: number;
  twelve_mo_total: number; twelve_mo_new: number; twelve_mo_old: number;
  twelve_mo_new_wallets: number; twelve_mo_old_wallets: number;
  total_new_wallets: number; total_old_wallets: number;
}

function emptyRow(key: string, label: string): AggregatedRow {
  return {
    key, label, daily_total: 0,
    three_mo_total: 0, three_mo_new: 0, three_mo_old: 0, three_mo_new_wallets: 0, three_mo_old_wallets: 0,
    six_mo_total: 0, six_mo_new: 0, six_mo_old: 0, six_mo_new_wallets: 0, six_mo_old_wallets: 0,
    twelve_mo_total: 0, twelve_mo_new: 0, twelve_mo_old: 0, twelve_mo_new_wallets: 0, twelve_mo_old_wallets: 0,
    total_new_wallets: 0, total_old_wallets: 0,
  };
}

function addInto(target: AggregatedRow, row: StakeDailyBreakdownRow) {
  target.daily_total += row.daily_total ?? 0;
  target.three_mo_total += row.three_mo_total ?? 0;
  target.three_mo_new += row.three_mo_new ?? 0;
  target.three_mo_old += row.three_mo_old ?? 0;
  target.three_mo_new_wallets += row.three_mo_new_wallets ?? 0;
  target.three_mo_old_wallets += row.three_mo_old_wallets ?? 0;
  target.six_mo_total += row.six_mo_total ?? 0;
  target.six_mo_new += row.six_mo_new ?? 0;
  target.six_mo_old += row.six_mo_old ?? 0;
  target.six_mo_new_wallets += row.six_mo_new_wallets ?? 0;
  target.six_mo_old_wallets += row.six_mo_old_wallets ?? 0;
  target.twelve_mo_total += row.twelve_mo_total ?? 0;
  target.twelve_mo_new += row.twelve_mo_new ?? 0;
  target.twelve_mo_old += row.twelve_mo_old ?? 0;
  target.twelve_mo_new_wallets += row.twelve_mo_new_wallets ?? 0;
  target.twelve_mo_old_wallets += row.twelve_mo_old_wallets ?? 0;
  target.total_new_wallets += row.total_new_wallets ?? 0;
  target.total_old_wallets += row.total_old_wallets ?? 0;
}

function aggregate(data: StakeDailyBreakdownRow[], period: Period): AggregatedRow[] {
  if (!data || data.length === 0) return [];

  const buckets = new Map<string, AggregatedRow>();
  for (const row of data) {
    const day = parseDay(row.day);
    if (!day) continue;

    let key: string;
    let label: string;
    if (period === 'day') {
      key = day;
      label = formatDayLabel(day);
    } else if (period === 'week') {
      key = startOfWeek(day);
      label = formatWeekLabel(key);
    } else {
      key = day.slice(0, 7); // YYYY-MM
      label = formatMonthLabel(key);
    }

    let b = buckets.get(key);
    if (!b) {
      b = emptyRow(key, label);
      buckets.set(key, b);
    }
    addInto(b, row);
  }

  // Sort descending (most recent first)
  return Array.from(buckets.values()).sort((a, b) => b.key.localeCompare(a.key));
}

// Cell helper: big total on top, "X new · Y old" smaller text below (amounts),
// then "(X new · Y old)" wallets tertiary line.
function LockCell({ total, newAmt, oldAmt, newWallets, oldWallets }: {
  total: number; newAmt: number; oldAmt: number; newWallets: number; oldWallets: number;
}) {
  return (
    <div className="text-right">
      <div className="font-semibold text-lavender text-sm">{formatNumber(Math.round(total))}</div>
      <div className="text-[10px] text-soft-gray mt-0.5">
        <span className="text-green1">{formatNumber(Math.round(newAmt))}</span>
        <span className="text-purple-gray mx-1">/</span>
        <span className="text-purple">{formatNumber(Math.round(oldAmt))}</span>
      </div>
      <div className="text-[10px] text-purple-gray mt-0.5">
        {newWallets}n {'\u00B7'} {oldWallets}o
      </div>
    </div>
  );
}

export function StakeBreakdownTable({ data, isLoading }: StakeBreakdownTableProps) {
  const [period, setPeriod] = useState<Period>('month');
  const [page, setPage] = useState(0);

  const rows = useMemo(() => aggregate(data, period), [data, period]);
  const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageData = rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const setPeriodSafe = (p: Period) => { setPeriod(p); setPage(0); };

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header */}
      <div className="flex items-center justify-between p-6 border-b border-white/5 relative z-10 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Stake Breakdown by Lock</h3>
          <p className="text-sm text-soft-gray mt-1">
            New vs returning wallets per lock duration &bull;{' '}
            <span className="text-green1">new</span>{' '}/{' '}
            <span className="text-purple">old</span>
          </p>
        </div>

        {/* Period toggle */}
        <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
          {(['day', 'week', 'month'] as Period[]).map(p => (
            <button
              key={p}
              onClick={() => setPeriodSafe(p)}
              className={`px-3 py-1.5 text-xs font-medium capitalize transition-all ${
                period === p
                  ? 'bg-purple/30 text-white'
                  : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
              }`}
            >
              {p === 'day' ? 'Daily' : p === 'week' ? 'Weekly' : 'Monthly'}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[720px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Period
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                Total LINGO
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                3 Month
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                6 Month
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                12 Month
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                Wallets
              </th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(8)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-6"><div className="skeleton h-5 w-24 rounded" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-10 w-24 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-10 w-24 rounded ml-auto" /></td>
                  <td className="py-3 px-4"><div className="skeleton h-10 w-24 rounded ml-auto" /></td>
                  <td className="py-3 px-6"><div className="skeleton h-5 w-16 rounded ml-auto" /></td>
                </tr>
              ))
            ) : pageData.length === 0 ? (
              <tr>
                <td colSpan={6} className="py-12 text-center text-soft-gray text-sm">
                  No data available
                </td>
              </tr>
            ) : (
              pageData.map(row => (
                <tr key={row.key} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td className="py-3 px-6 text-sm text-lavender font-medium whitespace-nowrap">
                    {row.label}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <span className="font-semibold text-lavender">{formatNumber(Math.round(row.daily_total))}</span>
                  </td>
                  <td className="py-3 px-4">
                    <LockCell
                      total={row.three_mo_total}
                      newAmt={row.three_mo_new}
                      oldAmt={row.three_mo_old}
                      newWallets={row.three_mo_new_wallets}
                      oldWallets={row.three_mo_old_wallets}
                    />
                  </td>
                  <td className="py-3 px-4">
                    <LockCell
                      total={row.six_mo_total}
                      newAmt={row.six_mo_new}
                      oldAmt={row.six_mo_old}
                      newWallets={row.six_mo_new_wallets}
                      oldWallets={row.six_mo_old_wallets}
                    />
                  </td>
                  <td className="py-3 px-4">
                    <LockCell
                      total={row.twelve_mo_total}
                      newAmt={row.twelve_mo_new}
                      oldAmt={row.twelve_mo_old}
                      newWallets={row.twelve_mo_new_wallets}
                      oldWallets={row.twelve_mo_old_wallets}
                    />
                  </td>
                  <td className="py-3 px-6 text-right text-sm">
                    <span className="text-green1">{row.total_new_wallets}</span>
                    <span className="text-purple-gray mx-1">/</span>
                    <span className="text-purple">{row.total_old_wallets}</span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {rows.length > PAGE_SIZE && (
        <div className="flex items-center justify-between px-6 py-4 border-t border-white/5 bg-white/[0.02] relative z-10">
          <p className="text-xs text-purple-gray">
            Showing {page * PAGE_SIZE + 1}&ndash;{Math.min((page + 1) * PAGE_SIZE, rows.length)} of {rows.length}
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
