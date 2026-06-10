import { useCallback, useMemo, useState } from 'react';
import { Clock, RefreshCw, Gift, Users, Hash, DollarSign, Database } from 'lucide-react';
import { softRefresh, clearDuneCache } from '../hooks/useDuneQuery';
import { formatNumber, formatCurrency, formatDateTime } from '../utils/formatters';
import {
  useDuneQuery,
  DUNE_QUERIES,
  type WeeklyClaimSummaryRow,
  type WeeklyClaimsBySourceRow,
  type TopClaimerRow,
  type DecubateWeeklyClaimsRow,
  type DecubateClaimFeedRow,
  type ClaimsByTypeRow,
} from '../hooks/useDuneQuery';
import { ClaimsBySourceChart } from '../components/charts/ClaimsBySourceChart';
import { ClaimsSummaryChart } from '../components/charts/ClaimsSummaryChart';
import { DecubateWeeklyClaimsChart } from '../components/charts/DecubateWeeklyClaimsChart';
import { CombinedClaimsChart } from '../components/charts/CombinedClaimsChart';
import { DecubateClaimFeedTable } from '../components/cards/DecubateClaimFeedTable';
import { ClaimsByTypeTable } from '../components/cards/ClaimsByTypeTable';
import { TopClaimersTable } from '../components/cards/TopClaimersTable';
import lingoLogo from '../assets/logo-lingo.svg';

function parseDuneDate(raw: string): string {
  if (!raw) return '';
  return raw.split('T')[0];
}

// Handles both ISO ("...T...") and space-separated ("YYYY-MM-DD HH:MM:SS UTC") formats
function parseDuneDateFlexible(raw: string): string {
  if (!raw) return '';
  return raw.split(/[T\s]/)[0];
}

export function Claims() {
  const {
    data: summaryData,
    isLoading: loadingSummary,
    executedAt: summaryExecutedAt,
  } = useDuneQuery<WeeklyClaimSummaryRow>(DUNE_QUERIES.WEEKLY_CLAIM_SUMMARY);

  const {
    data: sourceData,
    isLoading: loadingSource,
    executedAt: sourceExecutedAt,
  } = useDuneQuery<WeeklyClaimsBySourceRow>(DUNE_QUERIES.WEEKLY_CLAIMS_BY_SOURCE);

  const {
    data: topClaimers,
    isLoading: loadingTopClaimers,
  } = useDuneQuery<TopClaimerRow>(DUNE_QUERIES.TOP_CLAIMERS);

  const {
    data: decubateData,
    isLoading: loadingDecubate,
    executedAt: decubateExecutedAt,
  } = useDuneQuery<DecubateWeeklyClaimsRow>(DUNE_QUERIES.DECUBATE_WEEKLY_CLAIMS);

  const {
    data: claimFeed,
    isLoading: loadingClaimFeed,
  } = useDuneQuery<DecubateClaimFeedRow>(DUNE_QUERIES.DECUBATE_CLAIM_FEED);

  const {
    data: claimsByType,
    isLoading: loadingClaimsByType,
  } = useDuneQuery<ClaimsByTypeRow>(DUNE_QUERIES.CLAIMS_BY_TYPE);

  // Transform summary data for chart
  const summaryChartData = useMemo(() => {
    if (!summaryData) return [];
    return [...summaryData]
      .sort((a, b) => parseDuneDate(a.week).localeCompare(parseDuneDate(b.week)))
      .map(row => ({
        week: parseDuneDate(row.week),
        num_claims: row.num_claims ?? 0,
        unique_claimers: row.unique_claimers ?? 0,
        total_lingo_claimed: Math.round(row.total_lingo_claimed ?? 0),
        usd_value: Math.round((row.usd_value ?? 0) * 100) / 100,
        avg_claim_size: Math.round(row.avg_claim_size ?? 0),
        cumulative_claimed: Math.round(row.cumulative_claimed ?? 0),
      }));
  }, [summaryData]);

  // Transform Decubate weekly claims for chart
  const decubateChartData = useMemo(() => {
    if (!decubateData) return [];
    return decubateData.map(row => ({
      week: parseDuneDateFlexible(row.week),
      total_claimed: Math.round(row.total_claimed ?? 0),
      cumulative_claimed: Math.round(row.cumulative_claimed ?? 0),
    }));
  }, [decubateData]);

  // Merge main contract + Decubate claims by week for combined chart
  const combinedClaimsData = useMemo(() => {
    const sanitize = (w: string) => w.split(/[T\s]/)[0]; // ensure clean YYYY-MM-DD
    const mainMap = new Map<string, { claimed: number; cumulative: number }>();
    for (const row of summaryChartData) {
      mainMap.set(sanitize(row.week), { claimed: row.total_lingo_claimed, cumulative: row.cumulative_claimed });
    }
    const decMap = new Map<string, { claimed: number; cumulative: number }>();
    for (const row of decubateChartData) {
      decMap.set(sanitize(row.week), { claimed: row.total_claimed, cumulative: row.cumulative_claimed });
    }
    const allWeeks = new Set([...mainMap.keys(), ...decMap.keys()]);
    return Array.from(allWeeks)
      .sort()
      .map(week => ({
        week,
        mainContract: mainMap.get(week)?.claimed ?? 0,
        decubate: decMap.get(week)?.claimed ?? 0,
        mainCumulative: mainMap.get(week)?.cumulative ?? 0,
        decubateCumulative: decMap.get(week)?.cumulative ?? 0,
      }));
  }, [summaryChartData, decubateChartData]);

  // Transform source data for chart
  const sourceChartData = useMemo(() => {
    if (!sourceData) return [];
    return [...sourceData]
      .sort((a, b) => parseDuneDate(a.week).localeCompare(parseDuneDate(b.week)))
      .map(row => ({
        week: parseDuneDate(row.week),
        team: Math.round(row.team_claimed ?? 0),
        private_rounds: Math.round(row.private_rounds_claimed ?? 0),
        kol: Math.round(row.kol_claimed ?? 0),
        public: Math.round(row.public_claimed ?? 0),
        airdrop: Math.round(row.airdrop_claimed ?? 0),
        partners: Math.round(row.partners_claimed ?? 0),
        total: Math.round(row.total_claimed ?? 0),
      }));
  }, [sourceData]);

  // KPI calculations from latest week
  const kpis = useMemo(() => {
    if (!summaryData || summaryData.length === 0) return null;

    const sorted = [...summaryData].sort((a, b) =>
      parseDuneDate(b.week).localeCompare(parseDuneDate(a.week))
    );

    const latest = sorted[0];
    const prev = sorted.length > 1 ? sorted[1] : null;

    const pctChange = (curr: number, prevVal: number | null) => {
      if (prevVal == null || prevVal === 0) return null;
      return ((curr - prevVal) / Math.abs(prevVal)) * 100;
    };

    return {
      totalClaimed: latest.cumulative_claimed,
      weekClaims: latest.num_claims,
      weekClaimsChange: prev ? pctChange(latest.num_claims, prev.num_claims) : null,
      weekClaimers: latest.unique_claimers,
      weekClaimersChange: prev ? pctChange(latest.unique_claimers, prev.unique_claimers) : null,
      weekLingo: latest.total_lingo_claimed,
      weekLingoChange: prev ? pctChange(latest.total_lingo_claimed, prev.total_lingo_claimed) : null,
      weekUsd: latest.usd_value,
      weekUsdChange: prev ? pctChange(latest.usd_value, prev.usd_value) : null,
      avgClaimSize: latest.avg_claim_size,
    };
  }, [summaryData]);

  // Last updated from any query
  const lastUpdated = summaryExecutedAt ? new Date(summaryExecutedAt) : null;

  const handleRefresh = () => {
    softRefresh();
    window.location.reload();
  };

  // ── Re-pull from Dune (scoped to the 6 queries that feed this page) ──
  // Uses the same admin password as /admin so we don't expose Dune fetches
  // to anonymous visitors. Prompts once per session if not already stored.
  const CLAIMS_QUERY_IDS = useMemo(
    () => [
      DUNE_QUERIES.WEEKLY_CLAIM_SUMMARY,
      DUNE_QUERIES.WEEKLY_CLAIMS_BY_SOURCE,
      DUNE_QUERIES.TOP_CLAIMERS,
      DUNE_QUERIES.DECUBATE_WEEKLY_CLAIMS,
      DUNE_QUERIES.DECUBATE_CLAIM_FEED,
      DUNE_QUERIES.CLAIMS_BY_TYPE,
    ],
    []
  );
  const [isRePulling, setIsRePulling] = useState(false);
  const [rePullMessage, setRePullMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const handleRePullFromDune = useCallback(async () => {
    let password = sessionStorage.getItem('admin_password') || '';
    if (!password) {
      const entered = window.prompt('Admin password (Dune re-pull is gated):');
      if (!entered) return;
      password = entered.trim();
      sessionStorage.setItem('admin_password', password);
    }

    setIsRePulling(true);
    setRePullMessage(null);
    try {
      const res = await fetch('/api/refresh-dune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Admin-Password': password },
        body: JSON.stringify({ queryIds: CLAIMS_QUERY_IDS }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) {
        sessionStorage.removeItem('admin_password');
        setRePullMessage({ kind: 'err', text: 'Wrong password — try again.' });
        return;
      }
      if (!res.ok) {
        setRePullMessage({ kind: 'err', text: data?.error || `HTTP ${res.status}` });
        return;
      }
      clearDuneCache();
      setRePullMessage({ kind: 'ok', text: data?.message || 'Re-pulled from Dune. Reload to see fresh data.' });
    } catch (err) {
      setRePullMessage({ kind: 'err', text: err instanceof Error ? err.message : 'Network error' });
    } finally {
      setIsRePulling(false);
    }
  }, [CLAIMS_QUERY_IDS]);

  return (
    <div className="min-h-screen" style={{ background: 'linear-gradient(180deg, #14141F 0%, #1A1A2E 50%, #14141F 100%)' }}>
      {/* Header */}
      <header className="sticky top-0 z-50 border-b border-white/5" style={{ background: 'rgba(20, 20, 31, 0.92)', boxShadow: '0px 0px 56px -16px rgba(28, 28, 41, 0.4) inset', backdropFilter: 'blur(20px)' }}>
        <div className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <img src={lingoLogo} alt="Lingo" className="h-7" />
              <div>
                <h1 className="text-lg font-semibold text-lavender tracking-tight">
                  Claims
                </h1>
                <p className="text-[11px] text-soft-gray uppercase tracking-wider">Internal Analytics</p>
              </div>
            </div>

            <div className="flex items-center gap-3">
              {lastUpdated && (
                <div className="hidden md:flex glow-btn h-8 gap-2 text-xs text-soft-gray cursor-default">
                  <Clock className="w-3.5 h-3.5" />
                  <span>Updated {formatDateTime(lastUpdated)}</span>
                </div>
              )}
              <button
                onClick={handleRefresh}
                className="flex items-center gap-1.5 text-xs text-soft-gray bg-dark3/60 px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/10 hover:text-lavender transition-colors cursor-pointer"
                title="Clear local cache and reload — does not hit Dune"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span className="hidden sm:inline">Refresh</span>
              </button>
              <button
                onClick={handleRePullFromDune}
                disabled={isRePulling}
                className="flex items-center gap-1.5 text-xs text-purple bg-purple/10 px-3 py-1.5 rounded-lg border border-purple/30 hover:bg-purple/20 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                title="Re-pull the 6 claims queries from Dune (admin-only)"
              >
                <Database className={`w-3.5 h-3.5 ${isRePulling ? 'animate-pulse' : ''}`} />
                <span className="hidden sm:inline">{isRePulling ? 'Pulling…' : 'Re-pull from Dune'}</span>
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Re-pull from Dune status banner (auto-hides when no message) */}
      {rePullMessage && (
        <div className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 pt-4">
          <div
            className={`flex items-start justify-between gap-3 px-4 py-3 rounded-lg border text-sm ${
              rePullMessage.kind === 'ok'
                ? 'bg-green1/10 border-green1/30 text-green1'
                : 'bg-red-400/10 border-red-400/30 text-red-300'
            }`}
          >
            <span>{rePullMessage.text}</span>
            <button
              onClick={() => setRePullMessage(null)}
              className="text-xs opacity-70 hover:opacity-100 underline cursor-pointer"
            >
              dismiss
            </button>
          </div>
        </div>
      )}

      {/* Content */}
      <main className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-8 space-y-8">
        {/* KPI Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
          <KPICard
            icon={<Gift className="w-4 h-4" />}
            label="Total Claimed"
            value={kpis ? formatNumber(kpis.totalClaimed) : '—'}
            sub="LINGO"
            isLoading={loadingSummary}
          />
          <KPICard
            icon={<Hash className="w-4 h-4" />}
            label="Claims This Week"
            value={kpis ? formatNumber(kpis.weekClaims) : '—'}
            change={kpis?.weekClaimsChange}
            isLoading={loadingSummary}
          />
          <KPICard
            icon={<Users className="w-4 h-4" />}
            label="Claimers This Week"
            value={kpis ? formatNumber(kpis.weekClaimers) : '—'}
            change={kpis?.weekClaimersChange}
            isLoading={loadingSummary}
          />
          <KPICard
            icon={<Gift className="w-4 h-4" />}
            label="LINGO Claimed"
            value={kpis ? formatNumber(kpis.weekLingo) : '—'}
            sub="this week"
            change={kpis?.weekLingoChange}
            isLoading={loadingSummary}
          />
          <KPICard
            icon={<DollarSign className="w-4 h-4" />}
            label="USD Value"
            value={kpis ? formatCurrency(kpis.weekUsd) : '—'}
            sub="this week"
            change={kpis?.weekUsdChange}
            isLoading={loadingSummary}
          />
        </div>

        {/* Charts — full width, one per row */}
        <ClaimsSummaryChart
          data={summaryChartData}
          isLoading={loadingSummary}
          lastUpdated={summaryExecutedAt}
        />
        <ClaimsBySourceChart
          data={sourceChartData}
          isLoading={loadingSource}
          lastUpdated={sourceExecutedAt}
        />

        {/* Combined Claims — Main Contract vs Decubate */}
        <CombinedClaimsChart
          data={combinedClaimsData}
          isLoading={loadingSummary || loadingDecubate}
          lastUpdated={summaryExecutedAt}
        />

        {/* Decubate Claim Feed */}
        <DecubateClaimFeedTable
          data={claimFeed ?? []}
          isLoading={loadingClaimFeed}
        />

        {/* Claims by Type */}
        <ClaimsByTypeTable
          data={claimsByType ?? []}
          isLoading={loadingClaimsByType}
        />

        {/* Top Claimers Table */}
        <TopClaimersTable
          data={topClaimers ?? []}
          isLoading={loadingTopClaimers}
        />

        {/* Decubate Weekly Claims */}
        <DecubateWeeklyClaimsChart
          data={decubateChartData}
          isLoading={loadingDecubate}
          lastUpdated={decubateExecutedAt}
        />
      </main>
    </div>
  );
}

// ─── Internal KPI Card (claims-specific) ──────────────────────────────

interface KPICardProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  change?: number | null;
  isLoading?: boolean;
}

function KPICard({ icon, label, value, sub, change, isLoading }: KPICardProps) {
  if (isLoading) {
    return (
      <div className="flagship-card rounded-2xl p-5">
        <div className="skeleton h-4 w-24 rounded mb-3 relative z-10" />
        <div className="skeleton h-7 w-20 rounded mb-1 relative z-10" />
        <div className="skeleton h-3 w-16 rounded relative z-10" />
      </div>
    );
  }

  return (
    <div className="flagship-card rounded-2xl p-5">
      <div className="flex items-center gap-2 mb-2 relative z-10">
        <div className="text-purple-gray">{icon}</div>
        <span className="text-xs text-soft-gray uppercase tracking-wider font-medium">{label}</span>
      </div>
      <div className="relative z-10">
        <p className="text-xl font-bold text-lavender">{value}</p>
        <div className="flex items-center gap-2 mt-1">
          {sub && <span className="text-xs text-purple-gray">{sub}</span>}
          {change != null && (
            <span className={`text-xs font-medium ${change >= 0 ? 'text-green1' : 'text-[#E85757]'}`}>
              {change >= 0 ? '+' : ''}{change.toFixed(1)}%
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
