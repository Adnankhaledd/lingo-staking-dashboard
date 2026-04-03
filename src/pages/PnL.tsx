import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell, ReferenceLine,
} from 'recharts';
import {
  Lock, DollarSign, TrendingUp, TrendingDown, Minus,
  Plus, Trash2, LogOut, Wallet, Calendar,
} from 'lucide-react';
import { formatCurrency } from '../utils/formatters';
import lingoLogo from '../assets/logo-lingo.svg';

// ─── Constants ──────────────────────────────────────────────────────

const SESSION_KEY = 'admin_password';
const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';

interface ExpenseEntry {
  month: string;
  category: string;
  amount: number;
  note?: string;
}

interface BudgetEntry {
  month: string;
  category: string;
  budget: number;
}

interface TeamMember {
  name: string;
  role: string;
  monthlySalary: number;
  startMonth: string; // "2025-01"
  endMonth?: string;  // optional — still active if empty
}

interface ProjectionLineItem {
  label: string;
  amount: number;
}

interface MonthProjection {
  month: string;  // "2026-04"
  revenueItems: ProjectionLineItem[];
  expenseItems: ProjectionLineItem[];
}

// Per-month revenue model inputs
interface MonthRevenueModel {
  month: string;
  // MM Capture
  mmBuyPressure: number;
  mmCaptureRate: number;   // %
  // Product
  productUsers: number;
  productPricePerUser: number;
  // Trading Fees
  tradingVolume: number;
  tradingFeeRate: number;  // %
}

interface PnLSettings {
  treasuryBalance: number;
  annualRevenueTarget: number;
  annualExpenseTarget: number;
}


// ─── Helpers ────────────────────────────────────────────────────────

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[parseInt(m) - 1]} '${y.slice(2)}`;
}

// ─── Main Component ─────────────────────────────────────────────────

export function PnL() {
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
              <h1 className="text-lg font-semibold text-lavender">P&L Dashboard</h1>
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

  return <PnLDashboard onLogout={handleLogout} />;
}

// ─── Dashboard (authenticated) ──────────────────────────────────────

function PnLDashboard({ onLogout }: { onLogout: () => void }) {

  // Expense + budget + settings + team + projections + revenue models data from blob
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
  const [budgets, setBudgets] = useState<BudgetEntry[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [projections, setProjections] = useState<MonthProjection[]>([]);
  const [revenueModels, setRevenueModels] = useState<MonthRevenueModel[]>([]);
  const [settings, setSettings] = useState<PnLSettings>({ treasuryBalance: 0, annualRevenueTarget: 0, annualExpenseTarget: 0 });
  const [expensesLoaded, setExpensesLoaded] = useState(false);

  // Fetch
  const fetchExpenses = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/api/pnl-expenses`);
      if (res.ok) {
        const data = await res.json();
        setExpenses(data.expenses ?? []);
        setBudgets(data.budgets ?? []);
        setTeam(data.team ?? []);
        setProjections(data.projections ?? []);
        setRevenueModels(data.revenueModels ?? []);
        setSettings(prev => ({ ...prev, ...(data.settings ?? {}) }));
      }
    } catch { /* ignore */ }
    setExpensesLoaded(true);
  }, []);

  useEffect(() => { fetchExpenses(); }, [fetchExpenses]);

  // Save all — uses ref to always capture latest state
  const stateRef = useRef({ expenses, budgets, team, projections, revenueModels, settings });
  stateRef.current = { expenses, budgets, team, projections, revenueModels, settings };

  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  const handleSave = useCallback(async () => {
    if (!expensesLoaded) return;
    setSaveStatus('saving');
    try {
      const pw = sessionStorage.getItem(SESSION_KEY) || '';
      const res = await fetch(`${API_BASE}/api/save-pnl-expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pw },
        body: JSON.stringify(stateRef.current),
      });
      setSaveStatus(res.ok ? 'saved' : 'error');
      if (res.ok) setTimeout(() => setSaveStatus('idle'), 2000);
    } catch {
      setSaveStatus('error');
    }
  }, [expensesLoaded]);

  // Auto-save on any data change
  const [hasEdited, setHasEdited] = useState(false);
  useEffect(() => {
    if (expensesLoaded && hasEdited) {
      const timer = setTimeout(() => handleSave(), 800);
      return () => clearTimeout(timer);
    }
  }, [expenses, budgets, team, projections, revenueModels, settings, expensesLoaded, hasEdited, handleSave]);


  // ─── KPIs (from projection data) ───────────────────────────────────
  // These will be computed after revenueModelResults and projections are available
  // Placeholder — will be filled after revenue models are set up

  // ─── Revenue Models (MM Capture + Product + Trading Fees) ─────────

  const revenueModelMonths = useMemo(generateMonthRange, []);

  const getRevenueModel = useCallback((month: string): MonthRevenueModel => {
    return revenueModels.find(r => r.month === month) ?? {
      month, mmBuyPressure: 0, mmCaptureRate: 20, productUsers: 0, productPricePerUser: 40, tradingVolume: 0, tradingFeeRate: 1.5,
    };
  }, [revenueModels]);

  const updateRevenueModel = useCallback((month: string, field: keyof MonthRevenueModel, value: number) => {
    setRevenueModels(prev => {
      const existing = prev.find(r => r.month === month);
      if (existing) {
        return prev.map(r => r.month === month ? { ...r, [field]: value } : r);
      }
      return [...prev, { ...getRevenueModel(month), month, [field]: value }];
    });
    setHasEdited(true);
  }, [getRevenueModel]);

  // Compute per-month revenue from models
  const revenueModelResults = useMemo(() => {
    return revenueModelMonths.map(m => {
      const model = getRevenueModel(m);
      const mmCapture = model.mmBuyPressure * (model.mmCaptureRate / 100);
      const productRev = model.productUsers * model.productPricePerUser;
      const tradingFeeRev = model.tradingVolume * (model.tradingFeeRate / 100);
      return {
        month: m,
        label: monthLabel(m),
        mmBuyPressure: model.mmBuyPressure,
        mmCaptureRate: model.mmCaptureRate,
        mmCapture,
        productUsers: model.productUsers,
        productPricePerUser: model.productPricePerUser,
        productRev,
        tradingVolume: model.tradingVolume,
        tradingFeeRate: model.tradingFeeRate,
        tradingFeeRev,
        totalRevenue: mmCapture + productRev + tradingFeeRev,
      };
    });
  }, [revenueModelMonths, getRevenueModel]);

  // Build auto-generated revenue items from revenue models (NOT stored in projections — keeps inheritance clean)
  const autoRevenueByMonth = useMemo(() => {
    const autoLabels = ['MM Capture', 'Product Revenue', 'Trading Fees'];
    const map = new Map<string, ProjectionLineItem[]>();
    for (const result of revenueModelResults) {
      const items: ProjectionLineItem[] = [];
      if (result.mmCapture > 0) items.push({ label: 'MM Capture', amount: Math.round(result.mmCapture) });
      if (result.productRev > 0) items.push({ label: 'Product Revenue', amount: Math.round(result.productRev) });
      if (result.tradingFeeRev > 0) items.push({ label: 'Trading Fees', amount: Math.round(result.tradingFeeRev) });
      if (items.length > 0) map.set(result.month, items);
    }
    return { map, autoLabels };
  }, [revenueModelResults]);

  // ─── KPIs from projection data ─────────────────────────────────────

  // We need the ProjectionsTable's getWithAuto logic here too, so compute totals from projections + auto revenue
  const projKpis = useMemo(() => {
    const months = generateMonthRange();
    let totalRev = 0;
    let totalExp = 0;

    for (const m of months) {
      // Get projection (with inheritance)
      const own = projections.find(p => p.month === m);

      // Revenue: own if has items, else inherit from prev
      // Expense: own if has items, else inherit from prev
      // (simplified — just sum what the ProjectionsTable will show)
      const autoItems = autoRevenueByMonth.map.get(m) ?? [];
      const autoRev = autoItems.reduce((s, i) => s + i.amount, 0);

      // For manual items in projections, find effective (with inheritance)
      // This is a simplified version — totals will match the table
      let manualRev = 0;
      let expTotal = 0;

      if (own) {
        manualRev = own.revenueItems.filter(i => !autoRevenueByMonth.autoLabels.includes(i.label)).reduce((s, i) => s + i.amount, 0);
        expTotal = own.expenseItems.reduce((s, i) => s + i.amount, 0);
      }

      // If no expenses in own, check inheritance chain
      if (expTotal === 0) {
        const idx = months.indexOf(m);
        for (let j = idx - 1; j >= 0; j--) {
          const prev = projections.find(p => p.month === months[j]);
          if (prev && prev.expenseItems.length > 0) {
            expTotal = prev.expenseItems.reduce((s, i) => s + i.amount, 0);
            break;
          }
        }
      }

      totalRev += autoRev + manualRev;
      totalExp += expTotal;
    }

    const net = totalRev - totalExp;
    const margin = totalRev > 0 ? (net / totalRev) * 100 : 0;
    const numMonths = months.length || 1;
    const avgMonthlyBurn = totalExp / numMonths;
    const avgMonthlyNet = net / numMonths;
    const runway = avgMonthlyNet < 0 && settings.treasuryBalance > 0
      ? Math.floor(settings.treasuryBalance / Math.abs(avgMonthlyNet))
      : avgMonthlyNet >= 0 ? Infinity : 0;

    // Break-even month
    let breakEvenMonth: string | null = null;
    let cumulative = settings.treasuryBalance > 0 ? settings.treasuryBalance : 0;
    for (const m of months) {
      cumulative += avgMonthlyNet;
      if (cumulative <= 0 && avgMonthlyNet < 0) {
        breakEvenMonth = m;
        break;
      }
    }

    return { totalRev, totalExp, net, margin, avgMonthlyBurn, avgMonthlyNet, runway, breakEvenMonth };
  }, [projections, autoRevenueByMonth, settings.treasuryBalance]);

  // Net P&L chart data from projections
  const projChartData = useMemo(() => {
    const months = generateMonthRange();
    return months.map(m => {
      const autoItems = autoRevenueByMonth.map.get(m) ?? [];
      const autoRev = autoItems.reduce((s, i) => s + i.amount, 0);
      const own = projections.find(p => p.month === m);
      const manualRev = own ? own.revenueItems.filter(i => !autoRevenueByMonth.autoLabels.includes(i.label)).reduce((s, i) => s + i.amount, 0) : 0;

      let expTotal = own?.expenseItems.reduce((s, i) => s + i.amount, 0) ?? 0;
      if (expTotal === 0) {
        const idx = months.indexOf(m);
        for (let j = idx - 1; j >= 0; j--) {
          const prev = projections.find(p => p.month === months[j]);
          if (prev && prev.expenseItems.length > 0) {
            expTotal = prev.expenseItems.reduce((s, i) => s + i.amount, 0);
            break;
          }
        }
      }

      const rev = autoRev + manualRev;
      return { label: monthLabel(m), revenue: Math.round(rev), expenses: Math.round(expTotal), net: Math.round(rev - expTotal) };
    });
  }, [projections, autoRevenueByMonth]);

  const isUp = projKpis.net > 0;
  const isDown = projKpis.net < 0;

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
              {saveStatus === 'saving' && <span className="text-xs text-purple animate-pulse">Saving...</span>}
              {saveStatus === 'saved' && <span className="text-xs text-green1">Saved</span>}
              {saveStatus === 'error' && <span className="text-xs text-red-400">Save failed</span>}
              <a href="/" className="text-xs text-soft-gray hover:text-lavender px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">Dashboard</a>
              <a href="/admin" className="text-xs text-soft-gray hover:text-lavender px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">Admin</a>
              <button onClick={onLogout} className="flex items-center gap-1.5 text-xs text-soft-gray hover:text-red-400 px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/5 transition-colors">
                <LogOut className="w-3.5 h-3.5" />Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* Treasury Input */}
        <div className="flagship-card rounded-2xl p-5">
          <div className="flex flex-wrap items-center gap-6 relative z-10">
            <div className="flex items-center gap-3">
              <Wallet className="w-5 h-5 text-purple" />
              <span className="text-sm font-medium text-lavender">Treasury Balance</span>
            </div>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-soft-gray">$</span>
              <input type="number" value={settings.treasuryBalance || ''}
                onChange={e => { setSettings(p => ({ ...p, treasuryBalance: parseFloat(e.target.value) || 0 })); setHasEdited(true); }}
                placeholder="e.g. 500000" min="0"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg pl-7 pr-3 py-2 text-sm text-lavender w-48 focus:outline-none focus:border-purple/50" />
            </div>
            <span className="text-xs text-soft-gray/60">Used for runway calculation</span>
          </div>
        </div>

        {/* KPI Cards — from projection data */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPI icon={<DollarSign className="w-4 h-4" />} label="Projected Revenue" value={formatCurrency(projKpis.totalRev)} color="text-green1" sub="Apr–Dec '26" />
          <KPI icon={<TrendingDown className="w-4 h-4" />} label="Projected Expenses" value={formatCurrency(projKpis.totalExp)} color="text-red-400" sub="Apr–Dec '26" />
          <KPI
            icon={isUp ? <TrendingUp className="w-4 h-4" /> : isDown ? <TrendingDown className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
            label="Net P&L" value={formatCurrency(projKpis.net)}
            color={isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-soft-gray'}
            sub={`Margin: ${projKpis.margin.toFixed(1)}%`}
          />
          <KPI icon={<Calendar className="w-4 h-4" />} label="Runway"
            value={projKpis.runway === Infinity ? 'Profitable' : projKpis.runway > 0 ? `${projKpis.runway} months` : settings.treasuryBalance > 0 ? 'N/A' : 'Set treasury above'}
            color={projKpis.runway === Infinity ? 'text-green1' : projKpis.runway > 6 ? 'text-lavender' : 'text-red-400'}
            sub={`Burn: ${formatCurrency(projKpis.avgMonthlyBurn)}/mo`}
          />
        </div>

        {/* Projected Net P&L Chart */}
        <div className="flagship-card rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Projected Net P&L</h3>
          <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly projected revenue vs expenses (Apr–Dec 2026)</p>
          <div className="relative z-10" style={{ height: 300 }}>
            <ResponsiveContainer minWidth={0} width="100%" height={300}>
              <BarChart data={projChartData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tickFormatter={v => { const a = Math.abs(v); if (a >= 1e6) return `$${(v/1e6).toFixed(1)}M`; if (a >= 1e3) return `$${(v/1e3).toFixed(0)}K`; return `$${v}`; }}
                  stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={65} />
                <Tooltip content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  const d = payload[0]?.payload;
                  return (
                    <div className="custom-tooltip">
                      <p className="text-soft-gray text-xs mb-2">{label}</p>
                      <p className="text-green1 text-sm">Revenue: {formatCurrency(d?.revenue)}</p>
                      <p className="text-red-400 text-sm">Expenses: {formatCurrency(d?.expenses)}</p>
                      <p className={`font-semibold text-sm ${d?.net >= 0 ? 'text-green1' : 'text-red-400'}`}>Net: {formatCurrency(d?.net)}</p>
                    </div>
                  );
                }} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                <Bar dataKey="net" radius={[4, 4, 0, 0]} animationDuration={800}>
                  {projChartData.map((entry, i) => (
                    <Cell key={i} fill={entry.net >= 0 ? '#5EB851' : '#E85757'} fillOpacity={0.8} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Market Maker Capture + Product + Trading Fees */}
        <div className="flagship-card rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Market Maker Capture</h3>
          <p className="text-sm text-soft-gray mb-5 relative z-10">
            Set buy pressure and capture rate per month. Values auto-feed into the Monthly Projections table below.
          </p>

          <div className="overflow-x-auto relative z-10">
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                <tr className="border-b border-white/5">
                  <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-3 w-24">Month</th>
                  <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-2" colSpan={3}>
                    <span className="text-green1/80">MM Capture</span>
                  </th>
                  <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-2 border-l border-white/5" colSpan={3}>
                    <span className="text-[#E8B100]/80">Product Revenue</span>
                  </th>
                  <th className="text-center text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-2 border-l border-white/5" colSpan={3}>
                    <span className="text-purple/80">Trading Fees</span>
                  </th>
                  <th className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-3 border-l border-white/5">Total</th>
                </tr>
                <tr className="border-b border-white/5">
                  <th></th>
                  <th className="text-right text-[10px] text-soft-gray/60 py-1 px-2">Buy Pressure</th>
                  <th className="text-right text-[10px] text-soft-gray/60 py-1 px-2">Capture %</th>
                  <th className="text-right text-[10px] text-green1/60 py-1 px-2">= Revenue</th>
                  <th className="text-right text-[10px] text-soft-gray/60 py-1 px-2 border-l border-white/5">Users</th>
                  <th className="text-right text-[10px] text-soft-gray/60 py-1 px-2">$/User</th>
                  <th className="text-right text-[10px] text-[#E8B100]/60 py-1 px-2">= Revenue</th>
                  <th className="text-right text-[10px] text-soft-gray/60 py-1 px-2 border-l border-white/5">Volume</th>
                  <th className="text-right text-[10px] text-soft-gray/60 py-1 px-2">Fee %</th>
                  <th className="text-right text-[10px] text-purple/60 py-1 px-2">= Revenue</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {revenueModelResults.map(r => (
                  <tr key={r.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="py-2 px-3 text-lavender font-medium text-sm">{r.label}</td>
                    {/* MM Capture */}
                    <td className="py-1 px-1">
                      <input type="number" value={getRevenueModel(r.month).mmBuyPressure || ''} onChange={e => updateRevenueModel(r.month, 'mmBuyPressure', parseFloat(e.target.value) || 0)}
                        placeholder="0" className="w-24 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-xs text-lavender text-right focus:outline-none focus:border-green1/50" />
                    </td>
                    <td className="py-1 px-1">
                      <input type="number" value={getRevenueModel(r.month).mmCaptureRate || ''} step="1" onChange={e => updateRevenueModel(r.month, 'mmCaptureRate', parseFloat(e.target.value) || 0)}
                        placeholder="20" className="w-16 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-xs text-lavender text-right focus:outline-none focus:border-green1/50" />
                    </td>
                    <td className="py-2 px-2 text-right text-green1 text-xs font-medium">{formatCurrency(r.mmCapture)}</td>
                    {/* Product */}
                    <td className="py-1 px-1 border-l border-white/5">
                      <input type="number" value={getRevenueModel(r.month).productUsers || ''} onChange={e => updateRevenueModel(r.month, 'productUsers', parseFloat(e.target.value) || 0)}
                        placeholder="0" className="w-20 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-xs text-lavender text-right focus:outline-none focus:border-[#E8B100]/50" />
                    </td>
                    <td className="py-1 px-1">
                      <input type="number" value={getRevenueModel(r.month).productPricePerUser || ''} step="1" onChange={e => updateRevenueModel(r.month, 'productPricePerUser', parseFloat(e.target.value) || 0)}
                        placeholder="40" className="w-16 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-xs text-lavender text-right focus:outline-none focus:border-[#E8B100]/50" />
                    </td>
                    <td className="py-2 px-2 text-right text-[#E8B100] text-xs font-medium">{formatCurrency(r.productRev)}</td>
                    {/* Trading Fees */}
                    <td className="py-1 px-1 border-l border-white/5">
                      <input type="number" value={getRevenueModel(r.month).tradingVolume || ''} onChange={e => updateRevenueModel(r.month, 'tradingVolume', parseFloat(e.target.value) || 0)}
                        placeholder="0" className="w-24 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-xs text-lavender text-right focus:outline-none focus:border-purple/50" />
                    </td>
                    <td className="py-1 px-1">
                      <input type="number" value={getRevenueModel(r.month).tradingFeeRate || ''} step="0.1" onChange={e => updateRevenueModel(r.month, 'tradingFeeRate', parseFloat(e.target.value) || 0)}
                        placeholder="1.5" className="w-16 bg-white/[0.04] border border-white/[0.06] rounded px-2 py-1 text-xs text-lavender text-right focus:outline-none focus:border-purple/50" />
                    </td>
                    <td className="py-2 px-2 text-right text-purple text-xs font-medium">{formatCurrency(r.tradingFeeRev)}</td>
                    {/* Total */}
                    <td className="py-2 px-3 text-right text-lavender font-semibold text-sm border-l border-white/5">{r.totalRevenue > 0 ? formatCurrency(r.totalRevenue) : <span className="text-soft-gray/30">—</span>}</td>
                  </tr>
                ))}
                {/* Totals row */}
                <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                  <td className="py-2 px-3 text-lavender font-bold text-sm">Total</td>
                  <td colSpan={2}></td>
                  <td className="py-2 px-2 text-right text-green1 font-bold text-xs">{formatCurrency(revenueModelResults.reduce((s, r) => s + r.mmCapture, 0))}</td>
                  <td colSpan={2} className="border-l border-white/5"></td>
                  <td className="py-2 px-2 text-right text-[#E8B100] font-bold text-xs">{formatCurrency(revenueModelResults.reduce((s, r) => s + r.productRev, 0))}</td>
                  <td colSpan={2} className="border-l border-white/5"></td>
                  <td className="py-2 px-2 text-right text-purple font-bold text-xs">{formatCurrency(revenueModelResults.reduce((s, r) => s + r.tradingFeeRev, 0))}</td>
                  <td className="py-2 px-3 text-right text-lavender font-bold text-sm border-l border-white/5">{formatCurrency(revenueModelResults.reduce((s, r) => s + r.totalRevenue, 0))}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Interactive Monthly Projections */}
        <ProjectionsTable projections={projections} setProjections={setProjections} onEdit={() => setHasEdited(true)} autoRevenue={autoRevenueByMonth} />

      </main>
    </div>
  );
}

// ─── KPI Card ───────────────────────────────────────────────────────

function KPI({ icon, label, value, color, sub }: { icon: React.ReactNode; label: string; value: string; color?: string; sub?: string }) {
  return (
    <div className="flagship-card rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-2 relative z-10">
        <div className="text-purple-gray">{icon}</div>
        <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className={`text-xl font-bold relative z-10 ${color ?? 'text-lavender'}`}>{value}</p>
      {sub && <p className="text-xs text-soft-gray/60 mt-1 relative z-10">{sub}</p>}
    </div>
  );
}

// ─── Interactive Projections Table ──────────────────────────────────

interface ProjectionsTableProps {
  projections: MonthProjection[];
  setProjections: React.Dispatch<React.SetStateAction<MonthProjection[]>>;
  onEdit: () => void;
  autoRevenue: { map: Map<string, ProjectionLineItem[]>; autoLabels: string[] };
}

function generateMonthRange(): string[] {
  const now = new Date();
  const months: string[] = [];
  for (let m = now.getMonth(); m < 12; m++) {
    months.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
  }
  return months;
}

function ProjectionsTable({ projections, setProjections, onEdit, autoRevenue }: ProjectionsTableProps) {
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const months = useMemo(generateMonthRange, []);

  // Check if a month has its own saved data (was explicitly edited)
  const hasOwnData = (month: string): boolean => {
    return projections.some(p => p.month === month);
  };

  // Get effective projection: per-type inheritance
  // Revenue and expenses inherit independently from the previous month if empty
  const getEffective = useMemo(() => {
    const cache = new Map<string, MonthProjection>();

    // Get inherited items from the previous month for a given type
    const getInheritedItems = (month: string, type: 'revenue' | 'expense'): ProjectionLineItem[] => {
      const idx = months.indexOf(month);
      if (idx <= 0) return [];
      const prev = getEffective(months[idx - 1]);
      const items = type === 'revenue' ? prev.revenueItems : prev.expenseItems;
      return items.map(i => ({ ...i }));
    };

    const getEffective = (month: string): MonthProjection => {
      if (cache.has(month)) return cache.get(month)!;

      const own = projections.find(p => p.month === month);

      let revenueItems: ProjectionLineItem[];
      let expenseItems: ProjectionLineItem[];

      if (own && own.revenueItems.length > 0) {
        revenueItems = own.revenueItems;
      } else {
        revenueItems = getInheritedItems(month, 'revenue');
      }

      if (own && own.expenseItems.length > 0) {
        expenseItems = own.expenseItems;
      } else {
        expenseItems = getInheritedItems(month, 'expense');
      }

      const result = { month, revenueItems, expenseItems };
      cache.set(month, result);
      return result;
    };

    return getEffective;
  }, [projections, months]);

  // Merge auto-revenue items on top of effective projection (for display only, not stored)
  const getWithAuto = (month: string): MonthProjection => {
    const base = getEffective(month);
    const autoItems = autoRevenue.map.get(month) ?? [];
    if (autoItems.length === 0) return base;
    // Filter out any manually-added items with auto-labels, then prepend auto items
    const manualRevenue = base.revenueItems.filter(i => !autoRevenue.autoLabels.includes(i.label));
    return { ...base, revenueItems: [...autoItems, ...manualRevenue] };
  };

  // When user edits a month, save it as explicit data (breaking inheritance for this month)
  const updateProjection = (month: string, updated: MonthProjection) => {
    setProjections(prev => {
      const filtered = prev.filter(p => p.month !== month);
      return [...filtered, updated];
    });
    onEdit();
  };

  // Reset a month to inherit from previous (remove its explicit data)
  const resetToInherited = (month: string) => {
    setProjections(prev => prev.filter(p => p.month !== month));
    onEdit();
  };

  const addLineItem = (month: string, type: 'revenue' | 'expense') => {
    const proj = { ...getEffective(month), month };
    if (type === 'revenue') {
      proj.revenueItems = [...proj.revenueItems, { label: '', amount: 0 }];
    } else {
      proj.expenseItems = [...proj.expenseItems, { label: '', amount: 0 }];
    }
    updateProjection(month, proj);
  };

  const removeLineItem = (month: string, type: 'revenue' | 'expense', index: number) => {
    const proj = { ...getEffective(month), month };
    if (type === 'revenue') {
      proj.revenueItems = proj.revenueItems.filter((_, i) => i !== index);
    } else {
      proj.expenseItems = proj.expenseItems.filter((_, i) => i !== index);
    }
    updateProjection(month, proj);
  };

  const updateLineItem = (month: string, type: 'revenue' | 'expense', index: number, field: 'label' | 'amount', value: string) => {
    const proj = { ...getEffective(month), month };
    const items = type === 'revenue' ? [...proj.revenueItems] : [...proj.expenseItems];
    items[index] = { ...items[index], [field]: field === 'amount' ? (parseFloat(value) || 0) : value };
    if (type === 'revenue') proj.revenueItems = items;
    else proj.expenseItems = items;
    updateProjection(month, proj);
  };

  // Calculate totals for the summary row (use getWithAuto for display)
  const monthTotals = months.map(m => {
    const proj = getWithAuto(m);
    const rev = proj.revenueItems.reduce((s, i) => s + i.amount, 0);
    const exp = proj.expenseItems.reduce((s, i) => s + i.amount, 0);
    return { month: m, label: monthLabel(m), revenue: rev, expenses: exp, net: rev - exp, isOwn: hasOwnData(m) };
  });

  const grandTotal = {
    revenue: monthTotals.reduce((s, m) => s + m.revenue, 0),
    expenses: monthTotals.reduce((s, m) => s + m.expenses, 0),
    net: monthTotals.reduce((s, m) => s + m.net, 0),
  };

  return (
    <div className="flagship-card rounded-2xl">
      <div className="p-6 border-b border-white/5 relative z-10">
        <h3 className="text-lg font-semibold text-lavender">Monthly Projections</h3>
        <p className="text-sm text-soft-gray mt-1">
          Click a month to expand and edit revenue/expense targets. Compare against actuals at month-end.
        </p>
      </div>

      <div className="relative z-10">
        {/* Summary table */}
        <table className="w-full text-sm">
          <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
            <tr className="border-b border-white/5">
              <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-6 w-36">Month</th>
              <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4">Projected Revenue</th>
              <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4">Projected Expenses</th>
              <th className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-6">Net P&L</th>
            </tr>
          </thead>
          <tbody>
            {monthTotals.map(m => {
              const isExpanded = expandedMonth === m.month;
              const proj = getWithAuto(m.month);
              const hasData = proj.revenueItems.length > 0 || proj.expenseItems.length > 0;
              const isInherited = !m.isOwn && hasData;

              return (
                <Fragment key={m.month}>
                  {/* Summary row — clickable */}
                  <tr
                    className={`border-b border-white/5 cursor-pointer transition-colors ${isExpanded ? 'bg-purple/5' : 'hover:bg-white/[0.02]'}`}
                    onClick={() => setExpandedMonth(isExpanded ? null : m.month)}
                  >
                    <td className="py-3 px-6">
                      <div className="flex items-center gap-2">
                        <span className={`text-xs transition-transform ${isExpanded ? 'rotate-90' : ''}`}>&#9654;</span>
                        <span className="text-lavender font-medium">{m.label}</span>
                        {m.isOwn && <span className="w-1.5 h-1.5 rounded-full bg-purple" title="Customized" />}
                        {isInherited && <span className="text-[10px] text-soft-gray/40 italic" title="Inherited from previous month">inherited</span>}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-right text-green1 font-medium">{m.revenue > 0 ? formatCurrency(m.revenue) : <span className="text-soft-gray/30">—</span>}</td>
                    <td className="py-3 px-4 text-right text-red-400">{m.expenses > 0 ? formatCurrency(m.expenses) : <span className="text-soft-gray/30">—</span>}</td>
                    <td className={`py-3 px-6 text-right font-semibold ${m.net > 0 ? 'text-green1' : m.net < 0 ? 'text-red-400' : 'text-soft-gray/30'}`}>
                      {m.revenue > 0 || m.expenses > 0 ? formatCurrency(m.net) : '—'}
                    </td>
                  </tr>

                  {/* Expanded detail — editable line items */}
                  {isExpanded && (
                    <tr>
                      <td colSpan={4} className="bg-white/[0.02] border-b border-white/5 px-6 py-4">
                        {/* Inherited banner + reset */}
                        {isInherited && (
                          <p className="text-xs text-soft-gray/50 mb-3 italic">
                            This month inherits from the previous month. Edit anything below to customize it.
                          </p>
                        )}
                        {m.isOwn && months.indexOf(m.month) > 0 && (
                          <div className="flex justify-end mb-3">
                            <button
                              onClick={(e) => { e.stopPropagation(); resetToInherited(m.month); }}
                              className="text-xs text-soft-gray/50 hover:text-purple transition-colors underline"
                            >
                              Reset to inherit from previous month
                            </button>
                          </div>
                        )}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                          {/* Revenue items */}
                          <div>
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-sm font-medium text-green1">Revenue</h4>
                              <button onClick={(e) => { e.stopPropagation(); addLineItem(m.month, 'revenue'); }}
                                className="flex items-center gap-1 text-xs text-green1/70 hover:text-green1 transition-colors">
                                <Plus className="w-3 h-3" />Add
                              </button>
                            </div>
                            {/* Auto items from Market Maker Capture — static, not editable */}
                            {(() => {
                              const autoItems = autoRevenue.map.get(m.month) ?? [];
                              const manualItems = proj.revenueItems.filter(i => !autoRevenue.autoLabels.includes(i.label));
                              return (
                                <>
                                  {autoItems.map((item, idx) => (
                                    <div key={`auto-${idx}`} className="flex items-center gap-2 mb-2 opacity-70">
                                      <div className="flex-1 bg-white/[0.02] border border-white/[0.05] rounded-lg px-3 py-1.5 text-xs text-soft-gray">
                                        {item.label} <span className="text-[10px] italic text-soft-gray/40 ml-1">from MM Capture</span>
                                      </div>
                                      <div className="w-28 bg-white/[0.02] border border-white/[0.05] rounded-lg px-2 py-1.5 text-xs text-green1 text-right">
                                        {formatCurrency(item.amount)}
                                      </div>
                                      <div className="w-3" /> {/* spacer for alignment */}
                                    </div>
                                  ))}
                                  {/* Manual items — editable */}
                                  {manualItems.map((item, idx) => (
                                    <div key={`manual-${idx}`} className="flex items-center gap-2 mb-2">
                                      <input
                                        type="text" value={item.label}
                                        onChange={e => {
                                          const base = getEffective(m.month);
                                          const manuals = base.revenueItems.filter(i => !autoRevenue.autoLabels.includes(i.label));
                                          manuals[idx] = { ...manuals[idx], label: e.target.value };
                                          updateProjection(m.month, { ...base, month: m.month, revenueItems: [...base.revenueItems.filter(i => autoRevenue.autoLabels.includes(i.label)), ...manuals] });
                                        }}
                                        placeholder="e.g. Other Revenue"
                                        className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-lavender focus:outline-none focus:border-green1/50"
                                        onClick={e => e.stopPropagation()}
                                      />
                                      <div className="relative">
                                        <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-soft-gray">$</span>
                                        <input
                                          type="number" value={item.amount || ''}
                                          onChange={e => {
                                            const base = getEffective(m.month);
                                            const manuals = base.revenueItems.filter(i => !autoRevenue.autoLabels.includes(i.label));
                                            manuals[idx] = { ...manuals[idx], amount: parseFloat(e.target.value) || 0 };
                                            updateProjection(m.month, { ...base, month: m.month, revenueItems: [...base.revenueItems.filter(i => autoRevenue.autoLabels.includes(i.label)), ...manuals] });
                                          }}
                                          placeholder="0"
                                          className="w-28 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-5 pr-2 py-1.5 text-xs text-lavender text-right focus:outline-none focus:border-green1/50"
                                          onClick={e => e.stopPropagation()}
                                        />
                                      </div>
                                      <button onClick={(ev) => {
                                        ev.stopPropagation();
                                        const base = getEffective(m.month);
                                        const manuals = base.revenueItems.filter(i => !autoRevenue.autoLabels.includes(i.label)).filter((_, i) => i !== idx);
                                        updateProjection(m.month, { ...base, month: m.month, revenueItems: [...base.revenueItems.filter(i => autoRevenue.autoLabels.includes(i.label)), ...manuals] });
                                      }} className="text-soft-gray/30 hover:text-red-400 transition-colors">
                                        <Trash2 className="w-3 h-3" />
                                      </button>
                                    </div>
                                  ))}
                                  {autoItems.length === 0 && manualItems.length === 0 && (
                                    <p className="text-xs text-soft-gray/40 py-2">No revenue items — click Add</p>
                                  )}
                                </>
                              );
                            })()}
                            {proj.revenueItems.length > 0 && (
                              <div className="flex justify-end mt-2 pt-2 border-t border-white/5">
                                <span className="text-xs text-green1 font-medium">Total: {formatCurrency(proj.revenueItems.reduce((s, i) => s + i.amount, 0))}</span>
                              </div>
                            )}
                          </div>

                          {/* Expense items */}
                          <div>
                            <div className="flex items-center justify-between mb-3">
                              <h4 className="text-sm font-medium text-red-400">Expenses</h4>
                              <button onClick={(e) => { e.stopPropagation(); addLineItem(m.month, 'expense'); }}
                                className="flex items-center gap-1 text-xs text-red-400/70 hover:text-red-400 transition-colors">
                                <Plus className="w-3 h-3" />Add
                              </button>
                            </div>
                            {proj.expenseItems.length === 0 && (
                              <p className="text-xs text-soft-gray/40 py-2">No expense items — click Add</p>
                            )}
                            {proj.expenseItems.map((item, idx) => (
                              <div key={idx} className="flex items-center gap-2 mb-2">
                                <input
                                  type="text" value={item.label}
                                  onChange={e => updateLineItem(m.month, 'expense', idx, 'label', e.target.value)}
                                  placeholder="e.g. Team Salary"
                                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-lavender focus:outline-none focus:border-red-400/50"
                                  onClick={e => e.stopPropagation()}
                                />
                                <div className="relative">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-soft-gray">$</span>
                                  <input
                                    type="number" value={item.amount || ''}
                                    onChange={e => updateLineItem(m.month, 'expense', idx, 'amount', e.target.value)}
                                    placeholder="0"
                                    className="w-28 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-5 pr-2 py-1.5 text-xs text-lavender text-right focus:outline-none focus:border-red-400/50"
                                    onClick={e => e.stopPropagation()}
                                  />
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); removeLineItem(m.month, 'expense', idx); }}
                                  className="text-soft-gray/30 hover:text-red-400 transition-colors">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
                            {proj.expenseItems.length > 0 && (
                              <div className="flex justify-end mt-2 pt-2 border-t border-white/5">
                                <span className="text-xs text-red-400 font-medium">Total: {formatCurrency(proj.expenseItems.reduce((s, i) => s + i.amount, 0))}</span>
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </Fragment>
              );
            })}

            {/* Grand total */}
            <tr className="border-t-2 border-white/10 bg-white/[0.02]">
              <td className="py-3 px-6 text-lavender font-bold">Total</td>
              <td className="py-3 px-4 text-right text-green1 font-bold">{grandTotal.revenue > 0 ? formatCurrency(grandTotal.revenue) : '—'}</td>
              <td className="py-3 px-4 text-right text-red-400 font-bold">{grandTotal.expenses > 0 ? formatCurrency(grandTotal.expenses) : '—'}</td>
              <td className={`py-3 px-6 text-right font-bold ${grandTotal.net >= 0 ? 'text-green1' : 'text-red-400'}`}>
                {grandTotal.revenue > 0 || grandTotal.expenses > 0 ? formatCurrency(grandTotal.net) : '—'}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
