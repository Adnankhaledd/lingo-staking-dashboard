import { useMemo } from 'react';
import { formatNumber } from '../../utils/formatters';
import type { ClaimsHoldBreakdownRow } from '../../hooks/useDuneQuery';

interface ClaimsHoldBreakdownTableProps {
  data: ClaimsHoldBreakdownRow[] | null;
  isLoading?: boolean;
  lastUpdated?: string | null;
}

interface Totals {
  num_wallets: number;
  total_claimed: number;
  still_held: number;
  net_sold_or_transferred: number;
  pct_still_held: number; // weighted avg = sum(still_held) / sum(total_claimed) * 100
}

function computeTotals(rows: ClaimsHoldBreakdownRow[]): Totals {
  let nw = 0, tc = 0, sh = 0, ns = 0;
  for (const r of rows) {
    nw += r.num_wallets ?? 0;
    tc += r.total_claimed ?? 0;
    sh += r.still_held ?? 0;
    ns += r.net_sold_or_transferred ?? 0;
  }
  return {
    num_wallets: nw,
    total_claimed: tc,
    still_held: sh,
    net_sold_or_transferred: ns,
    pct_still_held: tc > 0 ? (sh / tc) * 100 : 0,
  };
}

function fmtAge(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const hrs = (now.getTime() - d.getTime()) / 3600_000;
  if (hrs < 1) return 'Just now';
  if (hrs < 24) return `${Math.round(hrs)}h ago`;
  const days = hrs / 24;
  if (days < 7) return `${Math.round(days)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function ClaimsHoldBreakdownTable({ data, isLoading, lastUpdated }: ClaimsHoldBreakdownTableProps) {
  const rows = useMemo(() => {
    if (!data) return [];
    // Sort by total_claimed descending so the biggest movers are at the top.
    return [...data].sort((a, b) => (b.total_claimed ?? 0) - (a.total_claimed ?? 0));
  }, [data]);
  const totals = useMemo(() => computeTotals(rows), [rows]);

  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10 flex items-baseline justify-between flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Claims: Held vs Sold</h3>
          <p className="text-sm text-soft-gray mt-1">
            For each (source, claim type), how much of what was claimed is still held vs sold/transferred &middot;
            <span className="text-green1 mx-1">held</span>
            +
            <span className="text-red-400 mx-1">sold/transferred</span>
            = total claimed
          </p>
        </div>
        {lastUpdated && (
          <p className="text-[11px] text-purple-gray">Dune updated {fmtAge(lastUpdated)}</p>
        )}
      </div>

      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">Source</th>
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Type</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Wallets</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Total Claimed</th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                <span className="text-green1">Still Held</span>
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                <span className="text-red-400">Sold / Transferred</span>
              </th>
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">% Still Held</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(6)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  {[...Array(7)].map((__, j) => (
                    <td key={j} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                  ))}
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-12 text-center text-soft-gray text-sm">
                  No data available
                </td>
              </tr>
            ) : (
              rows.map((row, i) => (
                <tr key={`${row.source}-${row.claim_type}-${i}`} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td className="py-3 px-6 text-sm text-lavender whitespace-nowrap">{row.source}</td>
                  <td className="py-3 px-4 text-sm text-lavender whitespace-nowrap">{row.claim_type}</td>
                  <td className="py-3 px-4 text-right text-sm text-soft-gray">
                    {(row.num_wallets ?? 0).toLocaleString()}
                  </td>
                  <td className="py-3 px-4 text-right text-sm font-semibold text-lavender">
                    {formatNumber(Math.round(row.total_claimed ?? 0))}
                  </td>
                  <td className="py-3 px-4 text-right text-sm font-semibold text-green1">
                    {formatNumber(Math.round(row.still_held ?? 0))}
                  </td>
                  <td className="py-3 px-4 text-right text-sm font-semibold text-red-400">
                    {formatNumber(Math.round(row.net_sold_or_transferred ?? 0))}
                  </td>
                  <td className="py-3 px-6 text-right text-sm text-soft-gray">
                    {(row.pct_still_held ?? 0).toFixed(1)}%
                  </td>
                </tr>
              ))
            )}
          </tbody>

          {/* Totals row — sums for absolute columns, weighted avg for % */}
          {!isLoading && rows.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-white/10 bg-white/[0.03]">
                <td className="py-3 px-6 text-xs font-bold uppercase tracking-wider text-soft-gray">Total</td>
                <td className="py-3 px-4 text-xs text-purple-gray italic">(across all types)</td>
                <td className="py-3 px-4 text-right text-sm font-bold text-lavender">
                  {totals.num_wallets.toLocaleString()}
                </td>
                <td className="py-3 px-4 text-right text-sm font-bold text-lavender">
                  {formatNumber(Math.round(totals.total_claimed))}
                </td>
                <td className="py-3 px-4 text-right text-sm font-bold text-green1">
                  {formatNumber(Math.round(totals.still_held))}
                </td>
                <td className="py-3 px-4 text-right text-sm font-bold text-red-400">
                  {formatNumber(Math.round(totals.net_sold_or_transferred))}
                </td>
                <td
                  className="py-3 px-6 text-right text-sm font-bold text-soft-gray"
                  title="Weighted average: total still held ÷ total claimed"
                >
                  {totals.pct_still_held.toFixed(1)}%
                  <span className="text-[10px] text-purple-gray ml-1 font-normal">(wtd)</span>
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
