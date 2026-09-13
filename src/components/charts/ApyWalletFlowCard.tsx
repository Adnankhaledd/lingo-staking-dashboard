import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { ExternalLink, Zap } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { useWalletMonthlyLingo } from '../../hooks/useWalletMonthlyLingo';
import { MonthlyLingoSentTable, type MonthlyLingoRow } from '../cards/MonthlyLingoSentTable';

// The APY claim contract: treasury tops it up (IN), stakers claim APY from it
// (OUT). Since everything that comes in is what gets paid out, IN and OUT
// together show both how much APY is being claimed and how it is funded.
const APY_WALLET = '0x2f26621e931c32542579CF8860D7e8616DF32E0E';

const IN_COLOR = '#5EB851';
const OUT_COLOR = '#C4B5D4';

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-').map(Number);
  if (!y || !m) return ym;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', { month: 'short', year: '2-digit', timeZone: 'UTC' });
}

export function ApyWalletFlowCard() {
  const { data, totalIn, totalOut, reconciliation, isLoading, error } = useWalletMonthlyLingo(APY_WALLET);
  const [range, setRange] = useState<'12m' | 'all'>('12m');

  const currentMonth = new Date().toISOString().slice(0, 7);
  const rows = data ?? [];

  // The current month is still in progress — flag it so a low number
  // isn't read as a slowdown.
  const chartData = useMemo(() => {
    const all = rows.map(r => ({
      label: monthLabel(r.month) + (r.month === currentMonth ? ' (MTD)' : ''),
      in: r.lingoIn,
      out: r.lingoSent,
      payouts: r.transfers,
    }));
    return range === '12m' ? all.slice(-12) : all;
  }, [rows, range, currentMonth]);

  const tableRows: MonthlyLingoRow[] = useMemo(
    () => rows.map(r => ({
      month: monthLabel(r.month) + (r.month === currentMonth ? ' (MTD)' : ''),
      lingoIn: r.lingoIn,
      lingoOut: r.lingoSent,
      net: r.net,
      count: r.transfers,
    })),
    [rows, currentMonth],
  );

  const totalPayouts = rows.reduce((s, r) => s + r.transfers, 0);
  const avgPayout = totalPayouts > 0 && totalOut != null ? totalOut / totalPayouts : null;
  const reconciled = reconciliation ? Math.abs(reconciliation.unaccountedLingo) < 1 : null;

  return (
    <div className="space-y-6">
      <div className="flagship-card rounded-2xl p-6">
        <div className="flex items-start justify-between mb-4 relative z-10 flex-wrap gap-3">
          <div>
            <h3 className="text-lg font-semibold text-lavender flex items-center gap-2">
              APY Wallet — LINGO In vs Out
              <span className="flex items-center gap-1 text-[11px] text-green1 font-normal"><Zap className="w-3 h-3" /> live</span>
            </h3>
            <p className="text-sm text-soft-gray mt-1 flex items-center gap-1.5">
              Treasury top-ups in, APY claims paid out · via Alchemy
              <a
                href={`https://basescan.org/address/${APY_WALLET}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-white/25 hover:text-purple transition-colors"
                title="View on BaseScan"
              >
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
            </p>
          </div>
          <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
            {(['12m', 'all'] as const).map(k => (
              <button
                key={k}
                onClick={() => setRange(k)}
                className={`px-3 py-1.5 text-xs font-medium transition-all ${
                  range === k ? 'bg-purple/30 text-white' : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                {k === '12m' ? '12 months' : 'All'}
              </button>
            ))}
          </div>
        </div>

        {!isLoading && !error && (
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-px bg-white/5 rounded-xl overflow-hidden mb-5 relative z-10">
            <Stat label="Total in" value={totalIn != null ? formatNumber(totalIn) : '—'} color="text-green1" />
            <Stat label="Total paid out" value={totalOut != null ? formatNumber(totalOut) : '—'} />
            <Stat label="Live balance" value={reconciliation ? formatNumber(reconciliation.balanceNow) : '—'} />
            <Stat label="APY payouts" value={totalPayouts.toLocaleString()} />
            <Stat label="Avg payout" value={avgPayout != null ? formatNumber(avgPayout) : '—'} />
          </div>
        )}

        <div className="h-72 relative z-10">
          {isLoading ? (
            <div className="skeleton h-full w-full rounded-xl" />
          ) : error ? (
            <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>
          ) : chartData.length === 0 ? (
            <div className="h-full flex items-center justify-center text-soft-gray text-sm">No data available</div>
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={8} interval="preserveStartEnd" />
                <YAxis tickFormatter={(v) => formatNumber(Number(v))} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={62} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                  content={({ active, payload, label }) => {
                    if (!active || !payload || !payload.length) return null;
                    const r = payload[0].payload as { in: number; out: number; payouts: number };
                    const net = r.in - r.out;
                    return (
                      <div className="custom-tooltip">
                        <p className="text-soft-gray text-xs mb-2">{String(label)}</p>
                        <p className="text-sm"><span className="text-soft-gray">In: </span><span className="text-green1 font-semibold">{formatNumber(r.in)} LINGO</span></p>
                        <p className="text-sm"><span className="text-soft-gray">Paid out: </span><span className="text-lavender font-semibold">{formatNumber(r.out)} LINGO</span></p>
                        <p className="text-xs text-purple-gray mt-1">
                          {r.payouts.toLocaleString()} payouts · net {net > 0 ? '+' : ''}{formatNumber(net)}
                        </p>
                      </div>
                    );
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: 8 }} />
                <Bar dataKey="in" name="In (top-ups)" fill={IN_COLOR} fillOpacity={0.85} radius={[4, 4, 0, 0]} animationDuration={800} />
                <Bar dataKey="out" name="Out (APY claims)" fill={OUT_COLOR} fillOpacity={0.85} radius={[4, 4, 0, 0]} animationDuration={800} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>

        {reconciled === false && (
          <p className="text-xs text-amber-soft mt-3 relative z-10">
            ⚠️ In − Out doesn't match the live balance — some transfers may be missing from history.
          </p>
        )}
      </div>

      <MonthlyLingoSentTable
        title="APY Wallet — Monthly In / Out"
        subtitle="Every LINGO top-up and APY payout per month (current month is month-to-date)"
        countLabel="Payouts"
        rows={tableRows}
        isLoading={isLoading}
        showFlow
        reconciliation={reconciliation}
      />
    </div>
  );
}

function Stat({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="bg-[rgba(20,20,31,0.6)] px-4 py-3">
      <div className="text-[10px] text-purple-gray uppercase tracking-wider">{label}</div>
      <div className={`text-lg font-bold mt-0.5 ${color ?? 'text-lavender'}`}>{value}</div>
    </div>
  );
}
