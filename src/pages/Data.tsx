import { useState, useEffect, useMemo } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from 'recharts';
import { Lock, LogOut, DollarSign } from 'lucide-react';
import { formatCurrency } from '../utils/formatters';
import {
  useDuneQuery, DUNE_QUERIES, type BuyPressureRow, type CardsBuyPressureRow,
} from '../hooks/useDuneQuery';
import lingoLogo from '../assets/logo-lingo.svg';

const SESSION_KEY = 'admin_password';
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

const ASSUMPTION_PCTS = [10, 20, 30, 40] as const;

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[parseInt(m) - 1]} '${y.slice(2)}`;
}

// ─── Main ───────────────────────────────────────────────────────────

export function Data() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(SESSION_KEY) || '');
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loginError, setLoginError] = useState('');
  const [loggingIn, setLoggingIn] = useState(false);

  // Auto-login if session has a stored password — verify it
  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) {
      fetch(`${API_BASE}/api/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': stored },
      }).then(res => {
        if (res.ok) setIsAuthenticated(true);
        else sessionStorage.removeItem(SESSION_KEY);
      }).catch(() => setIsAuthenticated(true));
    }
  }, []);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password.trim()) return;
    setLoggingIn(true);
    setLoginError('');
    try {
      const res = await fetch(`${API_BASE}/api/verify-password`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password.trim() },
      });
      if (res.ok) {
        sessionStorage.setItem(SESSION_KEY, password.trim());
        setIsAuthenticated(true);
      } else {
        setLoginError('Wrong password');
      }
    } catch {
      setLoginError('Network error');
    }
    setLoggingIn(false);
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
            <input type="password" value={password} onChange={e => { setPassword(e.target.value); setLoginError(''); }} placeholder="Password"
              className={`w-full bg-white/[0.04] border rounded-xl px-4 py-3 text-sm text-lavender placeholder-soft-gray/50 focus:outline-none ${loginError ? 'border-red-400/50' : 'border-white/[0.08] focus:border-purple/50'}`} autoFocus />
            {loginError && <p className="text-xs text-red-400">{loginError}</p>}
            <button type="submit" disabled={loggingIn} className="w-full bg-purple/20 hover:bg-purple/30 text-lavender font-medium py-3 rounded-xl transition-colors border border-purple/30 disabled:opacity-50">
              <div className="flex items-center justify-center gap-2"><Lock className="w-4 h-4" />{loggingIn ? 'Verifying...' : 'Sign In'}</div>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <DataDashboard onLogout={handleLogout} />;
}

// ─── Dashboard ──────────────────────────────────────────────────────

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function DataDashboard({ onLogout }: { onLogout: () => void }) {
  const { data: buyPressureData, isLoading } = useDuneQuery<BuyPressureRow>(DUNE_QUERIES.BUY_PRESSURE);
  const { data: cardsPressureData, isLoading: cardsLoading } = useDuneQuery<CardsBuyPressureRow>(DUNE_QUERIES.CARDS_BUY_PRESSURE);
  const { data: funPressureData, isLoading: funLoading } = useDuneQuery<CardsBuyPressureRow>(DUNE_QUERIES.FUN_BUY_PRESSURE);
  const { data: penguPressureData, isLoading: penguLoading } = useDuneQuery<CardsBuyPressureRow>(DUNE_QUERIES.PENGU_BUY_PRESSURE);

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

  // Cards project data
  const cardsMonthly = useMemo(() => {
    if (!cardsPressureData) return [];
    return [...cardsPressureData]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(r => {
        const m = r.month.split('T')[0].slice(0, 7);
        return {
          month: m,
          label: monthLabel(m),
          buyVolume: r.buy_volume_usd,
          sellVolume: r.sell_volume_usd,
          netPressure: r.net_pressure_usd,
          totalVolume: r.total_volume_usd,
          buyPct: r.buy_pct,
          sellPct: r.sell_pct,
          indicator: r.pressure_indicator,
          avgPrice: r.avg_price,
        };
      });
  }, [cardsPressureData]);

  const cardsTotals = useMemo(() => {
    const totalBuy = cardsMonthly.reduce((s, m) => s + m.buyVolume, 0);
    return {
      totalBuy,
      totalSell: cardsMonthly.reduce((s, m) => s + m.sellVolume, 0),
      totalNet: cardsMonthly.reduce((s, m) => s + m.netPressure, 0),
      assumptions: ASSUMPTION_PCTS.map(pct => ({ pct, revenue: totalBuy * (pct / 100) })),
    };
  }, [cardsMonthly]);

  // Chart data for Cards buy/sell/net
  const cardsChartData = useMemo(() =>
    cardsMonthly.map(m => ({
      label: m.label,
      buy: Math.round(m.buyVolume),
      sell: Math.round(-m.sellVolume), // negative for visual
      net: Math.round(m.netPressure),
    })),
  [cardsMonthly]);

  // Fun project data
  const funMonthly = useMemo(() => {
    if (!funPressureData) return [];
    return [...funPressureData]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(r => {
        const m = r.month.split('T')[0].slice(0, 7);
        return {
          month: m, label: monthLabel(m),
          buyVolume: r.buy_volume_usd, sellVolume: r.sell_volume_usd,
          netPressure: r.net_pressure_usd, totalVolume: r.total_volume_usd,
          buyPct: r.buy_pct, sellPct: r.sell_pct,
          indicator: r.pressure_indicator, avgPrice: r.avg_price,
        };
      });
  }, [funPressureData]);

  const funTotals = useMemo(() => {
    const totalBuy = funMonthly.reduce((s, m) => s + m.buyVolume, 0);
    return {
      totalBuy,
      totalSell: funMonthly.reduce((s, m) => s + m.sellVolume, 0),
      totalNet: funMonthly.reduce((s, m) => s + m.netPressure, 0),
      assumptions: ASSUMPTION_PCTS.map(pct => ({ pct, revenue: totalBuy * (pct / 100) })),
    };
  }, [funMonthly]);

  const funChartData = useMemo(() =>
    funMonthly.map(m => ({
      label: m.label, buy: Math.round(m.buyVolume),
      sell: Math.round(-m.sellVolume), net: Math.round(m.netPressure),
    })),
  [funMonthly]);

  // Pengu project data
  const penguMonthly = useMemo(() => {
    if (!penguPressureData) return [];
    return [...penguPressureData]
      .sort((a, b) => a.month.localeCompare(b.month))
      .map(r => {
        const m = r.month.split('T')[0].slice(0, 7);
        return {
          month: m, label: monthLabel(m),
          buyVolume: r.buy_volume_usd, sellVolume: r.sell_volume_usd,
          netPressure: r.net_pressure_usd, totalVolume: r.total_volume_usd,
          buyPct: r.buy_pct, sellPct: r.sell_pct,
          indicator: r.pressure_indicator, avgPrice: r.avg_price,
        };
      });
  }, [penguPressureData]);

  const penguTotals = useMemo(() => {
    const totalBuy = penguMonthly.reduce((s, m) => s + m.buyVolume, 0);
    return {
      totalBuy,
      totalSell: penguMonthly.reduce((s, m) => s + m.sellVolume, 0),
      totalNet: penguMonthly.reduce((s, m) => s + m.netPressure, 0),
      assumptions: ASSUMPTION_PCTS.map(pct => ({ pct, revenue: totalBuy * (pct / 100) })),
    };
  }, [penguMonthly]);

  const penguChartData = useMemo(() =>
    penguMonthly.map(m => ({
      label: m.label, buy: Math.round(m.buyVolume),
      sell: Math.round(-m.sellVolume), net: Math.round(m.netPressure),
    })),
  [penguMonthly]);

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
        {/* ═══ Cards Dashboard ═══ */}
        <div className="border-t border-white/5 pt-8 mt-4">
          <h2 className="text-xl font-bold text-lavender mb-6">Cards Dashboard</h2>

          {/* Cards KPI cards */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <div className="flagship-card rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-2 relative z-10">
                <DollarSign className="w-4 h-4 text-purple-gray" />
                <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Total Buy Volume</span>
              </div>
              <p className="text-xl font-bold text-green1 relative z-10">{formatCurrency(cardsTotals.totalBuy)}</p>
            </div>
            {cardsTotals.assumptions.map(({ pct, revenue }) => (
              <div key={pct} className="flagship-card rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-2 relative z-10">
                  <DollarSign className="w-4 h-4 text-purple-gray" />
                  <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Capture {pct}%</span>
                </div>
                <p className="text-xl font-bold text-lavender relative z-10">{formatCurrency(revenue)}</p>
              </div>
            ))}
          </div>

          {/* Cards Buy/Sell/Net Pressure Chart */}
          <div className="flagship-card rounded-2xl p-6 mb-6">
            <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Buy & Sell Pressure</h3>
            <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly trading volume breakdown</p>
            <div className="relative z-10" style={{ height: 320 }}>
              {cardsChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-soft-gray text-sm">{cardsLoading ? 'Loading...' : 'No data'}</div>
              ) : (
                <ResponsiveContainer minWidth={0} width="100%" height={320}>
                  <BarChart data={cardsChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                    <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                    <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="custom-tooltip">
                          <p className="text-soft-gray text-xs mb-2">{label}</p>
                          {payload.map((e, i) => (
                            <div key={i} className="flex items-center gap-2 mb-1">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                              <span className="text-soft-gray text-sm">{e.name}:</span>
                              <span className="text-lavender font-medium">{formatCurrency(Math.abs(e.value as number))}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }} />
                    <Legend wrapperStyle={{ paddingTop: 10 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                    <Bar dataKey="buy" name="Buy Volume" fill="#5EB851" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="sell" name="Sell Volume" fill="#E85757" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="net" name="Net Pressure">
                      {cardsChartData.map((entry, i) => (
                        <Cell key={i} fill={entry.net >= 0 ? '#7B68AE' : '#FF7847'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* Cards Assumptions Table */}
          <div className="flagship-card rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-lavender mb-2 relative z-10">Cards Revenue Assumptions</h3>
            <p className="text-sm text-soft-gray mb-6 relative z-10">
              If the project captured a percentage of the incoming buy volume as revenue, how much would each month generate?
            </p>
            <div className="overflow-x-auto relative z-10">
              <table className="w-full text-sm">
                <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                  <tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 sticky left-0 bg-[#14141f]">Month</th>
                    <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4">Buy Volume</th>
                    <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4">Sell Volume</th>
                    <th className="text-right text-xs font-medium text-purple/80 uppercase tracking-wider py-3 px-4">Net Pressure</th>
                    <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Indicator</th>
                    {ASSUMPTION_PCTS.map(pct => (
                      <th key={pct} className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">
                        {pct}% Capture
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {cardsLoading ? (
                    [...Array(5)].map((_, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded mx-auto" /></td>
                        {ASSUMPTION_PCTS.map(pct => (
                          <td key={pct} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        ))}
                      </tr>
                    ))
                  ) : (
                    [...cardsMonthly].reverse().map(m => (
                      <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-3 px-4 text-lavender font-medium sticky left-0 bg-[#14141f]">{m.label}</td>
                        <td className="py-3 px-4 text-right text-green1">{formatCurrency(m.buyVolume)}</td>
                        <td className="py-3 px-4 text-right text-red-400">{formatCurrency(m.sellVolume)}</td>
                        <td className={`py-3 px-4 text-right ${m.netPressure >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(m.netPressure)}</td>
                        <td className="py-3 px-4 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-md ${
                            m.indicator.includes('Buy') ? 'bg-green1/10 text-green1' : 'bg-red-400/10 text-red-400'
                          }`}>{m.indicator}</span>
                        </td>
                        {ASSUMPTION_PCTS.map(pct => (
                          <td key={pct} className="py-3 px-4 text-right text-lavender border-l border-white/5">
                            {formatCurrency(m.buyVolume * (pct / 100))}
                          </td>
                        ))}
                      </tr>
                    ))
                  )}
                  {cardsMonthly.length > 0 && (
                    <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                      <td className="py-3 px-4 text-lavender font-bold sticky left-0 bg-[#1a1a2e]">Total</td>
                      <td className="py-3 px-4 text-right text-green1 font-bold">{formatCurrency(cardsTotals.totalBuy)}</td>
                      <td className="py-3 px-4 text-right text-red-400 font-bold">{formatCurrency(cardsTotals.totalSell)}</td>
                      <td className={`py-3 px-4 text-right font-bold ${cardsTotals.totalNet >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(cardsTotals.totalNet)}</td>
                      <td></td>
                      {ASSUMPTION_PCTS.map(pct => (
                        <td key={pct} className="py-3 px-4 text-right text-lavender font-bold border-l border-white/5">
                          {formatCurrency(cardsTotals.totalBuy * (pct / 100))}
                        </td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ═══ Fun Dashboard ═══ */}
        <div className="border-t border-white/5 pt-8 mt-4">
          <h2 className="text-xl font-bold text-lavender mb-6">Fun Dashboard</h2>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <div className="flagship-card rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-2 relative z-10">
                <DollarSign className="w-4 h-4 text-purple-gray" />
                <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Total Buy Volume</span>
              </div>
              <p className="text-xl font-bold text-green1 relative z-10">{formatCurrency(funTotals.totalBuy)}</p>
            </div>
            {funTotals.assumptions.map(({ pct, revenue }) => (
              <div key={pct} className="flagship-card rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-2 relative z-10">
                  <DollarSign className="w-4 h-4 text-purple-gray" />
                  <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Capture {pct}%</span>
                </div>
                <p className="text-xl font-bold text-lavender relative z-10">{formatCurrency(revenue)}</p>
              </div>
            ))}
          </div>

          <div className="flagship-card rounded-2xl p-6 mb-6">
            <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Buy & Sell Pressure</h3>
            <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly trading volume breakdown</p>
            <div className="relative z-10" style={{ height: 320 }}>
              {funChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-soft-gray text-sm">{funLoading ? 'Loading...' : 'No data'}</div>
              ) : (
                <ResponsiveContainer minWidth={0} width="100%" height={320}>
                  <BarChart data={funChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                    <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                    <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="custom-tooltip">
                          <p className="text-soft-gray text-xs mb-2">{label}</p>
                          {payload.map((e, i) => (
                            <div key={i} className="flex items-center gap-2 mb-1">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                              <span className="text-soft-gray text-sm">{e.name}:</span>
                              <span className="text-lavender font-medium">{formatCurrency(Math.abs(e.value as number))}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }} />
                    <Legend wrapperStyle={{ paddingTop: 10 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                    <Bar dataKey="buy" name="Buy Volume" fill="#5EB851" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="sell" name="Sell Volume" fill="#E85757" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="net" name="Net Pressure">
                      {funChartData.map((entry, i) => (
                        <Cell key={i} fill={entry.net >= 0 ? '#7B68AE' : '#FF7847'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="flagship-card rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-lavender mb-2 relative z-10">Fun Revenue Assumptions</h3>
            <p className="text-sm text-soft-gray mb-6 relative z-10">
              If the project captured a percentage of the incoming buy volume as revenue, how much would each month generate?
            </p>
            <div className="overflow-x-auto relative z-10">
              <table className="w-full text-sm">
                <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                  <tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 sticky left-0 bg-[#14141f]">Month</th>
                    <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4">Buy Volume</th>
                    <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4">Sell Volume</th>
                    <th className="text-right text-xs font-medium text-purple/80 uppercase tracking-wider py-3 px-4">Net Pressure</th>
                    <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Indicator</th>
                    {ASSUMPTION_PCTS.map(pct => (
                      <th key={pct} className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">{pct}% Capture</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {funLoading ? (
                    [...Array(4)].map((_, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded mx-auto" /></td>
                        {ASSUMPTION_PCTS.map(pct => (<td key={pct} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>))}
                      </tr>
                    ))
                  ) : (
                    [...funMonthly].reverse().map(m => (
                      <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-3 px-4 text-lavender font-medium sticky left-0 bg-[#14141f]">{m.label}</td>
                        <td className="py-3 px-4 text-right text-green1">{formatCurrency(m.buyVolume)}</td>
                        <td className="py-3 px-4 text-right text-red-400">{formatCurrency(m.sellVolume)}</td>
                        <td className={`py-3 px-4 text-right ${m.netPressure >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(m.netPressure)}</td>
                        <td className="py-3 px-4 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-md ${m.indicator.includes('Buy') ? 'bg-green1/10 text-green1' : 'bg-red-400/10 text-red-400'}`}>{m.indicator}</span>
                        </td>
                        {ASSUMPTION_PCTS.map(pct => (
                          <td key={pct} className="py-3 px-4 text-right text-lavender border-l border-white/5">{formatCurrency(m.buyVolume * (pct / 100))}</td>
                        ))}
                      </tr>
                    ))
                  )}
                  {funMonthly.length > 0 && (
                    <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                      <td className="py-3 px-4 text-lavender font-bold sticky left-0 bg-[#1a1a2e]">Total</td>
                      <td className="py-3 px-4 text-right text-green1 font-bold">{formatCurrency(funTotals.totalBuy)}</td>
                      <td className="py-3 px-4 text-right text-red-400 font-bold">{formatCurrency(funTotals.totalSell)}</td>
                      <td className={`py-3 px-4 text-right font-bold ${funTotals.totalNet >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(funTotals.totalNet)}</td>
                      <td></td>
                      {ASSUMPTION_PCTS.map(pct => (
                        <td key={pct} className="py-3 px-4 text-right text-lavender font-bold border-l border-white/5">{formatCurrency(funTotals.totalBuy * (pct / 100))}</td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* ═══ Pengu Dashboard ═══ */}
        <div className="border-t border-white/5 pt-8 mt-4">
          <h2 className="text-xl font-bold text-lavender mb-6">Pengu Dashboard</h2>

          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
            <div className="flagship-card rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-2 relative z-10">
                <DollarSign className="w-4 h-4 text-purple-gray" />
                <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Total Buy Volume</span>
              </div>
              <p className="text-xl font-bold text-green1 relative z-10">{formatCurrency(penguTotals.totalBuy)}</p>
            </div>
            {penguTotals.assumptions.map(({ pct, revenue }) => (
              <div key={pct} className="flagship-card rounded-2xl p-5">
                <div className="flex items-center gap-2 mb-2 relative z-10">
                  <DollarSign className="w-4 h-4 text-purple-gray" />
                  <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">Capture {pct}%</span>
                </div>
                <p className="text-xl font-bold text-lavender relative z-10">{formatCurrency(revenue)}</p>
              </div>
            ))}
          </div>

          <div className="flagship-card rounded-2xl p-6 mb-6">
            <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Buy & Sell Pressure</h3>
            <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly trading volume breakdown</p>
            <div className="relative z-10" style={{ height: 320 }}>
              {penguChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-soft-gray text-sm">{penguLoading ? 'Loading...' : 'No data'}</div>
              ) : (
                <ResponsiveContainer minWidth={0} width="100%" height={320}>
                  <BarChart data={penguChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="20%">
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                    <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                    <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={70} />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="custom-tooltip">
                          <p className="text-soft-gray text-xs mb-2">{label}</p>
                          {payload.map((e, i) => (
                            <div key={i} className="flex items-center gap-2 mb-1">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                              <span className="text-soft-gray text-sm">{e.name}:</span>
                              <span className="text-lavender font-medium">{formatCurrency(Math.abs(e.value as number))}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }} />
                    <Legend wrapperStyle={{ paddingTop: 10 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                    <Bar dataKey="buy" name="Buy Volume" fill="#5EB851" radius={[4, 4, 0, 0]} />
                    <Bar dataKey="sell" name="Sell Volume" fill="#E85757" radius={[0, 0, 4, 4]} />
                    <Bar dataKey="net" name="Net Pressure">
                      {penguChartData.map((entry, i) => (
                        <Cell key={i} fill={entry.net >= 0 ? '#7B68AE' : '#FF7847'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          <div className="flagship-card rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-lavender mb-2 relative z-10">Pengu Revenue Assumptions</h3>
            <p className="text-sm text-soft-gray mb-6 relative z-10">
              If the project captured a percentage of the incoming buy volume as revenue, how much would each month generate?
            </p>
            <div className="overflow-x-auto relative z-10">
              <table className="w-full text-sm">
                <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                  <tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 sticky left-0 bg-[#14141f]">Month</th>
                    <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4">Buy Volume</th>
                    <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4">Sell Volume</th>
                    <th className="text-right text-xs font-medium text-purple/80 uppercase tracking-wider py-3 px-4">Net Pressure</th>
                    <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Indicator</th>
                    {ASSUMPTION_PCTS.map(pct => (
                      <th key={pct} className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">{pct}% Capture</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {penguLoading ? (
                    [...Array(4)].map((_, i) => (
                      <tr key={i} className="border-b border-white/5">
                        <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>
                        <td className="py-3 px-4"><div className="skeleton h-5 w-16 rounded mx-auto" /></td>
                        {ASSUMPTION_PCTS.map(pct => (<td key={pct} className="py-3 px-4"><div className="skeleton h-5 w-20 rounded ml-auto" /></td>))}
                      </tr>
                    ))
                  ) : (
                    [...penguMonthly].reverse().map(m => (
                      <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-3 px-4 text-lavender font-medium sticky left-0 bg-[#14141f]">{m.label}</td>
                        <td className="py-3 px-4 text-right text-green1">{formatCurrency(m.buyVolume)}</td>
                        <td className="py-3 px-4 text-right text-red-400">{formatCurrency(m.sellVolume)}</td>
                        <td className={`py-3 px-4 text-right ${m.netPressure >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(m.netPressure)}</td>
                        <td className="py-3 px-4 text-center">
                          <span className={`text-xs px-2 py-0.5 rounded-md ${m.indicator.includes('Buy') ? 'bg-green1/10 text-green1' : 'bg-red-400/10 text-red-400'}`}>{m.indicator}</span>
                        </td>
                        {ASSUMPTION_PCTS.map(pct => (
                          <td key={pct} className="py-3 px-4 text-right text-lavender border-l border-white/5">{formatCurrency(m.buyVolume * (pct / 100))}</td>
                        ))}
                      </tr>
                    ))
                  )}
                  {penguMonthly.length > 0 && (
                    <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                      <td className="py-3 px-4 text-lavender font-bold sticky left-0 bg-[#1a1a2e]">Total</td>
                      <td className="py-3 px-4 text-right text-green1 font-bold">{formatCurrency(penguTotals.totalBuy)}</td>
                      <td className="py-3 px-4 text-right text-red-400 font-bold">{formatCurrency(penguTotals.totalSell)}</td>
                      <td className={`py-3 px-4 text-right font-bold ${penguTotals.totalNet >= 0 ? 'text-purple' : 'text-red-400'}`}>{formatCurrency(penguTotals.totalNet)}</td>
                      <td></td>
                      {ASSUMPTION_PCTS.map(pct => (
                        <td key={pct} className="py-3 px-4 text-right text-lavender font-bold border-l border-white/5">{formatCurrency(penguTotals.totalBuy * (pct / 100))}</td>
                      ))}
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
