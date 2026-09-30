import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import { Header } from '../components/layout';
import { ChartCard } from '../components/cards';
import { BarChartComponent } from '../components/charts';
import { formatNumber, exportToCSV } from '../utils/formatters';

/**
 * /fees — fees collected since launch, from /api/fees-collected (on-chain via
 * Alchemy). A standalone summary, not part of the main dashboard.
 */

type SenderCategory = 'user' | 'router' | 'dex' | 'project' | 'claims' | 'mint' | 'deposit';
interface Agg { lingo: number; usd: number; transfers: number }
interface MonthRecord {
  month: string;
  final: boolean;
  avgPrice: number | null;
  treasury: {
    byCategory: Record<SenderCategory, Agg>;
    verified: { checked: number; fees: number; deposits: number };
    uniqueSenders: number;
    dust: Agg;
    over100k: Agg;
    topSenders: Array<{ address: string; category: SenderCategory; label: string | null; lingo: number; transfers: number }>;
  };
  pool: { swaps: number; volumeUsd: number; feesUsd: number; volumeLingo: number };
}
interface Summary {
  generatedAt: string;
  complete: boolean;
  pool: { address: string; feeTier: number };
  feeSchedule: Array<{ fromBlock: number; fromTs: number; bps: number }>;
  months: MonthRecord[];
}

// The LINGO transfer fee as paid by anyone outside the project — wallets
// directly, or a swap router/pool on a trade. Every large one is verified
// on-chain by the endpoint; deposits and fees the project paid itself are not.
const FEE_CATEGORIES: SenderCategory[] = ['user', 'router', 'dex'];

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (ym: string) => { const [y, m] = ym.split('-').map(Number); return `${MONTHS[m - 1]} '${String(y).slice(2)}`; };
const usd = (n: number) => '$' + Math.round(n).toLocaleString();
const usdShort = (n: number) => '$' + formatNumber(n, n >= 1_000_000 ? 2 : 1);

function useFees() {
  const [data, setData] = useState<Summary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    fetch(`${base}/api/fees-collected`)
      .then(r => r.json())
      .then(j => { if (cancelled) return; if (j?.months) setData(j as Summary); else setError(j?.error ?? j?.progress ?? 'Not ready'); })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); });
    return () => { cancelled = true; };
  }, []);
  return { data, error, isLoading: !data && !error };
}

export function Fees() {
  const { data, error, isLoading } = useFees();

  const rows = useMemo(() => (data?.months ?? []).map(m => {
    const fee = FEE_CATEGORIES.reduce((a, c) => ({
      lingo: a.lingo + m.treasury.byCategory[c].lingo,
      usd: a.usd + m.treasury.byCategory[c].usd,
      transfers: a.transfers + m.treasury.byCategory[c].transfers,
    }), { lingo: 0, usd: 0, transfers: 0 });
    return {
      month: m.month,
      label: monthLabel(m.month) + (m.final ? '' : ' (MTD)'),
      treasuryUsd: fee.usd,
      treasuryLingo: fee.lingo,
      payments: fee.transfers,
      lpUsd: m.pool.feesUsd,
      volumeUsd: m.pool.volumeUsd,
    };
  }), [data]);

  const totals = useMemo(() => rows.reduce((t, r) => ({
    treasuryUsd: t.treasuryUsd + r.treasuryUsd,
    treasuryLingo: t.treasuryLingo + r.treasuryLingo,
    payments: t.payments + r.payments,
    lpUsd: t.lpUsd + r.lpUsd,
    volumeUsd: t.volumeUsd + r.volumeUsd,
  }), { treasuryUsd: 0, treasuryLingo: 0, payments: 0, lpUsd: 0, volumeUsd: 0 }), [rows]);

  const byYear = useMemo(() => {
    const m = new Map<string, { treasury: number; lp: number }>();
    for (const r of rows) {
      const y = r.month.slice(0, 4);
      const e = m.get(y) ?? { treasury: 0, lp: 0 };
      e.treasury += r.treasuryUsd; e.lp += r.lpUsd;
      m.set(y, e);
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [rows]);

  // Cumulative: launch month alone is ~60% of the total, so a monthly view
  // flattens everything after it. The by-year table carries the breakdown.
  const chart = rows.reduce<Array<{ month: string; treasury: number; lp: number }>>((acc, r) => {
    const prev = acc[acc.length - 1];
    acc.push({ month: r.label, treasury: Math.round((prev?.treasury ?? 0) + r.treasuryUsd), lp: Math.round((prev?.lp ?? 0) + r.lpUsd) });
    return acc;
  }, []);
  const grand = totals.treasuryUsd + totals.lpUsd;
  const first = rows[0]?.month;
  const last = rows[rows.length - 1]?.month;
  const feePct = data ? (data.pool.feeTier / 10_000).toFixed(1) : '0.3';
  // The rate that applied for nearly all of history, and when it was switched off.
  const schedule = data?.feeSchedule ?? [];
  const mainRate = schedule.filter(x => x.bps > 0).sort((a, b) => b.fromTs - a.fromTs)[0];
  const offAt = schedule.length && schedule[schedule.length - 1].bps === 0 ? schedule[schedule.length - 1].fromTs : null;
  const fmtDate = (ts: number) => new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });

  return (
    <div className="min-h-screen bg-background">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple/6 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-sosiska/5 rounded-full blur-[150px]" />
      </div>
      <Header lastUpdated={data ? new Date(data.generatedAt) : null} />

      <main className="relative w-full max-w-[1200px] mx-auto px-6 lg:px-10 py-8">
        {/* Hero */}
        <div className="flagship-card p-8 mb-5">
          <div className="relative z-10 flex flex-col items-center text-center gap-2">
            <span className="text-xs text-soft-gray uppercase tracking-widest">Fees Collected Since Launch</span>
            <span className="text-5xl font-bold bg-gradient-to-r from-yellow-300 via-amber-400 to-yellow-500 bg-clip-text text-transparent tracking-tight">
              {isLoading ? '…' : usd(grand)}
            </span>
            {first && last && (
              <span className="text-sm text-purple-gray">
                {monthLabel(first)} – {monthLabel(last)} · every figure read from Base on-chain data
              </span>
            )}
            {error && <span className="text-sm text-red-400">{error}</span>}
          </div>
        </div>

        {/* Split */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-5">
          <div className="flagship-card p-6">
            <div className="relative z-10">
              <div className="flex items-center gap-2 text-sm text-soft-gray">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#FFD75E' }} /> Treasury fees
              </div>
              <div className="text-3xl font-bold text-lavender mt-2">{usd(totals.treasuryUsd)}</div>
              <p className="text-xs text-purple-gray mt-1">
                {mainRate ? `${mainRate.bps / 100}% LINGO transfer fee` : 'LINGO transfer fee'} · {formatNumber(totals.treasuryLingo)} LINGO from {totals.payments.toLocaleString()} payments
                {offAt ? ` · switched off ${fmtDate(offAt)}` : ''}
              </p>
            </div>
          </div>
          <div className="flagship-card p-6">
            <div className="relative z-10">
              <div className="flex items-center gap-2 text-sm text-soft-gray">
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: '#7B68AE' }} /> Liquidity pool fees
              </div>
              <div className="text-3xl font-bold text-lavender mt-2">{usd(totals.lpUsd)}</div>
              <p className="text-xs text-purple-gray mt-1">
                {feePct}% of {usdShort(totals.volumeUsd)} traded in the LINGO/WETH pool
              </p>
            </div>
          </div>
        </div>

        {/* Monthly */}
        <div className="mb-5">
          <ChartCard
            title="Cumulative Fees Since Launch"
            subtitle="Running total in USD, each fee valued at the LINGO price on the day it was paid"
            isLoading={isLoading}
            onExport={() => exportToCSV(rows, 'lingo_fees_by_month')}
          >
            {chart.length ? (
              <BarChartComponent
                data={chart}
                xAxisKey="month"
                formatXAxis={v => v}
                formatValue={v => usd(v)}
                showTotal
                bars={[
                  { dataKey: 'treasury', name: 'Treasury fees', color: '#FFD75E', stackId: 'f' },
                  { dataKey: 'lp', name: 'Liquidity pool fees', color: '#7B68AE', stackId: 'f' },
                ]}
                height={300}
              />
            ) : <div className="h-[300px] flex items-center justify-center text-soft-gray">{isLoading ? 'Loading…' : 'No data'}</div>}
          </ChartCard>
        </div>

        {/* By year */}
        {byYear.length > 0 && (
          <div className="flagship-card p-6 mb-5">
            <div className="relative z-10">
              <div className="grid gap-3 text-sm" style={{ gridTemplateColumns: 'minmax(80px,1fr) repeat(3, minmax(0,1fr))' }}>
                <span className="text-soft-gray">Year</span>
                <span className="text-soft-gray text-right">Treasury fees</span>
                <span className="text-soft-gray text-right">Pool fees</span>
                <span className="text-soft-gray text-right">Total</span>
                {byYear.map(([y, v]) => (
                  <div key={y} className="contents">
                    <span className="text-lavender font-medium">{y}{y === last?.slice(0, 4) ? ' YTD' : y === first?.slice(0, 4) && first?.endsWith('-12') ? ' (Dec)' : ''}</span>
                    <span className="text-lavender text-right">{usd(v.treasury)}</span>
                    <span className="text-lavender text-right">{usd(v.lp)}</span>
                    <span className="text-lavender font-semibold text-right">{usd(v.treasury + v.lp)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        <p className="flex items-start gap-2 text-xs text-purple-gray leading-relaxed">
          <ShieldCheck className="w-4 h-4 text-green1 shrink-0 mt-0.5" />
          <span>
            Treasury fees are the LINGO token's built-in transfer fee, paid to the Treasury on every taxable transfer
            {offAt ? ` until it was set to 0% on ${fmtDate(offAt)}` : ''}. Every fee of 1,000+ LINGO is matched on-chain to the transfer it was taken from;
            direct deposits and fees paid by project wallets, vesting and reward contracts are not counted.
            Pool fees are the LINGO/WETH pool's {feePct}% fee on every swap, paid to its liquidity providers.
            All values in USD at the pool's own LINGO price on the day. Source: Base on-chain events via Alchemy.
          </span>
        </p>
      </main>
    </div>
  );
}
