import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell,
} from 'recharts';
import {
  Lock, DollarSign, TrendingUp, TrendingDown, Minus,
  Plus, Save, Trash2, RefreshCw, LogOut,
} from 'lucide-react';
import { formatCurrency } from '../utils/formatters';
import {
  useDuneQuery, DUNE_QUERIES,
  type TradingFeesRow, type LPFeesRow,
  type APYClaimsRow, type CommunityRewardsRow,
} from '../hooks/useDuneQuery';
import lingoLogo from '../assets/logo-lingo.svg';

// ─── Constants ──────────────────────────────────────────────────────

const SESSION_KEY = 'admin_password';
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

const EXPENSE_CATEGORIES = [
  'Team Compensation',
  'Infrastructure',
  'Marketing & Partnerships',
  'Gas Costs',
  'Legal & Compliance',
  'Other OpEx',
] as const;

type ExpenseCategory = typeof EXPENSE_CATEGORIES[number];

interface ExpenseEntry {
  month: string;
  category: string;
  amount: number;
  note?: string;
}

interface MonthlyRecord {
  month: string;
  label: string;
  tradingFees: number;
  lpFees: number;
  apyClaims: number;
  communityRewards: number;
  totalRevenue: number;
  expenses: Record<string, number>;
  totalExpenses: number;
  netPnL: number;
}

const EXPENSE_COLORS: Record<string, string> = {
  'Team Compensation': '#E85757',
  'Infrastructure': '#FF7847',
  'Marketing & Partnerships': '#E8B100',
  'Gas Costs': '#8B5CF6',
  'Legal & Compliance': '#3B82F6',
  'Other OpEx': '#9B8EC2',
};

const REVENUE_COLORS = {
  tradingFees: '#5EB851',
  lpFees: '#7B68AE',
  apyClaims: '#3B82F6',
  communityRewards: '#E8B100',
};

// ─── Helpers ────────────────────────────────────────────────────────

function parseDuneMonth(raw: string): string {
  if (!raw) return '';
  return raw.split('T')[0].slice(0, 7); // "2025-01"
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[parseInt(m) - 1]} '${y.slice(2)}`;
}

function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

// ─── Main Component ─────────────────────────────────────────────────

export function PnL() {
  // Auth
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

  // Login screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: 'linear-gradient(180deg, #14141F 0%, #1A1A2E 50%, #14141F 100%)' }}>
        <div className="flagship-card rounded-2xl p-8 w-full max-w-sm relative z-10">
          <div className="flex items-center gap-3 mb-6">
            <img src={lingoLogo} alt="Lingo" className="h-6" />
            <div>
              <h1 className="text-lg font-semibold text-lavender">P&L Dashboard</h1>
              <p className="text-xs text-soft-gray">Enter password to continue</p>
            </div>
          </div>
          <form onSubmit={handleLogin} className="space-y-4">
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="Password"
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-4 py-3 text-sm text-lavender placeholder-soft-gray/50 focus:outline-none focus:border-purple/50"
              autoFocus
            />
            <button
              type="submit"
              className="w-full bg-purple/20 hover:bg-purple/30 text-lavender font-medium py-3 rounded-xl transition-colors border border-purple/30"
            >
              <div className="flex items-center justify-center gap-2">
                <Lock className="w-4 h-4" />
                Sign In
              </div>
            </button>
          </form>
        </div>
      </div>
    );
  }

  return <PnLDashboard onLogout={handleLogout} />;
}

// ─── Dashboard (authenticated) ──────────────────────────────────────

function PnLDashboard({ onLogout }: { onLogout: () => void }) {
  // Revenue data from Dune
  const { data: tradingFees } = useDuneQuery<TradingFeesRow>(DUNE_QUERIES.TRADING_FEES);
  const { data: lpFees } = useDuneQuery<LPFeesRow>(DUNE_QUERIES.LP_FEES);
  const { data: apyClaims } = useDuneQuery<APYClaimsRow>(DUNE_QUERIES.APY_CLAIMS);
  const { data: communityRewards } = useDuneQuery<CommunityRewardsRow>(DUNE_QUERIES.COMMUNITY_REWARDS);

  // Expense data from blob
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
  const [expensesLoaded, setExpensesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Expense form state
  const [formMonth, setFormMonth] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  });
  const [formCategory, setFormCategory] = useState<ExpenseCategory>(EXPENSE_CATEGORIES[0]);
  const [formAmount, setFormAmount] = useState('');
  const [formNote, setFormNote] = useState('');

  // Fetch expenses
  const fetchExpenses = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/pnl-expenses`);
      if (res.ok) {
        const data = await res.json();
        setExpenses(data.expenses ?? []);
      }
    } catch { /* ignore */ }
    setExpensesLoaded(true);
  }, []);

  useEffect(() => { fetchExpenses(); }, [fetchExpenses]);

  // Save expenses
  const handleSave = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const pw = sessionStorage.getItem(SESSION_KEY) || '';
      const res = await fetch(`${API_BASE}/api/save-pnl-expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pw },
        body: JSON.stringify({ expenses }),
      });
      const data = await res.json();
      setSaveMsg(res.ok ? 'Saved!' : data.error || 'Failed');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch {
      setSaveMsg('Network error');
    }
    setSaving(false);
  };

  // Add/update expense entry
  const handleAddExpense = () => {
    const amount = parseFloat(formAmount);
    if (isNaN(amount) || amount <= 0) return;

    setExpenses(prev => {
      const filtered = prev.filter(e => !(e.month === formMonth && e.category === formCategory));
      return [...filtered, { month: formMonth, category: formCategory, amount, note: formNote || undefined }];
    });
    setFormAmount('');
    setFormNote('');
  };

  const handleDeleteExpense = (month: string, category: string) => {
    setExpenses(prev => prev.filter(e => !(e.month === month && e.category === category)));
  };

  // ─── Build monthly P&L records ────────────────────────────────────

  const monthlyData = useMemo<MonthlyRecord[]>(() => {
    const months = new Set<string>();
    const revenueMap = new Map<string, { tradingFees: number; lpFees: number; apyClaims: number; communityRewards: number }>();

    const ensure = (m: string) => {
      months.add(m);
      if (!revenueMap.has(m)) revenueMap.set(m, { tradingFees: 0, lpFees: 0, apyClaims: 0, communityRewards: 0 });
    };

    tradingFees?.forEach(r => { const m = parseDuneMonth(r.month); if (m) { ensure(m); revenueMap.get(m)!.tradingFees += r.usd_value ?? 0; } });
    lpFees?.forEach(r => { const m = parseDuneMonth(r.month); if (m) { ensure(m); revenueMap.get(m)!.lpFees += r.fees_usd ?? 0; } });
    apyClaims?.forEach(r => { const m = parseDuneMonth(r.month); if (m) { ensure(m); revenueMap.get(m)!.apyClaims += r.usd_value ?? 0; } });
    communityRewards?.forEach(r => {
      const dateStr = r.week?.split('T')[0] || r.week?.split(' ')[0] || '';
      const m = dateStr.slice(0, 7);
      if (m) { ensure(m); revenueMap.get(m)!.communityRewards += r.usd_value ?? 0; }
    });

    expenses.forEach(e => months.add(e.month));

    const expenseMap = new Map<string, Record<string, number>>();
    expenses.forEach(e => {
      if (!expenseMap.has(e.month)) expenseMap.set(e.month, {});
      expenseMap.get(e.month)![e.category] = e.amount;
    });

    return Array.from(months)
      .sort()
      .map(m => {
        const rev = revenueMap.get(m) ?? { tradingFees: 0, lpFees: 0, apyClaims: 0, communityRewards: 0 };
        const exp = expenseMap.get(m) ?? {};
        const totalRevenue = rev.tradingFees + rev.lpFees + rev.apyClaims + rev.communityRewards;
        const totalExpenses = Object.values(exp).reduce((s, v) => s + v, 0);
        return {
          month: m,
          label: monthLabel(m),
          ...rev,
          totalRevenue,
          expenses: exp,
          totalExpenses,
          netPnL: totalRevenue - totalExpenses,
        };
      });
  }, [tradingFees, lpFees, apyClaims, communityRewards, expenses]);

  // KPIs
  const kpis = useMemo(() => {
    const totalRev = monthlyData.reduce((s, m) => s + m.totalRevenue, 0);
    const totalExp = monthlyData.reduce((s, m) => s + m.totalExpenses, 0);
    const net = totalRev - totalExp;
    const current = monthlyData.length > 0 ? monthlyData[monthlyData.length - 1] : null;
    const margin = totalRev > 0 ? (net / totalRev) * 100 : 0;
    return { totalRev, totalExp, net, currentMonthRev: current?.totalRevenue ?? 0, margin };
  }, [monthlyData]);

  // Chart data for net P&L trend
  const netTrendData = useMemo(() =>
    monthlyData.map(m => ({ label: m.label, net: Math.round(m.netPnL) })),
  [monthlyData]);

  // Chart data for revenue breakdown
  const revenueChartData = useMemo(() =>
    monthlyData.map(m => ({
      label: m.label,
      tradingFees: Math.round(m.tradingFees),
      lpFees: Math.round(m.lpFees),
      apyClaims: Math.round(m.apyClaims),
      communityRewards: Math.round(m.communityRewards),
    })),
  [monthlyData]);

  // Chart data for expense breakdown
  const expenseChartData = useMemo(() =>
    monthlyData
      .filter(m => m.totalExpenses > 0)
      .map(m => ({
        label: m.label,
        ...Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c, m.expenses[c] ?? 0])),
      })),
  [monthlyData]);

  const isUp = kpis.net > 0;
  const isDown = kpis.net < 0;

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #14141F 0%, #1A1A2E 50%, #14141F 100%)' }}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5" style={{ background: 'rgba(20, 20, 31, 0.92)', backdropFilter: 'blur(20px)' }}>
        <div className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={lingoLogo} alt="Lingo" className="h-7" />
              <div>
                <h1 className="text-lg font-semibold text-lavender tracking-tight">P&L</h1>
                <p className="text-[11px] text-soft-gray uppercase tracking-wider">Profit & Loss</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <a href="/" className="text-xs text-soft-gray hover:text-lavender px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">Dashboard</a>
              <a href="/admin" className="text-xs text-soft-gray hover:text-lavender px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">Admin</a>
              <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-soft-gray hover:text-red-400 px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">
                <LogOut className="w-3.5 h-3.5" />
                Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <KPI icon={<DollarSign className="w-4 h-4" />} label="Total Revenue" value={formatCurrency(kpis.totalRev)} color="text-green1" />
          <KPI icon={<TrendingDown className="w-4 h-4" />} label="Total Expenses" value={formatCurrency(kpis.totalExp)} color="text-red-400" />
          <KPI
            icon={isUp ? <TrendingUp className="w-4 h-4" /> : isDown ? <TrendingDown className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
            label="Net P&L"
            value={formatCurrency(kpis.net)}
            color={isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-soft-gray'}
          />
          <KPI icon={<DollarSign className="w-4 h-4" />} label="Current Month Rev" value={formatCurrency(kpis.currentMonthRev)} />
          <KPI icon={<TrendingUp className="w-4 h-4" />} label="Gross Margin" value={`${kpis.margin.toFixed(1)}%`} color={kpis.margin >= 0 ? 'text-green1' : 'text-red-400'} />
        </div>

        {/* Net P&L Trend */}
        <div className="flagship-card rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Net P&L Trend</h3>
          <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly profit/loss over time</p>
          <div className="relative z-10" style={{ height: 320 }}>
            <ResponsiveContainer minWidth={0} width="100%" height={320}>
              <BarChart data={netTrendData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={65} />
                <Tooltip content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const v = payload[0].value as number;
                  return (
                    <div className="custom-tooltip">
                      <p className="text-soft-gray text-xs mb-1">{label}</p>
                      <p className={`font-semibold ${v >= 0 ? 'text-green1' : 'text-red-400'}`}>{formatCurrency(v)}</p>
                    </div>
                  );
                }} />
                <Bar dataKey="net" radius={[4, 4, 0, 0]} animationDuration={800}>
                  {netTrendData.map((entry, i) => (
                    <Cell key={i} fill={entry.net >= 0 ? '#5EB851' : '#E85757'} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Revenue & Expense Charts side by side */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* Revenue Breakdown */}
          <div className="flagship-card rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Revenue Breakdown</h3>
            <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly revenue by source</p>
            <div className="relative z-10" style={{ height: 320 }}>
              <ResponsiveContainer minWidth={0} width="100%" height={320}>
                <BarChart data={revenueChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                  <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={65} />
                  <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    return (
                      <div className="custom-tooltip">
                        <p className="text-soft-gray text-xs mb-2">{label}</p>
                        {payload.map((e, i) => (
                          <div key={i} className="flex items-center gap-2 mb-1">
                            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                            <span className="text-soft-gray text-sm">{e.name}:</span>
                            <span className="text-lavender font-medium">{formatCurrency(e.value as number)}</span>
                          </div>
                        ))}
                      </div>
                    );
                  }} />
                  <Legend wrapperStyle={{ paddingTop: 15 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                  <Bar dataKey="tradingFees" name="Trading Fees" stackId="rev" fill={REVENUE_COLORS.tradingFees} />
                  <Bar dataKey="lpFees" name="LP Fees" stackId="rev" fill={REVENUE_COLORS.lpFees} />
                  <Bar dataKey="apyClaims" name="APY Claims" stackId="rev" fill={REVENUE_COLORS.apyClaims} />
                  <Bar dataKey="communityRewards" name="Community Rewards" stackId="rev" fill={REVENUE_COLORS.communityRewards} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Expense Breakdown */}
          <div className="flagship-card rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Expense Breakdown</h3>
            <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly expenses by category</p>
            <div className="relative z-10" style={{ height: 320 }}>
              {expenseChartData.length === 0 ? (
                <div className="flex items-center justify-center h-full text-soft-gray text-sm">No expenses entered yet</div>
              ) : (
                <ResponsiveContainer minWidth={0} width="100%" height={320}>
                  <BarChart data={expenseChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                    <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                    <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={65} />
                    <Tooltip content={({ active, payload, label }) => {
                      if (!active || !payload?.length) return null;
                      return (
                        <div className="custom-tooltip">
                          <p className="text-soft-gray text-xs mb-2">{label}</p>
                          {payload.filter(e => (e.value as number) > 0).map((e, i) => (
                            <div key={i} className="flex items-center gap-2 mb-1">
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                              <span className="text-soft-gray text-sm">{e.name}:</span>
                              <span className="text-lavender font-medium">{formatCurrency(e.value as number)}</span>
                            </div>
                          ))}
                        </div>
                      );
                    }} />
                    <Legend wrapperStyle={{ paddingTop: 15 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                    {EXPENSE_CATEGORIES.map(cat => (
                      <Bar key={cat} dataKey={cat} name={cat} stackId="exp" fill={EXPENSE_COLORS[cat]} />
                    ))}
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>
        </div>

        {/* Monthly Income Statement Table */}
        <div className="flagship-card rounded-2xl">
          <div className="p-6 border-b border-white/5 relative z-10">
            <h3 className="text-lg font-semibold text-lavender">Monthly Income Statement</h3>
            <p className="text-sm text-soft-gray mt-1">Revenue and expenses by month</p>
          </div>
          <div className="overflow-x-auto relative z-10">
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                <tr className="border-b border-white/5">
                  <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4 sticky left-0 bg-[#14141f]">Month</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Trading Fees</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">LP Fees</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">APY Claims</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Community</th>
                  <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4 border-l border-white/5">Revenue</th>
                  <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4 border-l border-white/5">Expenses</th>
                  <th className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">Net P&L</th>
                </tr>
              </thead>
              <tbody>
                {[...monthlyData].reverse().map(m => (
                  <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="py-3 px-4 text-lavender font-medium sticky left-0 bg-[#14141f]">{m.label}</td>
                    <td className="py-3 px-4 text-right text-soft-gray">{formatCurrency(m.tradingFees)}</td>
                    <td className="py-3 px-4 text-right text-soft-gray">{formatCurrency(m.lpFees)}</td>
                    <td className="py-3 px-4 text-right text-soft-gray">{formatCurrency(m.apyClaims)}</td>
                    <td className="py-3 px-4 text-right text-soft-gray">{formatCurrency(m.communityRewards)}</td>
                    <td className="py-3 px-4 text-right text-green1 font-medium border-l border-white/5">{formatCurrency(m.totalRevenue)}</td>
                    <td className="py-3 px-4 text-right text-red-400 border-l border-white/5">{m.totalExpenses > 0 ? formatCurrency(m.totalExpenses) : '—'}</td>
                    <td className={`py-3 px-4 text-right font-semibold border-l border-white/5 ${m.netPnL >= 0 ? 'text-green1' : 'text-red-400'}`}>
                      {formatCurrency(m.netPnL)}
                    </td>
                  </tr>
                ))}
                {/* Totals row */}
                {monthlyData.length > 0 && (
                  <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                    <td className="py-3 px-4 text-lavender font-bold sticky left-0 bg-[#1a1a2e]">Total</td>
                    <td className="py-3 px-4 text-right text-lavender font-semibold">{formatCurrency(monthlyData.reduce((s, m) => s + m.tradingFees, 0))}</td>
                    <td className="py-3 px-4 text-right text-lavender font-semibold">{formatCurrency(monthlyData.reduce((s, m) => s + m.lpFees, 0))}</td>
                    <td className="py-3 px-4 text-right text-lavender font-semibold">{formatCurrency(monthlyData.reduce((s, m) => s + m.apyClaims, 0))}</td>
                    <td className="py-3 px-4 text-right text-lavender font-semibold">{formatCurrency(monthlyData.reduce((s, m) => s + m.communityRewards, 0))}</td>
                    <td className="py-3 px-4 text-right text-green1 font-bold border-l border-white/5">{formatCurrency(kpis.totalRev)}</td>
                    <td className="py-3 px-4 text-right text-red-400 font-bold border-l border-white/5">{kpis.totalExp > 0 ? formatCurrency(kpis.totalExp) : '—'}</td>
                    <td className={`py-3 px-4 text-right font-bold border-l border-white/5 ${kpis.net >= 0 ? 'text-green1' : 'text-red-400'}`}>{formatCurrency(kpis.net)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Expense Management */}
        <div className="flagship-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-6 relative z-10">
            <div>
              <h3 className="text-lg font-semibold text-lavender">Manage Expenses</h3>
              <p className="text-sm text-soft-gray mt-1">Add or update monthly expense entries</p>
            </div>
            <div className="flex items-center gap-2">
              {saveMsg && <span className={`text-xs ${saveMsg === 'Saved!' ? 'text-green1' : 'text-red-400'}`}>{saveMsg}</span>}
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-purple/20 hover:bg-purple/30 text-lavender text-sm font-medium rounded-xl border border-purple/30 transition-colors disabled:opacity-50"
              >
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                Save Changes
              </button>
            </div>
          </div>

          {/* Add expense form */}
          <div className="flex flex-wrap items-end gap-3 mb-6 relative z-10">
            <div>
              <label className="text-xs text-soft-gray block mb-1">Month</label>
              <input
                type="month"
                value={formMonth}
                onChange={e => setFormMonth(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50"
              />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Category</label>
              <select
                value={formCategory}
                onChange={e => setFormCategory(e.target.value as ExpenseCategory)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50"
              >
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Amount (USD)</label>
              <input
                type="number"
                value={formAmount}
                onChange={e => setFormAmount(e.target.value)}
                placeholder="0.00"
                min="0"
                step="0.01"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-32 focus:outline-none focus:border-purple/50"
              />
            </div>
            <div className="flex-1 min-w-[150px]">
              <label className="text-xs text-soft-gray block mb-1">Note (optional)</label>
              <input
                type="text"
                value={formNote}
                onChange={e => setFormNote(e.target.value)}
                placeholder="e.g. Q1 bonus"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-full focus:outline-none focus:border-purple/50"
              />
            </div>
            <button
              onClick={handleAddExpense}
              className="flex items-center gap-1.5 px-4 py-2 bg-green1/20 hover:bg-green1/30 text-green1 text-sm font-medium rounded-lg border border-green1/30 transition-colors"
            >
              <Plus className="w-4 h-4" />
              Add
            </button>
          </div>

          {/* Expense entries table */}
          {expenses.length > 0 && (
            <div className="overflow-x-auto relative z-10">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-2 px-3">Month</th>
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-2 px-3">Category</th>
                    <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-2 px-3">Amount</th>
                    <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-2 px-3">Note</th>
                    <th className="py-2 px-3 w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {[...expenses]
                    .sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category))
                    .map((e, i) => (
                    <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                      <td className="py-2 px-3 text-lavender">{monthLabel(e.month)}</td>
                      <td className="py-2 px-3">
                        <span className="text-xs px-2 py-0.5 rounded-md" style={{ backgroundColor: `${EXPENSE_COLORS[e.category] ?? '#666'}20`, color: EXPENSE_COLORS[e.category] ?? '#999' }}>
                          {e.category}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right text-soft-gray">{formatCurrency(e.amount)}</td>
                      <td className="py-2 px-3 text-soft-gray/60 text-xs">{e.note || '—'}</td>
                      <td className="py-2 px-3">
                        <button onClick={() => handleDeleteExpense(e.month, e.category)} className="text-soft-gray/30 hover:text-red-400 transition-colors">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {expenses.length === 0 && expensesLoaded && (
            <p className="text-sm text-soft-gray/50 text-center py-6 relative z-10">No expenses entered yet. Use the form above to add entries.</p>
          )}
        </div>
      </main>
    </div>
  );
}

// ─── KPI Card ───────────────────────────────────────────────────────

function KPI({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color?: string }) {
  return (
    <div className="flagship-card rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-2 relative z-10">
        <div className="text-purple-gray">{icon}</div>
        <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className={`text-xl font-bold relative z-10 ${color ?? 'text-lavender'}`}>{value}</p>
    </div>
  );
}
