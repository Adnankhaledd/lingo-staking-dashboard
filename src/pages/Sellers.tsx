import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, ChevronDown, ChevronRight } from 'lucide-react';
import { Header } from '../components/layout';
import { formatNumber, exportToCSV } from '../utils/formatters';

/**
 * /sellers — who sold LINGO in a chosen period, from /api/sell-pressure:
 * DEX sellers with arbitrage and trading bots removed, and every deposit into
 * an exchange (MEXC, KuCoin, Gate, …). On-chain via Alchemy, cached hourly.
 */

const PERIODS = [7, 14, 20, 30, 45, 60, 90];

interface DexSeller {
  address: string; label: string | null; type: string; allTime: Record<string, number> | null; feeders: number;
  soldLingo: number; soldUsd: number; boughtOnDexLingo: number; netSoldLingo: number; netSoldUsd: number; sells: number; first: string; last: string; biggestTx: string;
}
interface Deposit { date: string; exchange: string; depositor: string; type: string | null; lingo: number; usd: number; tx: string }
interface BridgeOut { date: string; bridge: string; wallet: string; type: string | null; lingo: number; usd: number; tx: string }
interface Report {
  days: number; generatedAt: string; window: { from: string; to: string };
  dexSellers: DexSeller[]; removedAsArbitrage: DexSeller[]; exchangeDeposits: Deposit[]; bridgeOuts: BridgeOut[];
  totals: { dexBuys: { lingo: number; usd: number } };
}

const SOURCE_NAMES: Record<string, string> = {
  dex_buy: 'bought on DEX', unstaked: 'unstaked', vesting: 'vesting', apy: 'APY claims', rewards: 'rewards', claim: 'token claim',
  cex_withdrawal: 'exchange withdrawals', bridged_in: 'bridged in', project: 'project wallets', wallet: 'other wallets',
};

/** Plain-English seller type. */
function typeLabel(t: string | null, allTime?: Record<string, number> | null): string {
  if (!t) return '—';
  if (t.startsWith('project-funded')) return 'Project-funded (team / market maker?)';
  if (t.startsWith('project (')) return t.replace('project (', 'Project wallet (');
  if (t.startsWith('wallet farm')) {
    const [farm, origin] = t.split(' — ');
    return farm.replace('wallet farm', 'Wallet farm') + (origin ? ` · ${SOURCE_NAMES[origin] ?? origin}` : '');
  }
  if (t === 'arbitrage (DEX → exchange)') return 'Arbitrage: buys on DEX, sells on exchange';
  if (t === 'arbitrage (exchange → DEX)') return 'Arbitrage: exchange → DEX';
  if (t === 'arbitrage') return 'Arbitrage loop';
  if (t.startsWith('trader')) return 'Trader: buys as much as it sells';
  if (t.startsWith('net seller')) return 'Two-way trader, net seller';
  if (t.startsWith('cross-chain arbitrage (bridged in')) return 'Bridged in and sold within seconds (likely arbitrage)';
  if (t.startsWith('cross-chain')) return 'Bought here, bridged out (likely arbitrage)';
  if (t.startsWith('held')) {
    const top = allTime ? Object.entries(allTime).sort((a, b) => b[1] - a[1])[0]?.[0] : null;
    return top ? `Held from before (mostly ${SOURCE_NAMES[top] ?? top})` : 'Held from before';
  }
  const map: Record<string, string> = {
    unstaked: 'Unstaked, then sold', dex_buy: 'Bought earlier, then sold', apy: 'Claimed APY, then sold', vesting: 'Vesting unlock, then sold',
    rewards: 'Rewards, then sold', claim: 'Token claim, then sold', wallet: 'Received from another wallet', cex_withdrawal: 'Withdrew from an exchange',
    bridged_in: 'Bridged in', project: 'From project wallets',
  };
  if (t.startsWith('straight from ')) return t.replace('straight from ', 'Straight from ');
  return map[t] ?? t;
}

/** Same rule as the API's list split: these buy (on the DEX or elsewhere) as much as they sell. */
const isArb = (t: string | null) => !!t && (t.startsWith('arbitrage') || t.startsWith('trader') || t.startsWith('cross-chain'));

const usd = (n: number) => '$' + Math.round(n).toLocaleString();
const short = (a: string) => (/^0x[0-9a-f]{40}$/.test(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

function Addr({ a }: { a: string }) {
  if (!/^0x[0-9a-f]{40}$/.test(a)) return <span className="text-soft-gray">{a}</span>;
  return (
    <a href={`https://basescan.org/address/${a}`} target="_blank" rel="noopener noreferrer" className="font-mono text-lavender hover:text-purple inline-flex items-center gap-1">
      {short(a)}<ExternalLink className="w-3 h-3 opacity-60" />
    </a>
  );
}
function Tx({ h }: { h: string }) {
  return (
    <a href={`https://basescan.org/tx/${h}`} target="_blank" rel="noopener noreferrer" className="text-purple-gray hover:text-lavender inline-flex items-center gap-1">
      view<ExternalLink className="w-3 h-3" />
    </a>
  );
}

function Card({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="flagship-card p-5">
      <div className="relative z-10">
        <p className="text-[11px] text-soft-gray uppercase tracking-wider">{label}</p>
        <p className="text-2xl font-bold text-lavender mt-2">{value}</p>
        <p className="text-xs text-purple-gray mt-1">{note}</p>
      </div>
    </div>
  );
}

function SellerTable({ rows, empty }: { rows: DexSeller[]; empty: string }) {
  if (!rows.length) return <p className="text-soft-gray text-sm py-6 text-center">{empty}</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-soft-gray border-b border-white/5">
            <th className="py-2 pr-3 font-medium">#</th>
            <th className="py-2 pr-3 font-medium">Wallet</th>
            <th className="py-2 pr-3 font-medium">Type</th>
            <th className="py-2 pr-3 font-medium text-right">Sold (LINGO)</th>
            <th className="py-2 pr-3 font-medium text-right">Bought (LINGO)</th>
            <th className="py-2 pr-3 font-medium text-right">Net sold</th>
            <th className="py-2 pr-3 font-medium text-right">Net sold ($)</th>
            <th className="py-2 pr-3 font-medium text-right">Sales</th>
            <th className="py-2 pr-3 font-medium">Last sale</th>
            <th className="py-2 font-medium">Biggest</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.address} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
              <td className="py-2 pr-3 text-purple-gray">{i + 1}</td>
              <td className="py-2 pr-3"><Addr a={r.address} /></td>
              <td className="py-2 pr-3 text-soft-gray">{typeLabel(r.type, r.allTime)}</td>
              <td className="py-2 pr-3 text-right text-soft-gray">{formatNumber(r.soldLingo)}</td>
              <td className="py-2 pr-3 text-right text-purple-gray">{r.boughtOnDexLingo ? formatNumber(r.boughtOnDexLingo) : '—'}</td>
              <td className="py-2 pr-3 text-right text-lavender">{formatNumber(r.netSoldLingo)}</td>
              <td className="py-2 pr-3 text-right text-lavender font-medium">{usd(r.netSoldUsd)}</td>
              <td className="py-2 pr-3 text-right text-purple-gray">{r.sells}</td>
              <td className="py-2 pr-3 text-purple-gray">{r.last}</td>
              <td className="py-2"><Tx h={r.biggestTx} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Sellers() {
  const [days, setDays] = useState(20);
  const [data, setData] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exchange, setExchange] = useState('All');
  const [minUsd, setMinUsd] = useState(500);
  const [hideArbDeposits, setHideArbDeposits] = useState(true);
  const [showArbs, setShowArbs] = useState(false);
  const [showBridges, setShowBridges] = useState(false);
  const [showAllSellers, setShowAllSellers] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null);
    const base = import.meta.env.DEV ? 'http://localhost:3000' : '';
    fetch(`${base}/api/sell-pressure?days=${days}`)
      .then(r => r.json())
      .then(j => { if (!cancelled) { if (j?.error) setError(j.error); else setData(j as Report); } })
      .catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [days]);

  const exchanges = useMemo(() => ['All', ...new Set((data?.exchangeDeposits ?? []).map(d => d.exchange))], [data]);
  const deposits = useMemo(() => (data?.exchangeDeposits ?? [])
    .filter(d => (exchange === 'All' || d.exchange === exchange) && d.usd >= minUsd && !(hideArbDeposits && isArb(d.type))),
  [data, exchange, minUsd, hideArbDeposits]);

  const totals = useMemo(() => {
    if (!data) return null;
    const sum = <T,>(rows: T[], f: (r: T) => number) => rows.reduce((a, r) => a + f(r), 0);
    const byEx = new Map<string, number>();
    const realDeposits = data.exchangeDeposits.filter(d => !isArb(d.type));
    for (const d of realDeposits) byEx.set(d.exchange, (byEx.get(d.exchange) ?? 0) + d.usd);
    return {
      dexSold: sum(data.dexSellers, r => r.netSoldUsd), dexWallets: data.dexSellers.length,
      arbs: sum(data.removedAsArbitrage, r => r.soldUsd), arbWallets: data.removedAsArbitrage.length,
      deposits: sum(realDeposits, d => d.usd),
      byEx: [...byEx.entries()].sort((a, b) => b[1] - a[1]),
      bridged: sum(data.bridgeOuts, b => b.usd),
      bridges: [...new Set(data.bridgeOuts.map(b => b.bridge))].slice(0, 3).join(', '),
    };
  }, [data]);

  const sellersShown = showAllSellers ? data?.dexSellers ?? [] : (data?.dexSellers ?? []).slice(0, 50);

  return (
    <div className="min-h-screen bg-background">
      <Header lastUpdated={data ? new Date(data.generatedAt) : null} />
      <main className="relative w-full max-w-[1300px] mx-auto px-6 lg:px-10 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4 mb-6">
          <div>
            <h1 className="text-2xl font-semibold text-lavender">Who sold LINGO</h1>
            <p className="text-sm text-soft-gray mt-1">
              DEX sellers with arbitrage removed, and every deposit into an exchange · on-chain via Alchemy
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-white/10 p-0.5 text-sm">
            {PERIODS.map(p => (
              <button key={p} onClick={() => setDays(p)}
                className={`px-3 py-1.5 rounded-md transition-colors ${days === p ? 'bg-purple/30 text-lavender' : 'text-soft-gray hover:text-lavender'}`}>
                {p}d
              </button>
            ))}
          </div>
        </div>

        {loading && <div className="flagship-card p-8 text-center text-soft-gray">Loading the last {days} days… a period's first load takes ~15 seconds, then it's cached for an hour.</div>}
        {error && <div className="flagship-card p-6 text-red-400">Could not load: {error}</div>}

        {data && totals && !loading && (
          <>
            <p className="text-xs text-purple-gray mb-4">
              {data.window.from.slice(0, 10)} → {data.window.to.slice(0, 10)} · built {new Date(data.generatedAt).toUTCString().slice(5, 22)} UTC
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-6">
              <Card label="Net sold on the DEX" value={usd(totals.dexSold)} note={`${totals.dexWallets} wallets, arbitrage removed`} />
              <Card label="Deposited to exchanges" value={usd(totals.deposits)}  note={totals.byEx.slice(0, 3).map(([e, v]) => `${e} ${usd(v)}`).join(' · ') || '—'} />
              <Card label="Removed as arbitrage / bots" value={usd(totals.arbs)} note={`${totals.arbWallets} wallets that buy as well as sell`} />
              <Card label="Bridged out" value={usd(totals.bridged)} note={totals.bridges ? `Via ${totals.bridges}` : 'None in this period'} />
            </div>

            {/* DEX sellers */}
            <section className="flagship-card p-6 mb-6">
              <div className="relative z-10">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <div>
                    <h2 className="text-lg font-semibold text-lavender">Sold on the DEX</h2>
                    <p className="text-xs text-soft-gray mt-1">
                      The seller is the wallet that lost the LINGO, even when it traded through a router or aggregator. Ranked by net sold: what it sold minus what it bought on the DEX in the same period.
                      Removed and listed below: wallets that bought about as much as they sold, ones that restock from an exchange or a bridge and sell straight away, and arbitrage loops.
                    </p>
                  </div>
                  <button onClick={() => exportToCSV(data.dexSellers.map(r => ({ ...r, type: typeLabel(r.type, r.allTime), allTime: JSON.stringify(r.allTime) })), `lingo_dex_sellers_${days}d`)}
                    className="text-xs px-3 py-1.5 rounded-lg border border-white/10 text-soft-gray hover:text-lavender">CSV</button>
                </div>
                <SellerTable rows={sellersShown} empty="No DEX sellers in this period." />
                {data.dexSellers.length > 50 && (
                  <button onClick={() => setShowAllSellers(v => !v)} className="mt-3 text-xs text-purple-gray hover:text-lavender">
                    {showAllSellers ? 'Show top 50' : `Show all ${data.dexSellers.length}`}
                  </button>
                )}
              </div>
            </section>

            {/* Exchange deposits */}
            <section className="flagship-card p-6 mb-6">
              <div className="relative z-10">
                <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                  <div>
                    <h2 className="text-lg font-semibold text-lavender">Deposits to exchanges</h2>
                    <p className="text-xs text-soft-gray mt-1">
                      LINGO sent to an exchange: to its hot wallet, or to a customer deposit address (recognised by sweeping everything into that exchange).
                      The depositor is whoever funded it. "Hide arbitrage" drops bots that bought on the DEX and sent it straight to the exchange.
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    <label className="inline-flex items-center gap-1.5 text-soft-gray cursor-pointer">
                      <input type="checkbox" checked={hideArbDeposits} onChange={e => setHideArbDeposits(e.target.checked)} />
                      Hide arbitrage
                    </label>
                    <select value={exchange} onChange={e => setExchange(e.target.value)} className="bg-transparent border border-white/10 rounded-lg px-2 py-1.5 text-soft-gray">
                      {exchanges.map(x => <option key={x} value={x} className="bg-background">{x}</option>)}
                    </select>
                    <select value={minUsd} onChange={e => setMinUsd(Number(e.target.value))} className="bg-transparent border border-white/10 rounded-lg px-2 py-1.5 text-soft-gray">
                      {[0, 100, 500, 1000, 5000].map(v => <option key={v} value={v} className="bg-background">{v ? `≥ $${v.toLocaleString()}` : 'Any size'}</option>)}
                    </select>
                    <button onClick={() => exportToCSV(deposits.map(d => ({ ...d, type: typeLabel(d.type) })), `lingo_exchange_deposits_${days}d`)}
                      className="px-3 py-1.5 rounded-lg border border-white/10 text-soft-gray hover:text-lavender">CSV</button>
                  </div>
                </div>
                {deposits.length ? (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-soft-gray border-b border-white/5">
                          <th className="py-2 pr-3 font-medium">Date (UTC)</th>
                          <th className="py-2 pr-3 font-medium">Exchange</th>
                          <th className="py-2 pr-3 font-medium">Depositor</th>
                          <th className="py-2 pr-3 font-medium">Type</th>
                          <th className="py-2 pr-3 font-medium text-right">LINGO</th>
                          <th className="py-2 pr-3 font-medium text-right">$</th>
                          <th className="py-2 font-medium">Tx</th>
                        </tr>
                      </thead>
                      <tbody>
                        {deposits.map((d, i) => (
                          <tr key={d.tx + i} className="border-b border-white/[0.03] hover:bg-white/[0.02]">
                            <td className="py-2 pr-3 text-purple-gray whitespace-nowrap">{d.date}</td>
                            <td className="py-2 pr-3 text-lavender">{d.exchange}</td>
                            <td className="py-2 pr-3"><Addr a={d.depositor} /></td>
                            <td className="py-2 pr-3 text-soft-gray">{typeLabel(d.type)}</td>
                            <td className="py-2 pr-3 text-right text-lavender">{formatNumber(d.lingo)}</td>
                            <td className="py-2 pr-3 text-right text-lavender font-medium">{usd(d.usd)}</td>
                            <td className="py-2"><Tx h={d.tx} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="text-soft-gray text-sm py-6 text-center">No deposits match.</p>}
              </div>
            </section>

            {/* Removed as arbitrage */}
            <section className="flagship-card p-6 mb-6">
              <div className="relative z-10">
                <button onClick={() => setShowArbs(v => !v)} className="flex items-center gap-2 text-lavender font-semibold">
                  {showArbs ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  Removed as arbitrage / trading bots ({data.removedAsArbitrage.length}, {usd(totals.arbs)})
                </button>
                {showArbs && <div className="mt-3"><SellerTable rows={data.removedAsArbitrage} empty="None." /></div>}
              </div>
            </section>

            <section className="flagship-card p-6 mb-6">
              <div className="relative z-10">
                <button onClick={() => setShowBridges(v => !v)} className="flex items-center gap-2 text-lavender font-semibold">
                  {showBridges ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  Bridged out ({data.bridgeOuts.length}, {usd(totals.bridged)})
                </button>
                {showBridges && (
                  <div className="overflow-x-auto mt-3">
                    <table className="w-full text-sm">
                      <tbody>
                        {data.bridgeOuts.map((b, i) => (
                          <tr key={b.tx + i} className="border-b border-white/[0.03]">
                            <td className="py-2 pr-3 text-purple-gray whitespace-nowrap">{b.date}</td>
                            <td className="py-2 pr-3 text-lavender">{b.bridge}</td>
                            <td className="py-2 pr-3"><Addr a={b.wallet} /></td>
                            <td className="py-2 pr-3 text-soft-gray">{typeLabel(b.type)}</td>
                            <td className="py-2 pr-3 text-right text-lavender">{formatNumber(b.lingo)}</td>
                            <td className="py-2 pr-3 text-right text-lavender">{usd(b.usd)}</td>
                            <td className="py-2"><Tx h={b.tx} /></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </section>

            <p className="text-xs text-purple-gray leading-relaxed">
              Types come from where each wallet's LINGO came from: the 30 days before it sold, plus its all-time funding for the biggest sellers, so someone who bought months ago and sells now reads as a genuine seller.
              "Project-funded" means most of the wallet's LINGO came from project wallets — likely your own team or market maker, worth confirming.
              USD at the pool's own price on the day.
            </p>
          </>
        )}
      </main>
    </div>
  );
}
