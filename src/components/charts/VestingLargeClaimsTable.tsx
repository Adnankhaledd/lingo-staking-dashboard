import { useState } from 'react';
import { ExternalLink, Zap, Coins } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { useVestingLargeClaims } from '../../hooks/useVestingLargeClaims';

const DAY_OPTIONS = [7, 30, 90] as const;
const MIN_OPTIONS = [10000, 50000, 100000, 250000] as const;

function shortWallet(w: string): string {
  if (!w) return '—';
  return `${w.slice(0, 6)}…${w.slice(-4)}`;
}

function fmtDateTime(tsSec: number): string {
  if (!tsSec) return '—';
  const d = new Date(tsSec * 1000);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) +
    ', ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
}

function minLabel(v: number): string {
  return v >= 1000 ? `${v / 1000}K` : String(v);
}

export function VestingLargeClaimsTable() {
  const [days, setDays] = useState<number>(30);
  const [minLingo, setMinLingo] = useState<number>(50000);
  const { data, windowClaims, windowLingo, largeClaims, largeLingo, truncated, isLoading, error } =
    useVestingLargeClaims(days, minLingo);

  const rows = data ?? [];

  return (
    <div className="flagship-card rounded-2xl">
      {/* Header + controls */}
      <div className="flex items-start justify-between p-6 border-b border-white/5 relative z-10 flex-wrap gap-3">
        <div>
          <h3 className="text-lg font-semibold text-lavender flex items-center gap-2">
            Large Vesting Claims
            <span className="flex items-center gap-1 text-[11px] text-green1 font-normal"><Zap className="w-3 h-3" /> live</span>
          </h3>
          <p className="text-sm text-soft-gray mt-1">
            Individual claims &ge; {minLabel(minLingo)} LINGO in the last {days} days &middot; via Alchemy
          </p>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          <div>
            <span className="block text-[10px] text-purple-gray uppercase tracking-wider mb-1">Timeframe</span>
            <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
              {DAY_OPTIONS.map(d => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-3 py-1.5 text-xs font-medium transition-all ${
                    days === d ? 'bg-purple/30 text-white' : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
          <div>
            <span className="block text-[10px] text-purple-gray uppercase tracking-wider mb-1">Min size</span>
            <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
              {MIN_OPTIONS.map(m => (
                <button
                  key={m}
                  onClick={() => setMinLingo(m)}
                  className={`px-3 py-1.5 text-xs font-medium transition-all ${
                    minLingo === m ? 'bg-purple/30 text-white' : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
                  }`}
                >
                  {minLabel(m)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Summary strip */}
      {!isLoading && !error && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-px bg-white/5 relative z-10">
          <Stat label={`Claims ≥ ${minLabel(minLingo)}`} value={largeClaims != null ? largeClaims.toLocaleString() : '—'} />
          <Stat label="LINGO (large)" value={largeLingo != null ? formatNumber(largeLingo) : '—'} accent />
          <Stat label={`All claims (${days}d)`} value={windowClaims != null ? windowClaims.toLocaleString() : '—'} />
          <Stat label={`All LINGO (${days}d)`} value={windowLingo != null ? formatNumber(windowLingo) : '—'} />
        </div>
      )}

      {/* Table */}
      <div className="max-h-[520px] overflow-y-auto relative z-10">
        {error ? (
          <div className="py-16 text-center text-red-400 text-sm">{error}</div>
        ) : (
          <table className="w-full">
            <thead className="sticky top-0 z-10" style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
              <tr className="border-b border-white/5">
                <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">Wallet</th>
                <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">LINGO Claimed</th>
                <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">When (UTC)</th>
                <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Tx</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                [...Array(8)].map((_, i) => (
                  <tr key={i} className="border-b border-white/5">
                    <td className="py-3 px-6"><div className="skeleton h-5 w-32 rounded" /></td>
                    <td className="py-3 px-4"><div className="skeleton h-5 w-24 rounded ml-auto" /></td>
                    <td className="py-3 px-6"><div className="skeleton h-5 w-28 rounded ml-auto" /></td>
                    <td className="py-3 px-4"><div className="skeleton h-5 w-6 rounded mx-auto" /></td>
                  </tr>
                ))
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={4} className="py-16 text-center text-soft-gray text-sm">
                    No claims &ge; {minLabel(minLingo)} LINGO in the last {days} days
                  </td>
                </tr>
              ) : (
                rows.map((r, i) => (
                  <tr key={`${r.txHash ?? r.wallet}-${i}`} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group">
                    <td className="py-3 px-6">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-sm text-lavender/80 group-hover:text-lavender transition-colors">{shortWallet(r.wallet)}</span>
                        <a href={`https://basescan.org/address/${r.wallet}`} target="_blank" rel="noopener noreferrer" className="text-white/20 hover:text-purple transition-colors">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right">
                      <span className="font-semibold text-lavender inline-flex items-center gap-1.5">
                        <Coins className="w-3.5 h-3.5 text-amber-soft" />
                        {formatNumber(r.lingo)}
                      </span>
                    </td>
                    <td className="py-3 px-6 text-right text-soft-gray text-sm whitespace-nowrap">{fmtDateTime(r.timestamp)}</td>
                    <td className="py-3 px-4 text-center">
                      {r.txHash ? (
                        <a href={`https://basescan.org/tx/${r.txHash}`} target="_blank" rel="noopener noreferrer" className="text-white/25 hover:text-purple transition-colors inline-flex">
                          <ExternalLink className="w-3.5 h-3.5" />
                        </a>
                      ) : '—'}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        )}
        {truncated && (
          <div className="py-3 text-center text-xs text-purple-gray">Showing the most recent 200 — narrow the timeframe or raise the min size to see fewer.</div>
        )}
      </div>
    </div>
  );
}

function Stat({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="bg-[rgba(20,20,31,0.6)] px-4 py-3">
      <div className="text-[10px] text-purple-gray uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${accent ? 'text-amber-soft' : 'text-lavender'}`}>{value}</div>
    </div>
  );
}
