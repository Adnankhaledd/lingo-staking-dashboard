import { RefreshCw, Clock } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';

interface HeaderProps {
  lastUpdated: Date | null;
  onRefresh: () => void;
  isRefreshing: boolean;
}

export function Header({ lastUpdated, onRefresh, isRefreshing }: HeaderProps) {
  return (
    <header className="sticky top-0 z-50 glass border-b border-white/5">
      <div className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-4">
        <div className="flex items-center justify-between">
          {/* Logo and Title */}
          <div className="flex items-center gap-3">
            <div className="relative">
              <img
                src="/lingo-logo.svg"
                alt="Lingo"
                className="w-10 h-10 rounded-xl shadow-lg shadow-[#7B61FF]/30"
              />
              <div className="absolute -inset-1 rounded-xl bg-[#7B61FF] opacity-20 blur-lg -z-10" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-white tracking-tight">
                Lingo Staking
              </h1>
              <p className="text-[11px] text-white/40 uppercase tracking-wider">Analytics Dashboard</p>
            </div>
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-4">
            {/* Last Updated */}
            {lastUpdated && (
              <div className="hidden md:flex items-center gap-2 text-xs text-white/40 bg-white/5 px-3 py-1.5 rounded-lg">
                <Clock className="w-3.5 h-3.5" />
                <span>{formatDateTime(lastUpdated)}</span>
              </div>
            )}

            {/* Refresh Button */}
            <button
              onClick={onRefresh}
              disabled={isRefreshing}
              className="flex items-center gap-2 px-4 py-2 rounded-xl bg-gradient-to-r from-[#00D4FF]/10 to-[#7B61FF]/10 hover:from-[#00D4FF]/20 hover:to-[#7B61FF]/20 border border-[#00D4FF]/20 hover:border-[#00D4FF]/40 text-white/80 hover:text-white transition-all duration-200 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              <span className="text-sm font-medium hidden sm:inline">Refresh</span>
            </button>

            {/* Status Indicator */}
            <div className="flex items-center gap-2 bg-emerald-500/10 px-3 py-1.5 rounded-lg border border-emerald-500/20">
              <div className="relative">
                <div className="w-2 h-2 rounded-full bg-emerald-400" />
                <div className="absolute inset-0 w-2 h-2 rounded-full bg-emerald-400 animate-ping opacity-75" />
              </div>
              <span className="text-xs font-medium text-emerald-400 hidden sm:inline">Live</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
