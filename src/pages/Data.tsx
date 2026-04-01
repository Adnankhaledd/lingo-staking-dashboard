import { useState, useMemo } from 'react';
import { Lock, LogOut, DollarSign } from 'lucide-react';
import { formatCurrency } from '../utils/formatters';
import {
  useDuneQuery, DUNE_QUERIES, type BuyPressureRow,
} from '../hooks/useDuneQuery';
import lingoLogo from '../assets/logo-lingo.svg';

const SESSION_KEY = 'admin_password';

const ASSUMPTION_PCTS = [10, 20, 30, 40] as const;

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[parseInt(m) - 1]} '${y.slice(2)}`;
}

// ─── Main ───────────────────────────────────────────────────────────

export function Data() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(SESSION_KEY) || '');
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!sessionStorage.getItem(SESSION_KEY));

  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (password.trim()) {
      sessionStorage.setItem(SESSION_KEY, password.trim());
      setIsAuthenticated(true);
    }
  };

  const handleLogout = () => {
    sessionStorage.removeItem(SESSION_KEY);
    setPassword('');
    setIsAuthenticated(false);
  };

  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(180deg, #14141F 0%, #1A1A2E 50%, #14141F 100%)' }}>
        <div className="flagship-card rounded-2xl p-8 w-full max-w-sm relative z-10">
          <div className="flex items-center gap-3 mb-6">
            <img src={lingoLogo} alt="Lingo" className="h-6" />
            <div>
              <h1 className="text-lg font-semibold text-lavender">Data Room</h1>
              <p className="text-xs text-soft-gray">Enter password to continue</p>
            </div>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="Password"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-lavender placeholder-soft-gray/50 focus:outline-none focus:border-purple/50" autoFocus />
            <button type="submit" className="w-full bg-purple/20 hover:bg-purple/30 text-lavender font-medium py-3 rounded-xl transition-colors border border-purple/30">
              <div className="flex items-center justify-center gap-2"><Lock className="w-4 h-4" />Sign In</div>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <DataDashboard onLogout={handleLogout} />;
}

// ─── Dashboard ──────────────────────────────────────────────────────

function DataDashboard({ onLogout }: { onLogout: () => void }) {
  const { data: buyPressureData, isLoading } = useDuneQuery<BuyPressureRow>(DUNE_QUERIES.BUY_PRESSURE);

  // Aggregate weekly buy volume into monthly
  const monthlyBuyVolume = useMemo(() => {
    if (!buyPressureData) return [];

    const map = new Map<string, { buyVolume: number; sellVolume: number; netBuy: number }>();

    for (const row of buyPressureData) {
      const dateStr = row.week?.split('T')[0] || row.week?.split(' ')[0] || '';
      const m = dateStr.slice(0, 7);
      if (!m) continue;

      const existing = map.get(m) ?? { buyVolume: 0, sellVolume: 0, netBuy: 0 };
      existing.buyVolume += row.buy_volume_usd ?? 0;
      existing.sellVolume += row.sell_volume_usd ?? 0;
      existing.netBuy += row.net_buy_pressure ?? 0;
      map.set(m, existing);
    }

    return Array.from(map.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([month, data]) => ({
        month,
        label: monthLabel(month),
        buyVolume: data.buyVolume,
        sellVolume: data.sellVolume,
        netBuy: data.netBuy,
      }));
  }, [buyPressureData]);

  // Totals
  const totals = useMemo(() => {
    const totalBuy = monthlyBuyVolume.reduce((s, m) => s + m.buyVolume, 0);
    return {
      totalBuy,
      assumptions: ASSUMPTION_PCTS.map(pct => ({ pct, revenue: totalBuy * (pct / 100) })),
    };
  }, [monthlyBuyVolume]);

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #14141F 0%, #1A1A2E 50%, #14141F 100%)' }}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5" style={{ background: 'rgba(20, 20, 31, 0.92)', backdropFilter: 'blur(20px)' }}>
        <div className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={lingoLogo} alt="Lingo" className="h-7" />
              <div>
                <h1 className="text-lg font-semibold text-lavender tracking-tight">Data</h1>
                <p className="text-[11px] text-soft-gray uppercase tracking-wider">Revenue Assumptions</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a href="/" className="text-xs text-soft-gray hover:text-lavender px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">Dashboard</a>
              <a href="/pnl" className="text-xs text-soft-gray hover:text-lavender px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">P&L</a>
              <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-soft-gray hover:text-red-400 px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">
                <LogOut className="w-3.5 h-3.5" />Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* Summary KPI cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <div className="flagship-card rounded-2xl p-5">
            <div className="flex items-center gap-2 mb-2 relative z-10">
              <DollarSign className="w-4 h-4 text-purple-gray" />
              <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Total Buy Volume</span>
            </div>
            <p className="text-xl font-bold text-green1 relative z-10">{formatCurrency(totals.totalBuy)}</p>
          </div>
          {totals.assumptions.map(({ pct, revenue }) => (
            <div key={pct} className="flagship-card rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-2 relative z-10">
                <DollarSign className="w-4 h-4 text-purple-gray" />
                <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Sell {pct}%</span>
              </div>
              <p className="text-xl font-bold text-lavender relative z-10">{formatCurrency(revenue)}</p>
            </div>
          ))}
        </div>

        {/* Assumptions explanation */}
        <div className="flagship-card rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-lavender mb-2 relative z-10">Buy Volume Revenue Assumptions</h3>
          <p className="text-sm text-soft-gray mb-6 relative z-10">
            If the project captured a percentage of the incoming buy volume as revenue (e.g. via trading fees, spread, or market making), how much would each month generate?
          </p>

          {/* Table */}
          <div className="overflow-x-auto relative z-10">
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                <tr className="border-b border-white/5">
                  <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 sticky left-0 bg-[#14141f]">Month</th>
                  <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4">Buy Volume</th>
                  <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4">Sell Volume</th>
                  <th className="text-right text-xs font-medium text-purple/80 uppercase tracking-wider py-3 px-4">Net Buy</th>
                  {ASSUMPTION_PCTS.map(pct => (
                    <th key={pct} className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">
                      {pct}% Capture
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  [...Array(6)].map((_, i) => (
                    <tr key={i} className="border-b border-white/5">
                      <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded" /></td>
                      <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                      <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                      <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                      {ASSUMPTION_PCTS.map(pct => (
                        <td key={pct} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                      ))}
                    </tr>
                  ))
                ) : (
                  [...monthlyBuyVolume].reverse().map(m => (
                    <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="py-3 px-4 text-lavender font-medium sticky left-0 bg-[#14141f]">{m.label}</td>
                      <td className="py-3 px-4 text-right text-green1">{formatCurrency(m.buyVolume)}</td>
                      <td className="py-3 px-4 text-right text-red-400">{formatCurrency(m.sellVolume)}</td>
                      <td className={`py-3 px-4 text-right ${m.netBuy >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(m.netBuy)}</td>
                      {ASSUMPTION_PCTS.map(pct => (
                        <td key={pct} className="py-3 px-4 text-right text-lavender border-l border-white/5">
                          {formatCurrency(m.buyVolume * (pct / 100))}
                        </td>
                      ))}
                    </tr>
                  ))
                )}
                {/* Totals */}
                {monthlyBuyVolume.length > 0 && (
                  <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                    <td className="py-3 px-4 text-lavender font-bold sticky left-0 bg-[#1a1a2e]">Total</td>
                    <td className="py-3 px-4 text-right text-green1 font-bold">
                      {formatCurrency(monthlyBuyVolume.reduce((s, m) => s + m.buyVolume, 0))}
                    </td>
                    <td className="py-3 px-4 text-right text-red-400 font-bold">
                      {formatCurrency(monthlyBuyVolume.reduce((s, m) => s + m.sellVolume, 0))}
                    </td>
                    <td className="py-3 px-4 text-right text-purple font-bold">
                      {formatCurrency(monthlyBuyVolume.reduce((s, m) => s + m.netBuy, 0))}
                    </td>
                    {ASSUMPTION_PCTS.map(pct => (
                      <td key={pct} className="py-3 px-4 text-right text-lavender font-bold border-l border-white/5">
                        {formatCurrency(totals.totalBuy * (pct / 100))}
                      </td>
                    ))}
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
