import { ArrowUpRight, ArrowDownRight, Activity, ExternalLink } from 'lucide-react';
import { useLiveActivity, type StakingEvent } from '../hooks/useLiveActivity';

function formatTimeAgo(isoDate: string): string {
  const date = new Date(isoDate);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function shortenAddress(address: string): string {
  if (address.length < 10) return address;
  return `${address.slice(0, 6)}...${address.slice(-4)}`;
}

function formatAmount(amount: number): string {
  if (amount >= 1_000_000) return `${(amount / 1_000_000).toFixed(2)}M`;
  if (amount >= 1_000) return `${(amount / 1_000).toFixed(1)}K`;
  return amount.toFixed(0);
}

function EventRow({ event }: { event: StakingEvent }) {
  const isStake = event.type === 'stake';

  return (
    <div className="flex items-center gap-3 py-2.5 border-b border-white/[0.04] last:border-0 group">
      <div
        className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${
          isStake ? 'bg-green1/10' : 'bg-red-400/10'
        }`}
      >
        {isStake ? (
          <ArrowUpRight className="w-4 h-4 text-green1" />
        ) : (
          <ArrowDownRight className="w-4 h-4 text-red-400" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-sm font-medium ${isStake ? 'text-green1' : 'text-red-400'}`}>
            {isStake ? 'Staked' : 'Unstaked'}
          </span>
          <span className="text-sm font-bold text-lavender">
            {formatAmount(event.amount)} LINGO
          </span>
        </div>
        <div className="flex items-center gap-2 mt-0.5">
          <span className="text-xs text-purple-gray font-mono">
            {shortenAddress(event.wallet)}
          </span>
          <span className="text-xs text-purple-gray/50">&middot;</span>
          <span className="text-xs text-purple-gray">
            {event.timestamp ? formatTimeAgo(event.timestamp) : ''}
          </span>
        </div>
      </div>

      <a
        href={`https://basescan.org/tx/${event.txHash}`}
        target="_blank"
        rel="noopener noreferrer"
        className="opacity-0 group-hover:opacity-100 transition-opacity"
      >
        <ExternalLink className="w-3.5 h-3.5 text-purple-gray hover:text-lavender" />
      </a>
    </div>
  );
}

export function LiveActivityFeed() {
  const { events, isLoading, isConfigured } = useLiveActivity();

  // Don't render at all if Alchemy is not configured
  if (!isConfigured) return null;

  return (
    <div className="flagship-card rounded-2xl p-6">
      <div className="flex items-center gap-2 mb-4 relative z-10">
        <Activity className="w-4 h-4 text-green1" />
        <h3 className="text-lg font-semibold text-lavender">
          Live Staking Activity
        </h3>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="w-2 h-2 rounded-full bg-green1 animate-pulse" />
          <span className="text-xs text-soft-gray">Live</span>
        </div>
      </div>

      {isLoading ? (
        <div className="space-y-3 relative z-10">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <div className="skeleton w-8 h-8 rounded-lg" />
              <div className="flex-1">
                <div className="skeleton h-4 w-32 rounded mb-1" />
                <div className="skeleton h-3 w-24 rounded" />
              </div>
            </div>
          ))}
        </div>
      ) : events.length > 0 ? (
        <div className="max-h-[400px] overflow-y-auto relative z-10" style={{ scrollbarWidth: 'thin' }}>
          {events.map((event, i) => (
            <EventRow key={`${event.txHash}-${i}`} event={event} />
          ))}
        </div>
      ) : (
        <div className="h-32 flex items-center justify-center text-soft-gray text-sm relative z-10">
          No recent activity
        </div>
      )}
    </div>
  );
}
