import { useMemo, useState } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { Zap } from 'lucide-react';
import { formatNumber } from '../../utils/formatters';
import { useVestingClaims } from '../../hooks/useVestingClaims';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function labelFor(period: string, bucket: 'week' | 'month'): string {
  const p = period.split('-').map(Number);
  if (bucket === 'week') return `${MONTH_NAMES[p[1] - 1]} ${p[2]}`;      // "Jul 21"
  return `${MONTH_NAMES[p[1] - 1]} '${String(p[0]).slice(2)}`;           // "Jul '26"
}

export function VestingClaimsChart() {
  const [bucket, setBucket] = useState<'week' | 'month'>('week');
  const { data, totalLingoClaimed, totalClaims, asOfBlock, isLoading, error } = useVestingClaims(bucket);

  // Show a rolling window so weekly stays readable.
  const rows = useMemo(() => {
    const all = (data ?? []).map(b => ({ ...b, label: labelFor(b.period, bucket) }));
    const limit = bucket === 'week' ? 20 : 24;
    return all.slice(-limit);
  }, [data, bucket]);

  const latest = rows.length ? rows[rows.length - 1] : null;

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="flex items-start justify-between mb-4 relative z-10 flex-wrap gap-2">
        <div>
          <h3 className="text-lg font-semibold text-lavender">Vesting Claims — {bucket === 'week' ? 'Weekly' : 'Monthly'}</h3>
          <p className="text-sm text-soft-gray mt-1">
            LINGO claimed from the vesting contract &middot; live on-chain via Alchemy (mint-aware)
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1 text-xs text-green1" title={asOfBlock ? `As of block ${asOfBlock.toLocaleString()}` : 'live'}>
            <Zap className="w-3 h-3" /> live
          </span>
          <div className="flex bg-white/[0.04] rounded-lg border border-white/[0.06] overflow-hidden">
            {(['week', 'month'] as const).map(k => (
              <button
                key={k}
                onClick={() => setBucket(k)}
                className={`px-3 py-1.5 text-xs font-medium transition-all ${
                  bucket === k ? 'bg-purple/30 text-white' : 'text-soft-gray hover:text-white hover:bg-white/[0.04]'
                }`}
              >
                {k === 'week' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Headline */}
      {!isLoading && !error && (
        <div className="flex items-baseline gap-4 mb-4 relative z-10 flex-wrap">
          {latest && (
            <div>
              <span className="text-2xl font-bold text-lavender">{formatNumber(latest.lingoClaimed)}</span>
              <span className="text-sm text-soft-gray ml-1">LINGO this {bucket} ({latest.claims.toLocaleString()} claims)</span>
            </div>
          )}
          {totalLingoClaimed != null && (
            <span className="text-xs text-purple-gray">
              {formatNumber(totalLingoClaimed)} LINGO all-time · {totalClaims?.toLocaleString()} claims
            </span>
          )}
        </div>
      )}

      <div className="h-72 relative z-10">
        {isLoading ? (
          <div className="skeleton h-full w-full rounded-xl" />
        ) : error ? (
          <div className="h-full flex items-center justify-center text-red-400 text-sm">{error}</div>
        ) : rows.length === 0 ? (
          <div className="h-full flex items-center justify-center text-soft-gray text-sm">No claims found</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={rows} margin={{ top: 10, right: 10, left: 0, bottom: 0 }} barCategoryGap="18%">
              <defs>
                <linearGradient id="vestingClaimsGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#C4B5D4" stopOpacity={1} />
                  <stop offset="100%" stopColor="#C4B5D4" stopOpacity={0.45} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.04)" vertical={false} />
              <XAxis dataKey="label" stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} dy={8} interval="preserveStartEnd" />
              <YAxis tickFormatter={(v) => formatNumber(Number(v))} stroke="rgba(255,255,255,0.15)" tick={{ fill: 'rgba(255,255,255,0.35)', fontSize: 11 }} axisLine={false} tickLine={false} width={62} />
              <Tooltip
                cursor={{ fill: 'rgba(255,255,255,0.02)' }}
                content={({ active, payload, label }) => {
                  if (!active || !payload || !payload.length) return null;
                  const r = payload[0].payload as { lingoClaimed: number; claims: number; period: string };
                  return (
                    <div className="custom-tooltip">
                      <p className="text-soft-gray text-xs mb-2">{bucket === 'week' ? 'Week of ' : ''}{String(label)}</p>
                      <p className="text-lavender font-semibold">{formatNumber(r.lingoClaimed)} LINGO</p>
                      <p className="text-purple-gray text-xs">{r.claims.toLocaleString()} claims</p>
                    </div>
                  );
                }}
              />
              <Bar dataKey="lingoClaimed" name="LINGO Claimed" fill="url(#vestingClaimsGrad)" radius={[4, 4, 0, 0]} animationDuration={800} />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
