import { useState, useCallback } from 'react';
import { RefreshCw, ArrowLeft, Database, Trash2, CheckCircle, XCircle, Loader2 } from 'lucide-react';
import lingoLogo from '../assets/logo-lingo.svg';

const API_BASE = import.meta.env.DEV ? 'http://localhost:3000' : '';
const SESSION_KEY = 'admin_password';

interface RefreshResult {
  message?: string;
  error?: string;
  refreshedAt?: string;
  newSuccessCount?: number;
  totalSuccessCount?: number;
  blobUrl?: string;
  kept?: boolean;
}

export function Admin() {
  const [password, setPassword] = useState(() => sessionStorage.getItem(SESSION_KEY) || '');
  const [isAuthenticated, setIsAuthenticated] = useState(() => !!sessionStorage.getItem(SESSION_KEY));
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [result, setResult] = useState<RefreshResult | null>(null);
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
        setResult(data);
      }
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setIsRefreshing(false);
    }
  }, []);

  const handleClearMixpanelCache = () => {
    // Clear all mixpanel cache versions
    for (let i = 1; i <= 10; i++) {
      localStorage.removeItem(`mixpanel_data_cache_v${i}`);
    }
    setCacheCleared(true);
    setTimeout(() => setCacheCleared(false), 3000);
  };

  const handleClearDuneCache = () => {
    // Clear all dune cache versions
    for (let i = 1; i <= 10; i++) {
      localStorage.removeItem(`dune_blob_cache_v${i}`);
    }
    localStorage.removeItem('dune_blob_cache');
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
                Refreshing all 13 queries...
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
                      {result.refreshedAt && (
                        <p className="text-purple-gray mt-1">
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

          <div className="grid grid-cols-2 gap-3">
            <button
              onClick={handleClearMixpanelCache}
              className="flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-soft-gray font-medium py-3 rounded-xl transition-colors text-sm"
            >
              Clear Mixpanel Cache
            </button>
            <button
              onClick={handleClearDuneCache}
              className="flex items-center justify-center gap-2 bg-white/5 hover:bg-white/10 text-soft-gray font-medium py-3 rounded-xl transition-colors text-sm"
            >
              Clear Dune Cache
            </button>
          </div>

          {cacheCleared && (
            <p className="mt-3 text-xs text-green1 flex items-center gap-1.5">
              <CheckCircle className="w-3 h-3" />
              Cache cleared! Reload the dashboard to fetch fresh data.
            </p>
          )}
        </section>

        {/* Info */}
        <div className="mt-6 text-center text-xs text-purple-gray">
          <p>Dune cron runs daily at 06:00 UTC &middot; 13 queries &middot; Stored in Vercel Blob</p>
          <p className="mt-1">Mixpanel data cached 24h in browser localStorage</p>
        </div>
      </div>
    </div>
  );
}
