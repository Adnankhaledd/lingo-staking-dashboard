import { useState, useCallback } from 'react';
import { RefreshCw, ArrowLeft, Database, Trash2, CheckCircle, XCircle, Loader2, List, ExternalLink } from 'lucide-react';
import lingoLogo from '../assets/logo-lingo.svg';
import { clearDuneCache } from '../hooks/useDuneQuery';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';
const SESSION_KEY = 'admin_password';

interface RefreshResult {
  message?: string;
  error?: string;
  refreshedAt?: string;
  newSuccessCount?: number;
  totalSuccessCount?: number;
  successCount?: number;
  blobUrl?: string;
  kept?: boolean;
}

export function Admin() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(SESSION_KEY) || '');
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!sessionStorage.getItem(SESSION_KEY));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isRefreshingMixpanel, setIsRefreshingMixpanel] = useState(false);
  const [result, setResult] = useState<RefreshResult | null>(null);
  const [mixpanelResult, setMixpanelResult] = useState<RefreshResult | null>(null);
  const [cacheCleared, setCacheCleared] = useState(false);

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
    setResult(null);
  };

  const handleRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setResult(null);

    try {
      const storedPassword = sessionStorage.getItem(SESSION_KEY) || '';
      const response = await fetch(`${API_BASE}/api/refresh-dune`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Password': storedPassword,
        },
      });

      const data: RefreshResult = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          sessionStorage.removeItem(SESSION_KEY);
          setIsAuthenticated(false);
          setResult({ error: 'Wrong password. Please log in again.' });
        } else {
          setResult(data);
        }
      } else {
        // Success — reset Dune in-memory cache so dashboard picks up fresh data
        clearDuneCache();
        setResult(data);
      }
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const handleRefreshMixpanel = useCallback(async () => {
    setIsRefreshingMixpanel(true);
    setMixpanelResult(null);

    try {
      const storedPassword = sessionStorage.getItem(SESSION_KEY) || '';
      const response = await fetch(`${API_BASE}/api/refresh-mixpanel`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Password': storedPassword,
        },
      });

      const data: RefreshResult = await response.json();

      if (!response.ok) {
        if (response.status === 401) {
          sessionStorage.removeItem(SESSION_KEY);
          setIsAuthenticated(false);
          setMixpanelResult({ error: 'Wrong password. Please log in again.' });
        } else {
          setMixpanelResult(data);
        }
      } else {
        setMixpanelResult(data);
      }
    } catch (err) {
      setMixpanelResult({ error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setIsRefreshingMixpanel(false);
    }
  }, []);

  const handleClearDuneCache = () => {
    clearDuneCache();
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 3000);
  };

  // Login screen
  if (!isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="fixed inset-0 overflow-hidden pointer-events-none">
          <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple/6 rounded-full blur-[150px]" />
          <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-sosiska/5 rounded-full blur-[150px]" />
        </div>

        <form onSubmit={handleLogin} className="relative glass-card rounded-2xl p-8 w-full max-w-sm">
          <div className="flex items-center gap-3 mb-6">
            <img src={lingoLogo} alt="Lingo" className="h-6" />
            <span className="text-lg font-semibold text-lavender">Admin</span>
          </div>

          <label className="block text-sm text-soft-gray mb-2">Password</label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-xl px-4 py-3 text-lavender placeholder-purple-gray focus:outline-none focus:border-purple/50 transition-colors"
            placeholder="Enter admin password"
            autoFocus
          />

          <button
            type="submit"
            className="w-full mt-4 bg-purple/20 hover:bg-purple/30 text-lavender font-medium py-3 rounded-xl transition-colors"
          >
            Log In
          </button>

          {result?.error && (
            <p className="mt-3 text-sm text-red-400">{result.error}</p>
          )}

          <a href="/" className="flex items-center gap-1.5 mt-4 text-xs text-purple-gray hover:text-soft-gray transition-colors">
            <ArrowLeft className="w-3 h-3" />
            Back to Dashboard
          </a>
        </form>
      </div>
    );
  }

  // Admin panel
  return (
    <div className="min-h-screen bg-background">
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-20%] left-[-10%] w-[600px] h-[600px] bg-purple/6 rounded-full blur-[150px]" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[500px] h-[500px] bg-sosiska/5 rounded-full blur-[150px]" />
      </div>

      <div className="relative w-full max-w-2xl mx-auto px-6 py-10">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div className="flex items-center gap-3">
            <img src={lingoLogo} alt="Lingo" className="h-6" />
            <span className="text-lg font-semibold text-lavender">Admin Panel</span>
          </div>
          <div className="flex items-center gap-3">
            <a
              href="/"
              className="flex items-center gap-1.5 text-sm text-soft-gray hover:text-lavender transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              Dashboard
            </a>
            <button
              onClick={handleLogout}
              className="text-sm text-purple-gray hover:text-red-400 transition-colors"
            >
              Logout
            </button>
          </div>
        </div>

        {/* Dune Refresh */}
        <section className="glass-card rounded-2xl p-6 mb-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-purple/10 flex items-center justify-center">
              <Database className="w-5 h-5 text-purple" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-lavender">Dune Analytics Data</h2>
              <p className="text-xs text-purple-gray">Auto-refreshes daily at 6:00 AM UTC via cron</p>
            </div>
          </div>

          <button
            onClick={handleRefresh}
            disabled={isRefreshing}
            className="w-full flex items-center justify-center gap-2 bg-purple/20 hover:bg-purple/30 disabled:opacity-50 disabled:cursor-not-allowed text-lavender font-medium py-3 rounded-xl transition-colors"
          >
            {isRefreshing ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Refreshing all 16 queries...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Refresh Dune Data Now
              </>
            )}
          </button>

          {/* Result */}
          {result && (
            <div className={`mt-4 p-4 rounded-xl border ${
              result.error
                ? 'bg-red-400/5 border-red-400/20'
                : 'bg-green1/5 border-green1/20'
            }`}>
              <div className="flex items-start gap-2">
                {result.error ? (
                  <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle className="w-4 h-4 text-green1 mt-0.5 shrink-0" />
                )}
                <div className="text-sm">
                  {result.error ? (
                    <p className="text-red-400">{result.error}</p>
                  ) : (
                    <>
                      <p className="text-green1 font-medium">{result.message}</p>
                      <p className="text-purple-gray mt-1">Caches cleared — reload dashboard to see fresh data.</p>
                      {result.refreshedAt && (
                        <p className="text-purple-gray">
                          Refreshed at: {new Date(result.refreshedAt).toLocaleString()}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Mixpanel Refresh */}
        <section className="glass-card rounded-2xl p-6 mb-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-green1/10 flex items-center justify-center">
              <Database className="w-5 h-5 text-green1" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-lavender">Mixpanel Data</h2>
              <p className="text-xs text-purple-gray">Auto-refreshes daily at 6:05 AM UTC via cron</p>
            </div>
          </div>

          <button
            onClick={handleRefreshMixpanel}
            disabled={isRefreshingMixpanel}
            className="w-full flex items-center justify-center gap-2 bg-green1/20 hover:bg-green1/30 disabled:opacity-50 disabled:cursor-not-allowed text-lavender font-medium py-3 rounded-xl transition-colors"
          >
            {isRefreshingMixpanel ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                Refreshing Mixpanel data...
              </>
            ) : (
              <>
                <RefreshCw className="w-4 h-4" />
                Refresh Mixpanel Data Now
              </>
            )}
          </button>

          {mixpanelResult && (
            <div className={`mt-4 p-4 rounded-xl border ${
              mixpanelResult.error
                ? 'bg-red-400/5 border-red-400/20'
                : 'bg-green1/5 border-green1/20'
            }`}>
              <div className="flex items-start gap-2">
                {mixpanelResult.error ? (
                  <XCircle className="w-4 h-4 text-red-400 mt-0.5 shrink-0" />
                ) : (
                  <CheckCircle className="w-4 h-4 text-green1 mt-0.5 shrink-0" />
                )}
                <div className="text-sm">
                  {mixpanelResult.error ? (
                    <p className="text-red-400">{mixpanelResult.error}</p>
                  ) : (
                    <>
                      <p className="text-green1 font-medium">{mixpanelResult.message}</p>
                      <p className="text-purple-gray mt-1">Reload dashboard to see fresh data.</p>
                      {mixpanelResult.refreshedAt && (
                        <p className="text-purple-gray">
                          Refreshed at: {new Date(mixpanelResult.refreshedAt).toLocaleString()}
                        </p>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          )}
        </section>

        {/* Cache Management */}
        <section className="glass-card rounded-2xl p-6">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-orange1/10 flex items-center justify-center">
              <Trash2 className="w-5 h-5 text-orange1" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-lavender">Clear Browser Cache</h2>
              <p className="text-xs text-purple-gray">Force fresh data on next page load (this browser only)</p>
            </div>
          </div>

          <button
            onClick={handleClearDuneCache}
            className="w-full flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-soft-gray font-medium py-3 rounded-xl transition-colors text-sm"
          >
            Clear Dune In-Memory Cache
          </button>

          {cacheCleared && (
            <p className="mt-3 text-xs text-green1 flex items-center gap-1.5">
              <CheckCircle className="w-3 h-3" />
              Cache cleared! Reload the dashboard to fetch fresh data.
            </p>
          )}
        </section>

        {/* Dune Query Reference */}
        <section className="glass-card rounded-2xl p-6 mt-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-purple/10 flex items-center justify-center">
              <List className="w-5 h-5 text-purple" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-lavender">Dune Query Reference</h2>
              <p className="text-xs text-purple-gray">16 queries &middot; Click ID to open on Dune</p>
            </div>
          </div>

          <div className="space-y-0.5">
            {[
              { id: '6590984', name: 'TOTAL_STAKED_TREND', section: 'Hero card — Total LINGO Staked trend' },
              { id: '6534908', name: 'WEEKLY_STATS', section: 'Hero card — Active Stakers & TVL' },
              { id: '6535206', name: 'WEEKLY_NEW_STAKERS', section: 'Overview — New Stakers per Week' },
              { id: '6528806', name: 'COHORT_RETENTION', section: 'Retention — Cohort Retention Heatmap' },
              { id: '6560698', name: 'STAKING_TIERS', section: 'Staking Tiers breakdown (unused)' },
              { id: '6543709', name: 'UNLOCK_SCHEDULE', section: 'Unlock Schedule timeline (unused)' },
              { id: '6632385', name: 'TOP_STAKERS', section: 'Top Stakers — Top 50 leaderboard' },
              { id: '6288543', name: 'TRADING_FEES', section: 'Revenue — Monthly Trading Fees' },
              { id: '6606898', name: 'APY_CLAIMS', section: 'Revenue — Monthly APY Claims' },
              { id: '6535334', name: 'MONTHLY_STAKING_FLOW', section: 'Staking — Monthly Stake/Unstake Flow' },
              { id: '6693660', name: 'WEEKLY_STAKES', section: 'Staking — Weekly Stake Events' },
              { id: '6693715', name: 'LP_FEES', section: 'Revenue — LP Fees (hero card)' },
              { id: '6708293', name: 'MEMBERSHIP_TIERS', section: 'Staking — Membership Tiers by Lock' },
              { id: '6738028', name: 'MONTHLY_NEW_RETURNING', section: 'Staking — New vs Returning Wallets' },
              { id: '6738074', name: 'STAKING_TIERS_BY_LOCK', section: 'Staking — Tier Distribution by Lock' },
              { id: '6749292', name: 'MONTHLY_LINGO_BY_LOCK', section: 'Staking — Monthly LINGO by Lock Duration' },
              { id: '6749507', name: 'COMMUNITY_REWARDS', section: 'Revenue — Community Rewards' },
              { id: '6760287', name: 'BUY_PRESSURE', section: 'Trading — Buy & Sell Pressure' },
            ].map(({ id, name, section }) => (
              <div key={id} className="flex items-start gap-3 py-2.5 border-b border-white/[0.04] last:border-0">
                <a
                  href={`https://dune.com/queries/${id}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 flex items-center gap-1 text-xs font-mono text-purple hover:text-lavender transition-colors"
                >
                  {id}
                  <ExternalLink className="w-3 h-3" />
                </a>
                <div className="min-w-0">
                  <p className="text-sm text-lavender truncate">{name}</p>
                  <p className="text-xs text-purple-gray">{section}</p>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Mixpanel Data Reference */}
        <section className="glass-card rounded-2xl p-6 mt-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-10 h-10 rounded-xl bg-green1/10 flex items-center justify-center">
              <List className="w-5 h-5 text-green1" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-lavender">Mixpanel Data Reference</h2>
              <p className="text-xs text-purple-gray">5 data sources &middot; Project 3623820</p>
            </div>
          </div>

          <div className="space-y-0.5">
            {[
              { name: 'DAU (Insights Report)', detail: 'Report #75454495 — Hero card DAU + trend chart' },
              { name: 'WAU (Wallet Connected)', detail: 'Unique weekly — WAU trend chart + hero card' },
              { name: 'MAU (Wallet Connected)', detail: 'Unique monthly — Hero card MAU count' },
              { name: 'Weekly Engagement', detail: 'Asteroid Smashed, Raffle Ticket Purchased, Task Completed (totals + unique)' },
              { name: 'Monthly Engagement', detail: 'Same 3 events aggregated monthly (totals + unique)' },
            ].map(({ name, detail }) => (
              <div key={name} className="py-2.5 border-b border-white/[0.04] last:border-0">
                <p className="text-sm text-lavender">{name}</p>
                <p className="text-xs text-purple-gray">{detail}</p>
              </div>
            ))}
          </div>
        </section>

        {/* Info */}
        <div className="mt-6 text-center text-xs text-purple-gray">
          <p>Dune cron: 06:00 UTC &middot; 16 queries &middot; Mixpanel cron: 06:05 UTC</p>
          <p className="mt-1">Both stored in Vercel Blob &middot; CDN cached 1 min + 5 min stale</p>
        </div>
      </div>
    </div>
  );
}
