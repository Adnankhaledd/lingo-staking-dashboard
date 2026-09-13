import { formatNumber } from '../../utils/formatters';

// Monthly LINGO in / out / net for one wallet, with an in − out vs live-balance
// reconciliation footer. Shared by the PnL page and the Claims page.

export interface MonthlyLingoRow { month: string; lingoOut: number; lingoIn: number; net: number; count: number }

export interface Reconciliation { balanceNow: number; impliedBalance: number; unaccountedLingo: number }

export function MonthlyLingoSentTable({
  title, subtitle, countLabel, rows, isLoading, showFlow, reconciliation,
}: {
  title: string;
  subtitle: string;
  countLabel: string;
  rows: MonthlyLingoRow[];
  isLoading?: boolean;
  showFlow?: boolean;            // when true, add IN and NET columns
  reconciliation?: Reconciliation | null;
}) {
  // Newest month first for readability.
  const ordered = [...rows].reverse();
  const totalOut = rows.reduce((s, r) => s + r.lingoOut, 0);
  const totalIn = rows.reduce((s, r) => s + r.lingoIn, 0);
  const totalNet = totalIn - totalOut;
  const totalCount = rows.reduce((s, r) => s + r.count, 0);
  const cols = showFlow ? 5 : 3;
  const netColor = (n: number) => n > 0 ? 'text-green1' : n < 0 ? 'text-red-400' : 'text-soft-gray';

  return (
    <div className="flagship-card rounded-2xl overflow-hidden">
      <div className="p-5 border-b border-white/5 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">{title}</h3>
        <p className="text-sm text-soft-gray mt-1">{subtitle}</p>
      </div>
      <div className="relative z-10 overflow-x-auto">
        <table className="w-full min-w-[320px]">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-5">Month</th>
              {showFlow && <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-3">In</th>}
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-3">{showFlow ? 'Out' : 'LINGO Sent'}</th>
              {showFlow && <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-3">Net</th>}
              <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-5">{countLabel}</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              [...Array(5)].map((_, i) => (
                <tr key={i} className="border-b border-white/5">
                  <td className="py-3 px-5" colSpan={cols}><div className="skeleton h-4 w-full rounded" /></td>
                </tr>
              ))
            ) : ordered.length === 0 ? (
              <tr><td colSpan={cols} className="py-10 text-center text-soft-gray text-sm">No data available</td></tr>
            ) : (
              ordered.map(r => (
                <tr key={r.month} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors">
                  <td className="py-2.5 px-5 text-sm text-lavender font-medium whitespace-nowrap">{r.month}</td>
                  {showFlow && <td className="py-2.5 px-3 text-right text-sm text-green1">{r.lingoIn ? formatNumber(r.lingoIn) : '—'}</td>}
                  <td className="py-2.5 px-3 text-right text-sm font-semibold text-lavender">{formatNumber(r.lingoOut)}</td>
                  {showFlow && <td className={`py-2.5 px-3 text-right text-sm ${netColor(r.net)}`}>{r.net > 0 ? '+' : ''}{formatNumber(r.net)}</td>}
                  <td className="py-2.5 px-5 text-right text-sm text-soft-gray">{r.count.toLocaleString()}</td>
                </tr>
              ))
            )}
          </tbody>
          {!isLoading && ordered.length > 0 && (
            <tfoot>
              <tr className="border-t-2 border-white/10 bg-white/[0.03]">
                <td className="py-3 px-5 text-xs font-bold uppercase tracking-wider text-soft-gray">Total</td>
                {showFlow && <td className="py-3 px-3 text-right text-sm font-bold text-green1">{formatNumber(totalIn)}</td>}
                <td className="py-3 px-3 text-right text-sm font-bold text-lavender">{formatNumber(totalOut)}</td>
                {showFlow && <td className={`py-3 px-3 text-right text-sm font-bold ${netColor(totalNet)}`}>{totalNet > 0 ? '+' : ''}{formatNumber(totalNet)}</td>}
                <td className="py-3 px-5 text-right text-sm font-bold text-soft-gray">{totalCount.toLocaleString()}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      {/* Reconciliation: in − out should equal the live balance; a large
          unaccounted figure means a top-up or outflow is missing. */}
      {showFlow && reconciliation && (
        <div className="px-5 py-3 border-t border-white/5 relative z-10 flex items-center justify-between flex-wrap gap-2">
          <span className="text-xs text-soft-gray">
            In − Out = <span className="text-lavender font-medium">{formatNumber(reconciliation.impliedBalance)}</span>
            {'  vs  '}live balance <span className="text-lavender font-medium">{formatNumber(reconciliation.balanceNow)}</span>
          </span>
          <span className={`text-xs px-2 py-1 rounded-lg border ${
            Math.abs(reconciliation.unaccountedLingo) < 1
              ? 'text-green1 bg-green1/10 border-green1/30'
              : 'text-amber-soft bg-amber-soft/10 border-amber-soft/30'
          }`}>
            {Math.abs(reconciliation.unaccountedLingo) < 1
              ? '✓ fully reconciled — nothing missing'
              : `⚠️ ${formatNumber(reconciliation.unaccountedLingo)} unaccounted`}
          </span>
        </div>
      )}
    </div>
  );
}
