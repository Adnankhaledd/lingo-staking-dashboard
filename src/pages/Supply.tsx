import { useMemo } from 'react';
import { ExternalLink, AlertTriangle } from 'lucide-react';
import { Header } from '../components/layout';
import { formatNumber } from '../utils/formatters';
import { useSupplyData } from '../hooks/useSupplyData';

const MAX_SUPPLY = 1_000_000_000; // 1B LINGO hard cap
const LINGO_TOKEN = '0xfb42Da273158B0F642F59F2Ba7cc1d5457481677';
const STAKING_CONTRACT = '0x9aF8C0dac726CcEE2BFd6c0f3E21f320d42398AC';

function truncateAddress(addr: string): string {
  if (!addr) return '—';
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function pct(value: number, denominator: number): string {
  if (!denominator || denominator === 0) return '—';
  return `${((value / denominator) * 100).toFixed(2)}%`;
}

interface BigStatCardProps {
  label: string;
  value: string;
  sub?: string;
  accent: string;
  loading?: boolean;
}

function BigStatCard({ label, value, sub, accent, loading }: BigStatCardProps) {
  return (
    <div className="flagship-card p-6 group transition-all duration-300 hover:scale-[1.01]">
      <div
        className="absolute -top-16 -right-16 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ backgroundColor: `${accent}25` }}
      />
      <div className="relative z-10">
        <div className="text-[11px] text-soft-gray font-medium uppercase tracking-wider">
          {label}
        </div>
        {loading ? (
          <div className="skeleton h-10 w-48 rounded mt-2" />
        ) : (
          <div className="text-4xl font-bold mt-2 tracking-tight" style={{ color: accent }}>
            {value}
          </div>
        )}
        {sub && (
          <div className="text-xs text-purple-gray mt-1.5">{sub}</div>
        )}
      </div>
    </div>
  );
}

/** Width-proportional bar showing each segment's share of total supply. */
function SupplyBreakdownBar({
  totalSupply,
  walletSegments,
}: {
  totalSupply: number;
  walletSegments: Array<{ name: string; balance: number; color: string }>;
}) {
  const nonCirc = walletSegments.reduce((s, w) => s + w.balance, 0);
  const circ = Math.max(0, totalSupply - nonCirc);
  return (
    <div className="space-y-2">
      <div className="flex h-3 rounded-full overflow-hidden bg-dark3">
        {walletSegments.map(seg => (
          <div
            key={seg.name}
            className="h-full"
            style={{ width: `${(seg.balance / totalSupply) * 100}%`, backgroundColor: seg.color }}
            title={`${seg.name}: ${formatNumber(seg.balance)} (${pct(seg.balance, totalSupply)})`}
          />
        ))}
        <div
          className="h-full bg-green1"
          style={{ width: `${(circ / totalSupply) * 100}%` }}
          title={`Circulating: ${formatNumber(circ)} (${pct(circ, totalSupply)})`}
        />
      </div>
      <div className="flex items-center gap-3 flex-wrap text-[11px] text-soft-gray">
        {walletSegments.map(seg => (
          <span key={seg.name} className="inline-flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-sm" style={{ backgroundColor: seg.color }} />
            {seg.name}
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-sm bg-green1" />
          Circulating
        </span>
      </div>
    </div>
  );
}

// Stable, distinct palette for the wallet segments — falls back to a soft gray
// if there are more wallets than colors.
const WALLET_COLORS = ['#7B68AE', '#C4B5D4', '#FF7847', '#FFD75E', '#5EB8C8', '#E85757', '#A77FE0', '#909CB8'];

export function Supply() {
  const { totalSupply, wallets, fetchedAt, configured, error, isLoading } = useSupplyData();

  const summary = useMemo(() => {
    const nonCirc = wallets.reduce((sum, w) => sum + (w.balance ?? 0), 0);
    const circ = totalSupply != null ? Math.max(0, totalSupply - nonCirc) : null;
    const mintHeadroom = totalSupply != null ? Math.max(0, MAX_SUPPLY - totalSupply) : null;
    const staked = wallets.find(
      w => w.address.toLowerCase() === STAKING_CONTRACT.toLowerCase()
    )?.balance ?? null;
    return { nonCirc, circ, mintHeadroom, staked };
  }, [wallets, totalSupply]);

  return (
    <div className="min-h-screen bg-background">
      {/* Background gradient effects */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple/6 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-sosiska/5 rounded-full blur-[150px]" />
      </div>

      <Header lastUpdated={fetchedAt ? new Date(fetchedAt) : null} />

      <main className="relative w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8">
        <section className="mb-8">
          <div className="flex items-baseline justify-between flex-wrap gap-2 mb-2">
            <h1 className="text-2xl font-bold text-lavender">LINGO Supply</h1>
            <a
              href={`https://basescan.org/token/${LINGO_TOKEN}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-xs text-purple-gray hover:text-lavender transition-colors"
            >
              View on Basescan <ExternalLink className="w-3 h-3" />
            </a>
          </div>
          <p className="text-sm text-soft-gray">
            Hard cap of 1B LINGO. Total Supply is read live from the contract on Base; circulating
            supply subtracts the known non-circulating wallets listed below.
          </p>
        </section>

        {!configured && (
          <div className="mb-6 flagship-card p-4 border border-amber-500/30">
            <div className="flex items-start gap-2 text-amber-300 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>
                Alchemy API key not configured. Set <code>ALCHEMY_API_KEY</code> in Vercel env vars to enable live supply data.
              </span>
            </div>
          </div>
        )}

        {error && configured && (
          <div className="mb-6 flagship-card p-4 border border-red-500/30">
            <div className="flex items-start gap-2 text-red-300 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>Error fetching supply data: {error}</span>
            </div>
          </div>
        )}

        {/* Top stat row — Max | Total | Staked | Circulating */}
        <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4 mb-8">
          <BigStatCard
            label="Max Supply (Hard Cap)"
            value={`${formatNumber(MAX_SUPPLY)}`}
            sub="1,000,000,000 LINGO • can never exceed"
            accent="#FFD75E"
          />
          <BigStatCard
            label="Total Supply (Minted)"
            value={totalSupply != null ? formatNumber(totalSupply) : '—'}
            sub={
              totalSupply != null
                ? `${pct(totalSupply, MAX_SUPPLY)} of cap • ${formatNumber(summary.mintHeadroom ?? 0)} LINGO mintable`
                : 'Live from contract'
            }
            accent="#C4B5D4"
            loading={isLoading && totalSupply == null}
          />
          <BigStatCard
            label="Staked"
            value={summary.staked != null ? formatNumber(summary.staked) : '—'}
            sub={
              summary.staked != null && totalSupply != null
                ? `${pct(summary.staked, totalSupply)} of total supply • ${pct(summary.staked, MAX_SUPPLY)} of cap`
                : 'Held by the staking contract'
            }
            accent="#7B68AE"
            loading={isLoading && summary.staked == null}
          />
          <BigStatCard
            label="Circulating Supply"
            value={summary.circ != null ? formatNumber(summary.circ) : '—'}
            sub={
              summary.circ != null && totalSupply != null
                ? `${pct(summary.circ, totalSupply)} of total supply • ${pct(summary.circ, MAX_SUPPLY)} of cap`
                : 'Total Supply − non-circulating wallets'
            }
            accent="#5EB851"
            loading={isLoading && summary.circ == null}
          />
        </section>

        {/* Staked vs Total Supply — explicit horizontal comparison bar */}
        {totalSupply != null && totalSupply > 0 && summary.staked != null && (
          <section className="mb-8">
            <div className="flagship-card p-6 relative z-10">
              <div className="flex items-baseline justify-between flex-wrap gap-2 mb-3">
                <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest">
                  Staked vs Total Supply
                </h2>
                <div className="text-sm">
                  <span className="text-purple font-bold">{formatNumber(summary.staked)}</span>
                  <span className="text-soft-gray mx-1">/</span>
                  <span className="text-lavender font-semibold">{formatNumber(totalSupply)}</span>
                  <span className="text-soft-gray ml-2">
                    ({pct(summary.staked, totalSupply)} of total supply staked)
                  </span>
                </div>
              </div>
              <div className="h-6 rounded-full overflow-hidden bg-dark3 border border-white/[0.04]">
                <div
                  className="h-full bg-gradient-to-r from-purple to-purple/70 flex items-center justify-end px-3"
                  style={{ width: `${(summary.staked / totalSupply) * 100}%` }}
                >
                  <span className="text-[10px] font-semibold text-white whitespace-nowrap">
                    {pct(summary.staked, totalSupply)}
                  </span>
                </div>
              </div>
              <div className="flex items-center justify-between text-[11px] text-soft-gray mt-2">
                <span>0</span>
                <span className="inline-flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-sm bg-purple" /> Staked LINGO
                </span>
                <span>{formatNumber(totalSupply)} (Total Supply)</span>
              </div>
            </div>
          </section>
        )}

        {/* Breakdown bar */}
        {totalSupply != null && totalSupply > 0 && (
          <section className="mb-8">
            <div className="flagship-card p-6 relative z-10">
              <h2 className="text-sm font-semibold text-soft-gray uppercase tracking-widest mb-4">
                Supply Composition
              </h2>
              <SupplyBreakdownBar
                totalSupply={totalSupply}
                walletSegments={wallets.map((w, i) => ({
                  name: w.name,
                  balance: w.balance ?? 0,
                  color: WALLET_COLORS[i % WALLET_COLORS.length],
                }))}
              />
            </div>
          </section>
        )}

        {/* Non-circulating breakdown */}
        <section className="mb-8">
          <div className="flagship-card rounded-2xl">
            <div className="p-6 border-b border-white/5 relative z-10 flex items-baseline justify-between flex-wrap gap-3">
              <div>
                <h2 className="text-lg font-semibold text-lavender">Non-Circulating Wallets</h2>
                <p className="text-sm text-soft-gray mt-1">
                  Known wallets excluded from circulating supply
                </p>
              </div>
              <div className="text-xs text-purple-gray">
                Total locked: <span className="text-lavender font-semibold">{formatNumber(summary.nonCirc)}</span> LINGO
                {totalSupply != null && (
                  <span className="text-purple-gray"> ({pct(summary.nonCirc, totalSupply)} of total supply)</span>
                )}
              </div>
            </div>

            <div className="relative z-10 overflow-x-auto">
              <table className="w-full min-w-[640px]">
                <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                  <tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                      Wallet
                    </th>
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                      Address
                    </th>
                    <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">
                      Balance (LINGO)
                    </th>
                    <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6">
                      % of Total Supply
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {isLoading && wallets.length === 0 ? (
                    [...Array(5)].map((_, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-3 px-6"><div className="skeleton h-5 w-32 rounded" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-28 rounded" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-24 rounded ml-auto" /></td>
                        <td className="py-3 px-6"><div className="skeleton h-5 w-16 rounded ml-auto" /></td>
                      </tr>
                    ))
                  ) : wallets.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-12 text-center text-soft-gray text-sm">
                        No wallet data available
                      </td>
                    </tr>
                  ) : (
                    [...wallets]
                      .sort((a, b) => (b.balance ?? 0) - (a.balance ?? 0))
                      .map((w, i) => {
                        const balance = w.balance ?? 0;
                        const color = WALLET_COLORS[wallets.findIndex(x => x.address === w.address) % WALLET_COLORS.length];
                        return (
                          <tr key={w.address + i} className="border-b border-white/5 hover:bg-white/[0.02] transition-colors group">
                            <td className="py-3 px-6">
                              <div className="flex items-center gap-2.5">
                                <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
                                <div>
                                  <div className="text-sm text-lavender font-medium">{w.name}</div>
                                  {w.note && (
                                    <div className="text-[10px] text-purple-gray italic">{w.note}</div>
                                  )}
                                </div>
                              </div>
                            </td>
                            <td className="py-3 px-4">
                              <a
                                href={`https://basescan.org/address/${w.address}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex items-center gap-1.5 font-mono text-xs text-lavender/70 hover:text-lavender transition-colors"
                              >
                                {truncateAddress(w.address)}
                                <ExternalLink className="w-3 h-3 text-white/20 group-hover:text-purple transition-colors" />
                              </a>
                            </td>
                            <td className="py-3 px-4 text-right font-semibold text-lavender">
                              {w.balance == null ? '—' : formatNumber(balance)}
                            </td>
                            <td className="py-3 px-6 text-right text-soft-gray text-sm">
                              {totalSupply != null && w.balance != null
                                ? pct(balance, totalSupply)
                                : '—'}
                            </td>
                          </tr>
                        );
                      })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>

        <p className="text-[11px] text-purple-gray text-center mb-4">
          Balances are read live from the LINGO contract on Base via Alchemy &middot; cached 5 min
        </p>
      </main>
    </div>
  );
}
