import { useState, useEffect, useMemo, useCallback, Fragment } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Cell, ReferenceLine,
} from 'recharts';
import {
  Lock, DollarSign, TrendingUp, TrendingDown, Minus,
  Plus, Save, Trash2, RefreshCw, LogOut, Users, Wallet, Calendar,
} from 'lucide-react';
import { formatCurrency } from '../utils/formatters';
import {
  useDuneQuery, DUNE_QUERIES,
  type TradingFeesRow, type LPFeesRow, type WeeklyStatsRow,
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

interface ScenarioAssumptions {
  monthlyBuyPressure: number;   // $ buy volume per month
  feeCaptureRate: number;       // % of buy pressure captured as fees (e.g. 1.5)
  monthlySellAmount: number;    // LINGO tokens sold per month
  lingoPrice: number;           // assumed $ per LINGO
  lpFeesMonthly: number;        // estimated LP fees per month
  growthRatePct: number;        // month-over-month growth % on buy pressure
}

const DEFAULT_ASSUMPTIONS: ScenarioAssumptions = {
  monthlyBuyPressure: 150000,
  feeCaptureRate: 1.5,
  monthlySellAmount: 30000,
  lingoPrice: 0.008,
  lpFeesMonthly: 2000,
  growthRatePct: 5,
};

interface PnLSettings {
  treasuryBalance: number;
  annualRevenueTarget: number;
  annualExpenseTarget: number;
  assumptions?: ScenarioAssumptions;
}

interface MonthlyRecord {
  month: string;
  label: string;
  tradingFees: number;
  lpFees: number;
  totalRevenue: number;
  expenses: Record<string, number>;
  budgets: Record<string, number>;
  totalExpenses: number;
  totalBudget: number;
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
};

// ─── Helpers ────────────────────────────────────────────────────────

function parseDuneMonth(raw: string): string {
  if (!raw) return '';
  return raw.split('T')[0].slice(0, 7);
}

function monthLabel(ym: string): string {
  const [y, m] = ym.split('-');
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${MONTHS[parseInt(m) - 1]} '${y.slice(2)}`;
}

function fmtUsd(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  return `$${n.toFixed(0)}`;
}

function currentYM(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function currentYear(): number {
  return new Date().getFullYear();
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
  // Revenue data
  const { data: tradingFees } = useDuneQuery<TradingFeesRow>(DUNE_QUERIES.TRADING_FEES);
  const { data: lpFees } = useDuneQuery<LPFeesRow>(DUNE_QUERIES.LP_FEES);
  const { data: weeklyStats } = useDuneQuery<WeeklyStatsRow>(DUNE_QUERIES.WEEKLY_STATS);

  // Expense + budget + settings + team + projections data from blob
  const [expenses, setExpenses] = useState<ExpenseEntry[]>([]);
  const [budgets, setBudgets] = useState<BudgetEntry[]>([]);
  const [team, setTeam] = useState<TeamMember[]>([]);
  const [projections, setProjections] = useState<MonthProjection[]>([]);
  const [settings, setSettings] = useState<PnLSettings>({ treasuryBalance: 0, annualRevenueTarget: 0, annualExpenseTarget: 0 });
  const [expensesLoaded, setExpensesLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Expense form
  const [formMonth, setFormMonth] = useState(currentYM);
  const [formCategory, setFormCategory] = useState<ExpenseCategory>(EXPENSE_CATEGORIES[0]);
  const [formAmount, setFormAmount] = useState('');
  const [formNote, setFormNote] = useState('');
  const [formType, setFormType] = useState<'expense' | 'budget'>('expense');

  // Team form
  const [teamName, setTeamName] = useState('');
  const [teamRole, setTeamRole] = useState('');
  const [teamSalary, setTeamSalary] = useState('');
  const [teamStart, setTeamStart] = useState(currentYM);

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
        setSettings(prev => ({ ...prev, ...(data.settings ?? {}) }));
      }
    } catch { /* ignore */ }
    setExpensesLoaded(true);
  }, []);

  useEffect(() => { fetchExpenses(); }, [fetchExpenses]);

  // Save all
  const handleSave = useCallback(async () => {
    if (!expensesLoaded) return; // Don't overwrite blob before data is loaded
    setSaving(true);
    setSaveMsg('');
    try {
      const pw = sessionStorage.getItem(SESSION_KEY) || '';
      const res = await fetch(`${API_BASE}/api/save-pnl-expenses`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': pw },
        body: JSON.stringify({ expenses, budgets, team, projections, settings }),
      });
      const data = await res.json();
      setSaveMsg(res.ok ? 'Saved!' : data.error || 'Failed');
      setTimeout(() => setSaveMsg(''), 3000);
    } catch { setSaveMsg('Network error'); }
    setSaving(false);
  }, [expenses, budgets, team, projections, settings, expensesLoaded]);

  // Auto-save: persist to blob whenever data changes (after initial load)
  const [hasEdited, setHasEdited] = useState(false);
  useEffect(() => {
    if (expensesLoaded && hasEdited) {
      const timer = setTimeout(() => handleSave(), 800); // debounce 800ms
      return () => clearTimeout(timer);
    }
  }, [expenses, budgets, team, projections, settings, expensesLoaded, hasEdited, handleSave]);

  // Add entry
  const handleAddEntry = () => {
    const amount = parseFloat(formAmount);
    if (isNaN(amount) || amount <= 0) return;

    if (formType === 'expense') {
      setExpenses(prev => {
        const filtered = prev.filter(e => !(e.month === formMonth && e.category === formCategory));
        return [...filtered, { month: formMonth, category: formCategory, amount, note: formNote || undefined }];
      });
    } else {
      setBudgets(prev => {
        const filtered = prev.filter(b => !(b.month === formMonth && b.category === formCategory));
        return [...filtered, { month: formMonth, category: formCategory, budget: amount }];
      });
    }
    setFormAmount('');
    setFormNote('');
    setHasEdited(true);
  };

  const handleDeleteExpense = (month: string, category: string) => {
    setExpenses(prev => prev.filter(e => !(e.month === month && e.category === category)));
    setHasEdited(true);
  };

  const handleDeleteBudget = (month: string, category: string) => {
    setBudgets(prev => prev.filter(b => !(b.month === month && b.category === category)));
    setHasEdited(true);
  };

  // Team member management
  const handleAddTeamMember = () => {
    const salary = parseFloat(teamSalary);
    if (!teamName.trim() || isNaN(salary) || salary <= 0) return;
    setTeam(prev => [...prev, { name: teamName.trim(), role: teamRole.trim(), monthlySalary: salary, startMonth: teamStart }]);
    setTeamName('');
    setTeamRole('');
    setTeamSalary('');
    setHasEdited(true);
  };

  const handleDeleteTeamMember = (index: number) => {
    setTeam(prev => prev.filter((_, i) => i !== index));
    setHasEdited(true);
  };

  // Compute team expenses: each member generates a "Team Compensation" expense for each active month
  const teamExpenses = useMemo<ExpenseEntry[]>(() => {
    const entries: ExpenseEntry[] = [];
    const now = currentYM();
    for (const member of team) {
      let m = member.startMonth;
      while (m <= now && (!member.endMonth || m <= member.endMonth)) {
        entries.push({ month: m, category: 'Team Compensation', amount: member.monthlySalary, note: member.name });
        // Increment month
        const [y, mo] = m.split('-').map(Number);
        const next = mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, '0')}`;
        m = next;
      }
    }
    return entries;
  }, [team]);

  // Merge manual expenses + team-generated expenses
  const allExpenses = useMemo(() => {
    // Team expenses aggregate into Team Compensation per month
    const merged = [...expenses.filter(e => e.category !== 'Team Compensation')];
    // Group team expenses by month
    const teamByMonth = new Map<string, number>();
    for (const te of teamExpenses) {
      teamByMonth.set(te.month, (teamByMonth.get(te.month) ?? 0) + te.amount);
    }
    // Also add any manual "Team Compensation" entries that aren't from team members
    for (const e of expenses.filter(e => e.category === 'Team Compensation')) {
      teamByMonth.set(e.month, (teamByMonth.get(e.month) ?? 0) + e.amount);
    }
    for (const [month, amount] of teamByMonth) {
      merged.push({ month, category: 'Team Compensation', amount });
    }
    return merged;
  }, [expenses, teamExpenses]);

  // ─── Build monthly P&L records ────────────────────────────────────

  const monthlyData = useMemo<MonthlyRecord[]>(() => {
    const months = new Set<string>();
    const revenueMap = new Map<string, { tradingFees: number; lpFees: number }>();

    const ensure = (m: string) => {
      months.add(m);
      if (!revenueMap.has(m)) revenueMap.set(m, { tradingFees: 0, lpFees: 0 });
    };

    tradingFees?.forEach(r => { const m = parseDuneMonth(r.month); if (m) { ensure(m); revenueMap.get(m)!.tradingFees += r.usd_value ?? 0; } });
    lpFees?.forEach(r => { const m = parseDuneMonth(r.month); if (m) { ensure(m); revenueMap.get(m)!.lpFees += r.fees_usd ?? 0; } });

    allExpenses.forEach(e => months.add(e.month));
    budgets.forEach(b => months.add(b.month));

    const expenseMap = new Map<string, Record<string, number>>();
    allExpenses.forEach(e => {
      if (!expenseMap.has(e.month)) expenseMap.set(e.month, {});
      expenseMap.get(e.month)![e.category] = (expenseMap.get(e.month)![e.category] ?? 0) + e.amount;
    });

    const budgetMap = new Map<string, Record<string, number>>();
    budgets.forEach(b => {
      if (!budgetMap.has(b.month)) budgetMap.set(b.month, {});
      budgetMap.get(b.month)![b.category] = b.budget;
    });

    return Array.from(months).sort().map(m => {
      const rev = revenueMap.get(m) ?? { tradingFees: 0, lpFees: 0 };
      const exp = expenseMap.get(m) ?? {};
      const bud = budgetMap.get(m) ?? {};
      const totalRevenue = rev.tradingFees + rev.lpFees;
      const totalExpenses = Object.values(exp).reduce((s, v) => s + v, 0);
      const totalBudget = Object.values(bud).reduce((s, v) => s + v, 0);
      return { month: m, label: monthLabel(m), ...rev, totalRevenue, expenses: exp, budgets: bud, totalExpenses, totalBudget, netPnL: totalRevenue - totalExpenses };
    });
  }, [tradingFees, lpFees, allExpenses, budgets]);

  // ─── KPIs ─────────────────────────────────────────────────────────

  const kpis = useMemo(() => {
    const totalRev = monthlyData.reduce((s, m) => s + m.totalRevenue, 0);
    const totalExp = monthlyData.reduce((s, m) => s + m.totalExpenses, 0);
    const net = totalRev - totalExp;
    const current = monthlyData.length > 0 ? monthlyData[monthlyData.length - 1] : null;
    const margin = totalRev > 0 ? (net / totalRev) * 100 : 0;

    // ARPU: avg monthly revenue / avg active stakers
    const latestStakers = weeklyStats?.slice(-1)[0]?.active_stakers ?? 0;
    const monthsWithRev = monthlyData.filter(m => m.totalRevenue > 0).length || 1;
    const avgMonthlyRev = totalRev / monthsWithRev;
    const arpu = latestStakers > 0 ? avgMonthlyRev / latestStakers : 0;

    // Burn rate & runway
    const recentMonths = monthlyData.slice(-3);
    const avgMonthlyBurn = recentMonths.length > 0 ? recentMonths.reduce((s, m) => s + m.totalExpenses, 0) / recentMonths.length : 0;
    const avgMonthlyNet = recentMonths.length > 0 ? recentMonths.reduce((s, m) => s + m.netPnL, 0) / recentMonths.length : 0;
    const runway = avgMonthlyNet < 0 && settings.treasuryBalance > 0
      ? Math.floor(settings.treasuryBalance / Math.abs(avgMonthlyNet))
      : avgMonthlyNet >= 0 ? Infinity : 0;

    return { totalRev, totalExp, net, currentMonthRev: current?.totalRevenue ?? 0, margin, arpu, latestStakers, avgMonthlyBurn, avgMonthlyNet, runway };
  }, [monthlyData, weeklyStats, settings.treasuryBalance]);

  // ─── Annual Projection ────────────────────────────────────────────

  const projection = useMemo(() => {
    const year = currentYear();
    const yearMonths = monthlyData.filter(m => m.month.startsWith(`${year}`));
    const completedMonths = yearMonths.length;
    const ytdRevenue = yearMonths.reduce((s, m) => s + m.totalRevenue, 0);
    const ytdExpenses = yearMonths.reduce((s, m) => s + m.totalExpenses, 0);

    // Run rate: extrapolate from completed months
    const monthsRemaining = 12 - completedMonths;
    const avgMonthlyRev = completedMonths > 0 ? ytdRevenue / completedMonths : 0;
    const avgMonthlyExp = completedMonths > 0 ? ytdExpenses / completedMonths : 0;
    const projectedRevenue = ytdRevenue + avgMonthlyRev * monthsRemaining;
    const projectedExpenses = ytdExpenses + avgMonthlyExp * monthsRemaining;
    const projectedNet = projectedRevenue - projectedExpenses;

    // Break-even: when cumulative net turns positive (if currently negative)
    let breakEvenMonth: string | null = null;
    if (kpis.avgMonthlyNet > 0 && kpis.net < 0) {
      const monthsToBreakEven = Math.ceil(Math.abs(kpis.net) / kpis.avgMonthlyNet);
      const d = new Date();
      d.setMonth(d.getMonth() + monthsToBreakEven);
      breakEvenMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    } else if (kpis.net >= 0) {
      breakEvenMonth = 'Already profitable';
    }

    // Build projection line chart data
    const projData = [];
    for (let mo = 1; mo <= 12; mo++) {
      const key = `${year}-${String(mo).padStart(2, '0')}`;
      const actual = yearMonths.find(m => m.month === key);
      projData.push({
        label: monthLabel(key),
        actual: actual ? Math.round(actual.totalRevenue) : null,
        projected: !actual ? Math.round(avgMonthlyRev) : null,
        target: settings.annualRevenueTarget > 0 ? Math.round(settings.annualRevenueTarget / 12) : null,
      });
    }

    return { year, completedMonths, ytdRevenue, ytdExpenses, projectedRevenue, projectedExpenses, projectedNet, breakEvenMonth, projData, avgMonthlyRev };
  }, [monthlyData, settings.annualRevenueTarget, kpis]);

  // ─── Budget vs Actual ─────────────────────────────────────────────

  const budgetVsActual = useMemo(() => {
    const year = currentYear();
    return monthlyData
      .filter(m => m.month.startsWith(`${year}`) && (m.totalBudget > 0 || m.totalExpenses > 0))
      .map(m => ({
        label: m.label,
        actual: Math.round(m.totalExpenses),
        budget: Math.round(m.totalBudget),
        variance: Math.round(m.totalBudget - m.totalExpenses),
      }));
  }, [monthlyData]);

  // ─── Scenario Assumptions ─────────────────────────────────────────

  const assumptions = settings.assumptions ?? DEFAULT_ASSUMPTIONS;

  const setAssumption = <K extends keyof ScenarioAssumptions>(key: K, value: ScenarioAssumptions[K]) => {
    setSettings(prev => ({
      ...prev,
      assumptions: { ...(prev.assumptions ?? DEFAULT_ASSUMPTIONS), [key]: value },
    }));
    setHasEdited(true);
  };

  const scenarioData = useMemo(() => {
    const months = generateMonthRange();
    return months.map((m, i) => {
      const growthMultiplier = Math.pow(1 + assumptions.growthRatePct / 100, i);
      const buyPressure = assumptions.monthlyBuyPressure * growthMultiplier;
      const tradingFeeRevenue = buyPressure * (assumptions.feeCaptureRate / 100);
      const sellRevenue = assumptions.monthlySellAmount * assumptions.lingoPrice;
      const lpFees = assumptions.lpFeesMonthly * growthMultiplier;
      const totalRevenue = tradingFeeRevenue + sellRevenue + lpFees;

      return {
        month: m,
        label: monthLabel(m),
        buyPressure: Math.round(buyPressure),
        tradingFees: Math.round(tradingFeeRevenue),
        sellRevenue: Math.round(sellRevenue),
        lpFees: Math.round(lpFees),
        totalRevenue: Math.round(totalRevenue),
      };
    });
  }, [assumptions]);

  const scenarioTotals = useMemo(() => ({
    totalRevenue: scenarioData.reduce((s, m) => s + m.totalRevenue, 0),
    totalTradingFees: scenarioData.reduce((s, m) => s + m.tradingFees, 0),
    totalSellRevenue: scenarioData.reduce((s, m) => s + m.sellRevenue, 0),
    totalLpFees: scenarioData.reduce((s, m) => s + m.lpFees, 0),
  }), [scenarioData]);

  // Chart data
  const netTrendData = useMemo(() => monthlyData.map(m => ({ label: m.label, net: Math.round(m.netPnL) })), [monthlyData]);
  const revenueChartData = useMemo(() => monthlyData.map(m => ({ label: m.label, tradingFees: Math.round(m.tradingFees), lpFees: Math.round(m.lpFees) })), [monthlyData]);
  const expenseChartData = useMemo(() => monthlyData.filter(m => m.totalExpenses > 0).map(m => ({
    label: m.label, ...Object.fromEntries(EXPENSE_CATEGORIES.map(c => [c, m.expenses[c] ?? 0])),
  })), [monthlyData]);

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
                <LogOut className="w-3.5 h-3.5" />Logout
              </button>
            </div>
          </div>
        </div>
      </header>

      <main className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* KPI Cards — 2 rows */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPI icon={<DollarSign className="w-4 h-4" />} label="Total Revenue" value={formatCurrency(kpis.totalRev)} color="text-green1" />
          <KPI icon={<TrendingDown className="w-4 h-4" />} label="Total Expenses" value={formatCurrency(kpis.totalExp)} color="text-red-400" />
          <KPI
            icon={isUp ? <TrendingUp className="w-4 h-4" /> : isDown ? <TrendingDown className="w-4 h-4" /> : <Minus className="w-4 h-4" />}
            label="Net P&L" value={formatCurrency(kpis.net)}
            color={isUp ? 'text-green1' : isDown ? 'text-red-400' : 'text-soft-gray'}
          />
          <KPI icon={<TrendingUp className="w-4 h-4" />} label="Gross Margin" value={`${kpis.margin.toFixed(1)}%`} color={kpis.margin >= 0 ? 'text-green1' : 'text-red-400'} />
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <KPI icon={<DollarSign className="w-4 h-4" />} label="Current Month Rev" value={formatCurrency(kpis.currentMonthRev)} />
          <KPI icon={<Users className="w-4 h-4" />} label="ARPU (Monthly)" value={formatCurrency(kpis.arpu)} sub={`${(kpis.latestStakers ?? 0).toLocaleString()} stakers`} />
          <KPI icon={<Wallet className="w-4 h-4" />} label="Avg Monthly Burn" value={formatCurrency(kpis.avgMonthlyBurn)} color="text-red-400" />
          <KPI icon={<Calendar className="w-4 h-4" />} label="Runway"
            value={kpis.runway === Infinity ? 'Profitable' : kpis.runway > 0 ? `${kpis.runway} months` : settings.treasuryBalance > 0 ? 'N/A' : 'Set treasury'}
            color={kpis.runway === Infinity ? 'text-green1' : kpis.runway > 6 ? 'text-lavender' : 'text-red-400'}
            sub={settings.treasuryBalance > 0 ? `Treasury: ${formatCurrency(settings.treasuryBalance)}` : undefined}
          />
        </div>

        {/* Scenario Assumptions */}
        <div className="flagship-card rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Scenario Assumptions</h3>
          <p className="text-sm text-soft-gray mb-5 relative z-10">
            Adjust the assumptions below — the projected revenue chart and table update in real time.
            Growth compounds month-over-month on buy pressure and LP fees.
          </p>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6 relative z-10">
            <div>
              <label className="text-xs text-soft-gray block mb-1">Monthly Buy Pressure ($)</label>
              <input type="number" value={assumptions.monthlyBuyPressure || ''} onChange={e => setAssumption('monthlyBuyPressure', parseFloat(e.target.value) || 0)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Fee Capture Rate (%)</label>
              <input type="number" value={assumptions.feeCaptureRate || ''} step="0.1" onChange={e => setAssumption('feeCaptureRate', parseFloat(e.target.value) || 0)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Monthly LINGO Sold</label>
              <input type="number" value={assumptions.monthlySellAmount || ''} onChange={e => setAssumption('monthlySellAmount', parseFloat(e.target.value) || 0)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">LINGO Price ($)</label>
              <input type="number" value={assumptions.lingoPrice || ''} step="0.001" onChange={e => setAssumption('lingoPrice', parseFloat(e.target.value) || 0)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">LP Fees / Month ($)</label>
              <input type="number" value={assumptions.lpFeesMonthly || ''} onChange={e => setAssumption('lpFeesMonthly', parseFloat(e.target.value) || 0)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">MoM Growth (%)</label>
              <input type="number" value={assumptions.growthRatePct || ''} step="0.5" onChange={e => setAssumption('growthRatePct', parseFloat(e.target.value) || 0)}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
          </div>

          {/* Scenario KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6 relative z-10">
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">Projected Total Revenue</span>
              <div className="text-lg font-bold text-green1 mt-0.5">{formatCurrency(scenarioTotals.totalRevenue)}</div>
              <span className="text-[10px] text-soft-gray/50">remaining months</span>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">From Trading Fees</span>
              <div className="text-lg font-bold text-lavender mt-0.5">{formatCurrency(scenarioTotals.totalTradingFees)}</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">From Token Sales</span>
              <div className="text-lg font-bold text-lavender mt-0.5">{formatCurrency(scenarioTotals.totalSellRevenue)}</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">From LP Fees</span>
              <div className="text-lg font-bold text-lavender mt-0.5">{formatCurrency(scenarioTotals.totalLpFees)}</div>
            </div>
          </div>

          {/* Scenario Chart */}
          <div className="relative z-10" style={{ height: 300 }}>
            <ResponsiveContainer minWidth={0} width="100%" height={300}>
              <BarChart data={scenarioData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
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
                <Legend wrapperStyle={{ paddingTop: 10 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                <Bar dataKey="tradingFees" name="Trading Fees" stackId="rev" fill="#5EB851" />
                <Bar dataKey="sellRevenue" name="Token Sales" stackId="rev" fill="#E8B100" />
                <Bar dataKey="lpFees" name="LP Fees" stackId="rev" fill="#7B68AE" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>

          {/* Scenario Table */}
          <div className="overflow-x-auto mt-4 relative z-10">
            <table className="w-full text-sm">
              <thead style={{ background: 'rgba(20, 20, 31, 0.95)' }}>
                <tr className="border-b border-white/5">
                  <th className="text-left text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Month</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase tracking-wider py-3 px-4">Buy Pressure</th>
                  <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4">Trading Fees</th>
                  <th className="text-right text-xs font-medium text-[#E8B100]/80 uppercase tracking-wider py-3 px-4">Token Sales</th>
                  <th className="text-right text-xs font-medium text-purple/80 uppercase tracking-wider py-3 px-4">LP Fees</th>
                  <th className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">Total Revenue</th>
                </tr>
              </thead>
              <tbody>
                {scenarioData.map(m => (
                  <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="py-2.5 px-4 text-lavender font-medium">{m.label}</td>
                    <td className="py-2.5 px-4 text-right text-soft-gray">{formatCurrency(m.buyPressure)}</td>
                    <td className="py-2.5 px-4 text-right text-green1">{formatCurrency(m.tradingFees)}</td>
                    <td className="py-2.5 px-4 text-right text-[#E8B100]">{formatCurrency(m.sellRevenue)}</td>
                    <td className="py-2.5 px-4 text-right text-purple">{formatCurrency(m.lpFees)}</td>
                    <td className="py-2.5 px-4 text-right text-lavender font-medium border-l border-white/5">{formatCurrency(m.totalRevenue)}</td>
                  </tr>
                ))}
                <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                  <td className="py-2.5 px-4 text-lavender font-bold">Total</td>
                  <td className="py-2.5 px-4 text-right text-soft-gray font-bold">{formatCurrency(scenarioData.reduce((s, m) => s + m.buyPressure, 0))}</td>
                  <td className="py-2.5 px-4 text-right text-green1 font-bold">{formatCurrency(scenarioTotals.totalTradingFees)}</td>
                  <td className="py-2.5 px-4 text-right text-[#E8B100] font-bold">{formatCurrency(scenarioTotals.totalSellRevenue)}</td>
                  <td className="py-2.5 px-4 text-right text-purple font-bold">{formatCurrency(scenarioTotals.totalLpFees)}</td>
                  <td className="py-2.5 px-4 text-right text-lavender font-bold border-l border-white/5">{formatCurrency(scenarioTotals.totalRevenue)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Interactive Monthly Projections */}
        <ProjectionsTable projections={projections} setProjections={setProjections} onEdit={() => setHasEdited(true)} />

        {/* Annual Projection */}
        <div className="flagship-card rounded-2xl p-6">
          <div className="flex items-start justify-between mb-4 relative z-10">
            <div>
              <h3 className="text-lg font-semibold text-lavender">{projection.year} Annual Projection</h3>
              <p className="text-sm text-soft-gray mt-1">
                {projection.completedMonths} months completed &bull; Run rate extrapolation
                {projection.breakEvenMonth && projection.breakEvenMonth !== 'Already profitable' && (
                  <span className="text-green1 ml-2">Break-even: {monthLabel(projection.breakEvenMonth)}</span>
                )}
                {projection.breakEvenMonth === 'Already profitable' && (
                  <span className="text-green1 ml-2">Already profitable</span>
                )}
              </p>
            </div>
          </div>

          {/* Projection summary cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-5 relative z-10">
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">YTD Revenue</span>
              <div className="text-lg font-bold text-green1 mt-0.5">{formatCurrency(projection.ytdRevenue)}</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">Projected Full Year</span>
              <div className="text-lg font-bold text-lavender mt-0.5">{formatCurrency(projection.projectedRevenue)}</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">Projected Expenses</span>
              <div className="text-lg font-bold text-red-400 mt-0.5">{formatCurrency(projection.projectedExpenses)}</div>
            </div>
            <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl px-4 py-3 text-center">
              <span className="text-xs text-soft-gray">Projected Net P&L</span>
              <div className={`text-lg font-bold mt-0.5 ${projection.projectedNet >= 0 ? 'text-green1' : 'text-red-400'}`}>{formatCurrency(projection.projectedNet)}</div>
            </div>
          </div>

          {/* Projection chart */}
          <div className="relative z-10" style={{ height: 280 }}>
            <ResponsiveContainer minWidth={0} width="100%" height={280}>
              <BarChart data={projection.projData} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={65} />
                <Tooltip content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null;
                  return (
                    <div className="custom-tooltip">
                      <p className="text-soft-gray text-xs mb-1">{label}</p>
                      {payload.filter(e => e.value != null).map((e, i) => (
                        <div key={i} className="flex items-center gap-2 mb-1">
                          <div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} />
                          <span className="text-soft-gray text-sm">{e.name}:</span>
                          <span className="text-lavender font-medium">{formatCurrency(e.value as number)}</span>
                        </div>
                      ))}
                    </div>
                  );
                }} />
                <Legend wrapperStyle={{ paddingTop: 10 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                <Bar dataKey="actual" name="Actual" fill="#5EB851" radius={[4, 4, 0, 0]} />
                <Bar dataKey="projected" name="Projected" fill="#5EB851" fillOpacity={0.3} radius={[4, 4, 0, 0]} />
                {settings.annualRevenueTarget > 0 && (
                  <ReferenceLine y={Math.round(settings.annualRevenueTarget / 12)} stroke="#E8B100" strokeDasharray="6 3" label={{ value: 'Target', position: 'right', fill: '#E8B100', fontSize: 11 }} />
                )}
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Budget vs Actual */}
        {budgetVsActual.length > 0 && (
          <div className="flagship-card rounded-2xl p-6">
            <h3 className="text-lg font-semibold text-lavender mb-1 relative z-10">Budget vs Actual</h3>
            <p className="text-sm text-soft-gray mb-4 relative z-10">Monthly expense budget vs actual spending</p>
            <div className="relative z-10" style={{ height: 280 }}>
              <ResponsiveContainer minWidth={0} width="100%" height={280}>
                <BarChart data={budgetVsActual} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="25%">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
                  <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                  <YAxis tickFormatter={fmtUsd} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={65} />
                  <Tooltip content={({ active, payload, label }) => {
                    if (!active || !payload?.length) return null;
                    const bud = (payload.find(p => p.dataKey === 'budget')?.value ?? 0) as number;
                    const act = (payload.find(p => p.dataKey === 'actual')?.value ?? 0) as number;
                    const variance = bud - act;
                    return (
                      <div className="custom-tooltip">
                        <p className="text-soft-gray text-xs mb-2">{label}</p>
                        <p className="text-soft-gray text-sm">Budget: <span className="text-lavender font-medium">{formatCurrency(bud)}</span></p>
                        <p className="text-soft-gray text-sm">Actual: <span className="text-lavender font-medium">{formatCurrency(act)}</span></p>
                        <p className={`text-sm font-medium ${variance >= 0 ? 'text-green1' : 'text-red-400'}`}>
                          {variance >= 0 ? 'Under budget' : 'Over budget'}: {formatCurrency(Math.abs(variance))}
                        </p>
                      </div>
                    );
                  }} />
                  <Legend wrapperStyle={{ paddingTop: 10 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                  <Bar dataKey="budget" name="Budget" fill="#3B82F6" fillOpacity={0.4} radius={[4, 4, 0, 0]} />
                  <Bar dataKey="actual" name="Actual" fill="#E85757" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

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
                  return (<div className="custom-tooltip"><p className="text-soft-gray text-xs mb-1">{label}</p><p className={`font-semibold ${v >= 0 ? 'text-green1' : 'text-red-400'}`}>{formatCurrency(v)}</p></div>);
                }} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" />
                <Bar dataKey="net" radius={[4, 4, 0, 0]} animationDuration={800}>
                  {netTrendData.map((entry, i) => (<Cell key={i} fill={entry.net >= 0 ? '#5EB851' : '#E85757'} fillOpacity={0.8} />))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Revenue & Expense Charts */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
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
                    return (<div className="custom-tooltip"><p className="text-soft-gray text-xs mb-2">{label}</p>
                      {payload.map((e, i) => (<div key={i} className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} /><span className="text-soft-gray text-sm">{e.name}:</span><span className="text-lavender font-medium">{formatCurrency(e.value as number)}</span></div>))}
                    </div>);
                  }} />
                  <Legend wrapperStyle={{ paddingTop: 15 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                  <Bar dataKey="tradingFees" name="Trading Fees" stackId="rev" fill={REVENUE_COLORS.tradingFees} />
                  <Bar dataKey="lpFees" name="LP Fees" stackId="rev" fill={REVENUE_COLORS.lpFees} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

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
                      return (<div className="custom-tooltip"><p className="text-soft-gray text-xs mb-2">{label}</p>
                        {payload.filter(e => (e.value as number) > 0).map((e, i) => (<div key={i} className="flex items-center gap-2 mb-1"><div className="w-2 h-2 rounded-full" style={{ backgroundColor: e.color }} /><span className="text-soft-gray text-sm">{e.name}:</span><span className="text-lavender font-medium">{formatCurrency(e.value as number)}</span></div>))}
                      </div>);
                    }} />
                    <Legend wrapperStyle={{ paddingTop: 15 }} formatter={v => <span className="text-soft-gray text-sm">{v}</span>} />
                    {EXPENSE_CATEGORIES.map(cat => (<Bar key={cat} dataKey={cat} name={cat} stackId="exp" fill={EXPENSE_COLORS[cat]} />))}
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
                  <th className="text-right text-xs font-medium text-green1/80 uppercase tracking-wider py-3 px-4 border-l border-white/5">Revenue</th>
                  <th className="text-right text-xs font-medium text-red-400/80 uppercase tracking-wider py-3 px-4 border-l border-white/5">Expenses</th>
                  {budgets.length > 0 && <th className="text-right text-xs font-medium text-blue-400/80 uppercase tracking-wider py-3 px-4">Budget</th>}
                  <th className="text-right text-xs font-medium text-lavender uppercase tracking-wider py-3 px-4 border-l border-white/5">Net P&L</th>
                </tr>
              </thead>
              <tbody>
                {[...monthlyData].reverse().map(m => (
                  <tr key={m.month} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="py-3 px-4 text-lavender font-medium sticky left-0 bg-[#14141f]">{m.label}</td>
                    <td className="py-3 px-4 text-right text-soft-gray">{formatCurrency(m.tradingFees)}</td>
                    <td className="py-3 px-4 text-right text-soft-gray">{formatCurrency(m.lpFees)}</td>
                    <td className="py-3 px-4 text-right text-green1 font-medium border-l border-white/5">{formatCurrency(m.totalRevenue)}</td>
                    <td className="py-3 px-4 text-right text-red-400 border-l border-white/5">{m.totalExpenses > 0 ? formatCurrency(m.totalExpenses) : '—'}</td>
                    {budgets.length > 0 && (
                      <td className="py-3 px-4 text-right text-blue-400">{m.totalBudget > 0 ? formatCurrency(m.totalBudget) : '—'}</td>
                    )}
                    <td className={`py-3 px-4 text-right font-semibold border-l border-white/5 ${m.netPnL >= 0 ? 'text-green1' : 'text-red-400'}`}>{formatCurrency(m.netPnL)}</td>
                  </tr>
                ))}
                {monthlyData.length > 0 && (
                  <tr className="border-t-2 border-white/10 bg-white/[0.02]">
                    <td className="py-3 px-4 text-lavender font-bold sticky left-0 bg-[#1a1a2e]">Total</td>
                    <td className="py-3 px-4 text-right text-lavender font-semibold">{formatCurrency(monthlyData.reduce((s, m) => s + m.tradingFees, 0))}</td>
                    <td className="py-3 px-4 text-right text-lavender font-semibold">{formatCurrency(monthlyData.reduce((s, m) => s + m.lpFees, 0))}</td>
                    <td className="py-3 px-4 text-right text-green1 font-bold border-l border-white/5">{formatCurrency(kpis.totalRev)}</td>
                    <td className="py-3 px-4 text-right text-red-400 font-bold border-l border-white/5">{kpis.totalExp > 0 ? formatCurrency(kpis.totalExp) : '—'}</td>
                    {budgets.length > 0 && <td className="py-3 px-4 text-right text-blue-400 font-bold">{formatCurrency(monthlyData.reduce((s, m) => s + m.totalBudget, 0))}</td>}
                    <td className={`py-3 px-4 text-right font-bold border-l border-white/5 ${kpis.net >= 0 ? 'text-green1' : 'text-red-400'}`}>{formatCurrency(kpis.net)}</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Settings: Treasury & Annual Targets */}
        <div className="flagship-card rounded-2xl p-6">
          <h3 className="text-lg font-semibold text-lavender mb-4 relative z-10">Settings & Targets</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 relative z-10">
            <div>
              <label className="text-xs text-soft-gray block mb-1">Treasury Balance (USD)</label>
              <input type="number" value={settings.treasuryBalance || ''} onChange={e => { setSettings(p => ({ ...p, treasuryBalance: parseFloat(e.target.value) || 0 })); setHasEdited(true); }}
                placeholder="e.g. 500000" min="0"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
              <p className="text-xs text-soft-gray/50 mt-1">Used for runway calculation</p>
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Annual Revenue Target (USD)</label>
              <input type="number" value={settings.annualRevenueTarget || ''} onChange={e => { setSettings(p => ({ ...p, annualRevenueTarget: parseFloat(e.target.value) || 0 })); setHasEdited(true); }}
                placeholder="e.g. 2000000" min="0"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
              <p className="text-xs text-soft-gray/50 mt-1">Shows as target line on projection chart</p>
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Annual Expense Target (USD)</label>
              <input type="number" value={settings.annualExpenseTarget || ''} onChange={e => { setSettings(p => ({ ...p, annualExpenseTarget: parseFloat(e.target.value) || 0 })); setHasEdited(true); }}
                placeholder="e.g. 1000000" min="0"
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
              <p className="text-xs text-soft-gray/50 mt-1">Annual expense budget cap</p>
            </div>
          </div>
        </div>

        {/* Manage Expenses & Budgets */}
        <div className="flagship-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-6 relative z-10">
            <div>
              <h3 className="text-lg font-semibold text-lavender">Manage Expenses & Budgets</h3>
              <p className="text-sm text-soft-gray mt-1">Add expense actuals or budget targets per month</p>
            </div>
            <div className="flex items-center gap-2">
              {saveMsg && <span className={`text-xs ${saveMsg === 'Saved!' ? 'text-green1' : 'text-red-400'}`}>{saveMsg}</span>}
              <button onClick={handleSave} disabled={saving}
                className="flex items-center gap-1.5 px-4 py-2 bg-purple/20 hover:bg-purple/30 text-lavender text-sm font-medium rounded-xl border border-purple/30 transition-colors disabled:opacity-50">
                {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}{saving ? 'Saving...' : 'Save Now'}
              </button>
            </div>
          </div>

          {/* Form */}
          <div className="flex flex-wrap items-end gap-3 mb-6 relative z-10">
            <div>
              <label className="text-xs text-soft-gray block mb-1">Type</label>
              <select value={formType} onChange={e => setFormType(e.target.value as 'expense' | 'budget')}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50">
                <option value="expense">Expense</option>
                <option value="budget">Budget</option>
              </select>
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Month</label>
              <input type="month" value={formMonth} onChange={e => setFormMonth(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Category</label>
              <select value={formCategory} onChange={e => setFormCategory(e.target.value as ExpenseCategory)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50">
                {EXPENSE_CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Amount (USD)</label>
              <input type="number" value={formAmount} onChange={e => setFormAmount(e.target.value)} placeholder="0.00" min="0" step="0.01"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-32 focus:outline-none focus:border-purple/50" />
            </div>
            {formType === 'expense' && (
              <div className="flex-1 min-w-[150px]">
                <label className="text-xs text-soft-gray block mb-1">Note (optional)</label>
                <input type="text" value={formNote} onChange={e => setFormNote(e.target.value)} placeholder="e.g. Q1 bonus"
                  className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-full focus:outline-none focus:border-purple/50" />
              </div>
            )}
            <button onClick={handleAddEntry}
              className="flex items-center gap-1.5 px-4 py-2 bg-green1/20 hover:bg-green1/30 text-green1 text-sm font-medium rounded-lg border border-green1/30 transition-colors">
              <Plus className="w-4 h-4" />Add
            </button>
          </div>

          {/* Expense entries */}
          {expenses.length > 0 && (
            <div className="mb-4 relative z-10">
              <h4 className="text-sm font-medium text-lavender mb-2">Expenses</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Month</th>
                    <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Category</th>
                    <th className="text-right text-xs font-medium text-soft-gray uppercase py-2 px-3">Amount</th>
                    <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Note</th>
                    <th className="py-2 px-3 w-10"></th>
                  </tr></thead>
                  <tbody>
                    {[...expenses].sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category)).map((e, i) => (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-2 px-3 text-lavender">{monthLabel(e.month)}</td>
                        <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-md" style={{ backgroundColor: `${EXPENSE_COLORS[e.category] ?? '#666'}20`, color: EXPENSE_COLORS[e.category] ?? '#999' }}>{e.category}</span></td>
                        <td className="py-2 px-3 text-right text-soft-gray">{formatCurrency(e.amount)}</td>
                        <td className="py-2 px-3 text-soft-gray/60 text-xs">{e.note || '—'}</td>
                        <td className="py-2 px-3"><button onClick={() => handleDeleteExpense(e.month, e.category)} className="text-soft-gray/30 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Budget entries */}
          {budgets.length > 0 && (
            <div className="relative z-10">
              <h4 className="text-sm font-medium text-blue-400 mb-2">Budgets</h4>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="border-b border-white/5">
                    <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Month</th>
                    <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Category</th>
                    <th className="text-right text-xs font-medium text-soft-gray uppercase py-2 px-3">Budget</th>
                    <th className="py-2 px-3 w-10"></th>
                  </tr></thead>
                  <tbody>
                    {[...budgets].sort((a, b) => b.month.localeCompare(a.month) || a.category.localeCompare(b.category)).map((b, i) => (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-2 px-3 text-lavender">{monthLabel(b.month)}</td>
                        <td className="py-2 px-3"><span className="text-xs px-2 py-0.5 rounded-md bg-blue-400/10 text-blue-400">{b.category}</span></td>
                        <td className="py-2 px-3 text-right text-blue-400">{formatCurrency(b.budget)}</td>
                        <td className="py-2 px-3"><button onClick={() => handleDeleteBudget(b.month, b.category)} className="text-soft-gray/30 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {expenses.length === 0 && budgets.length === 0 && expensesLoaded && (
            <p className="text-sm text-soft-gray/50 text-center py-6 relative z-10">No entries yet. Use the form above to add expenses or budgets.</p>
          )}
        </div>

        {/* Team Expenses */}
        <div className="flagship-card rounded-2xl p-6">
          <div className="flex items-center justify-between mb-6 relative z-10">
            <div>
              <h3 className="text-lg font-semibold text-lavender">Team Expenses</h3>
              <p className="text-sm text-soft-gray mt-1">
                Individual team members — auto-generates monthly "Team Compensation" expenses
              </p>
            </div>
            <div className="text-right relative z-10">
              <p className="text-xs text-soft-gray">Monthly team cost</p>
              <p className="text-lg font-bold text-red-400">
                {formatCurrency(team.reduce((s, m) => {
                  const now = currentYM();
                  if (m.startMonth > now) return s;
                  if (m.endMonth && m.endMonth < now) return s;
                  return s + m.monthlySalary;
                }, 0))}
              </p>
            </div>
          </div>

          {/* Add team member form */}
          <div className="flex flex-wrap items-end gap-3 mb-6 relative z-10">
            <div>
              <label className="text-xs text-soft-gray block mb-1">Name</label>
              <input type="text" value={teamName} onChange={e => setTeamName(e.target.value)} placeholder="e.g. John"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-36 focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Role</label>
              <input type="text" value={teamRole} onChange={e => setTeamRole(e.target.value)} placeholder="e.g. Dev"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-32 focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Monthly Salary (USD)</label>
              <input type="number" value={teamSalary} onChange={e => setTeamSalary(e.target.value)} placeholder="0" min="0"
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender w-32 focus:outline-none focus:border-purple/50" />
            </div>
            <div>
              <label className="text-xs text-soft-gray block mb-1">Start Month</label>
              <input type="month" value={teamStart} onChange={e => setTeamStart(e.target.value)}
                className="bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-lavender focus:outline-none focus:border-purple/50" />
            </div>
            <button onClick={handleAddTeamMember}
              className="flex items-center gap-1.5 px-4 py-2 bg-green1/20 hover:bg-green1/30 text-green1 text-sm font-medium rounded-lg border border-green1/30 transition-colors">
              <Plus className="w-4 h-4" />Add Member
            </button>
          </div>

          {/* Team members table */}
          {team.length > 0 && (
            <div className="overflow-x-auto relative z-10">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-white/5">
                  <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Name</th>
                  <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Role</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase py-2 px-3">Monthly Salary</th>
                  <th className="text-left text-xs font-medium text-soft-gray uppercase py-2 px-3">Since</th>
                  <th className="text-right text-xs font-medium text-soft-gray uppercase py-2 px-3">Total Cost</th>
                  <th className="py-2 px-3 w-10"></th>
                </tr></thead>
                <tbody>
                  {team.map((m, i) => {
                    // Count active months
                    const end = m.endMonth || currentYM();
                    const [sy, sm] = m.startMonth.split('-').map(Number);
                    const [ey, em] = end.split('-').map(Number);
                    const activeMonths = Math.max(0, (ey - sy) * 12 + (em - sm) + 1);
                    return (
                      <tr key={i} className="border-b border-white/5 hover:bg-white/[0.02]">
                        <td className="py-2 px-3 text-lavender font-medium">{m.name}</td>
                        <td className="py-2 px-3 text-soft-gray">{m.role || '—'}</td>
                        <td className="py-2 px-3 text-right text-red-400">{formatCurrency(m.monthlySalary)}</td>
                        <td className="py-2 px-3 text-soft-gray text-xs">{monthLabel(m.startMonth)}{m.endMonth ? ` → ${monthLabel(m.endMonth)}` : ' → Present'}</td>
                        <td className="py-2 px-3 text-right text-lavender font-medium">{formatCurrency(m.monthlySalary * activeMonths)}</td>
                        <td className="py-2 px-3"><button onClick={() => handleDeleteTeamMember(i)} className="text-soft-gray/30 hover:text-red-400 transition-colors"><Trash2 className="w-3.5 h-3.5" /></button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {team.length === 0 && (
            <p className="text-sm text-soft-gray/50 text-center py-6 relative z-10">No team members added. Add members above — their salaries will auto-populate monthly Team Compensation expenses.</p>
          )}
        </div>
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
  onEdit: () => void; // trigger auto-save
}

function generateMonthRange(): string[] {
  const now = new Date();
  const months: string[] = [];
  for (let m = now.getMonth(); m < 12; m++) {
    months.push(`${now.getFullYear()}-${String(m + 1).padStart(2, '0')}`);
  }
  return months;
}

function ProjectionsTable({ projections, setProjections, onEdit }: ProjectionsTableProps) {
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null);
  const months = useMemo(generateMonthRange, []);

  // Check if a month has its own saved data (was explicitly edited)
  const hasOwnData = (month: string): boolean => {
    return projections.some(p => p.month === month);
  };

  // Get effective projection: own data if exists, otherwise inherit from previous month
  const getEffective = useMemo(() => {
    const cache = new Map<string, MonthProjection>();

    return (month: string): MonthProjection => {
      if (cache.has(month)) return cache.get(month)!;

      // If this month has explicit data, use it
      const own = projections.find(p => p.month === month);
      if (own) {
        cache.set(month, own);
        return own;
      }

      // Otherwise, inherit from the previous month in the range
      const idx = months.indexOf(month);
      if (idx <= 0) {
        const empty = { month, revenueItems: [], expenseItems: [] };
        cache.set(month, empty);
        return empty;
      }

      // Deep-clone previous month's data with this month's key
      const prev = getEffective(months[idx - 1]);
      const inherited: MonthProjection = {
        month,
        revenueItems: prev.revenueItems.map(i => ({ ...i })),
        expenseItems: prev.expenseItems.map(i => ({ ...i })),
      };
      cache.set(month, inherited);
      return inherited;
    };
  }, [projections, months]);

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

  // Calculate totals for the summary row
  const monthTotals = months.map(m => {
    const proj = getEffective(m);
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
              const proj = getEffective(m.month);
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
                            {proj.revenueItems.length === 0 && (
                              <p className="text-xs text-soft-gray/40 py-2">No revenue items — click Add</p>
                            )}
                            {proj.revenueItems.map((item, idx) => (
                              <div key={idx} className="flex items-center gap-2 mb-2">
                                <input
                                  type="text" value={item.label}
                                  onChange={e => updateLineItem(m.month, 'revenue', idx, 'label', e.target.value)}
                                  placeholder="e.g. Trading Fees"
                                  className="flex-1 bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-1.5 text-xs text-lavender focus:outline-none focus:border-green1/50"
                                  onClick={e => e.stopPropagation()}
                                />
                                <div className="relative">
                                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-soft-gray">$</span>
                                  <input
                                    type="number" value={item.amount || ''}
                                    onChange={e => updateLineItem(m.month, 'revenue', idx, 'amount', e.target.value)}
                                    placeholder="0"
                                    className="w-28 bg-white/[0.04] border border-white/[0.08] rounded-lg pl-5 pr-2 py-1.5 text-xs text-lavender text-right focus:outline-none focus:border-green1/50"
                                    onClick={e => e.stopPropagation()}
                                  />
                                </div>
                                <button onClick={(e) => { e.stopPropagation(); removeLineItem(m.month, 'revenue', idx); }}
                                  className="text-soft-gray/30 hover:text-red-400 transition-colors">
                                  <Trash2 className="w-3 h-3" />
                                </button>
                              </div>
                            ))}
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
