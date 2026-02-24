import { Clock, RefreshCw } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';
import { softRefresh } from '../../hooks/useDuneQuery';
import lingoLogo from '../../assets/logo-lingo.svg';

interface HeaderProps {
  lastUpdated: Date | null;
}

export function Header({ lastUpdated }: HeaderProps) {
  const handleRefresh = () => {
    // Only reset in-memory cache — keeps localStorage as safety net
    softRefresh();
    window.location.reload();
  };

  return (
    <header className="sticky top-0 z-50 border-b border-white/5" style={{ background: 'rgba(20, 20, 31, 0.92)', boxShadow: '0px 0px 56px -16px rgba(28, 28, 41, 0.4) inset', backdropFilter: 'blur(20px)' }}>
      <div className="w-full max-w-[1400px] mx-auto px-6 lg:px-10 py-4">
        <div className="flex items-center justify-between">
          {/* Logo and Title */}
          <div className="flex items-center gap-3">
            <img
              src={lingoLogo}
              alt="Lingo"
              className="h-7"
            />
            <div>
              <h1 className="text-lg font-semibold text-lavender tracking-tight">
                Staking
              </h1>
              <p className="text-[11px] text-soft-gray uppercase tracking-wider">Analytics Dashboard</p>
            </div>
          </div>

          {/* Right Section */}
          <div className="flex items-center gap-3">
            {/* Last Updated */}
            {lastUpdated && (
              <div className="hidden md:flex glow-btn h-8 gap-2 text-xs text-soft-gray cursor-default">
                <Clock className="w-3.5 h-3.5" />
                <span>Updated {formatDateTime(lastUpdated)}</span>
              </div>
            )}

            {/* Refresh Button */}
            <button
              onClick={handleRefresh}
              className="flex items-center gap-1.5 text-xs text-soft-gray bg-dark3/60 px-3 py-1.5 rounded-lg border border-white/5 hover:bg-white/10 hover:text-lavender transition-colors cursor-pointer"
              title="Clear cache and refresh data"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Refresh</span>
            </button>

            {/* Status Indicator */}
            <div className="glow-btn h-8 gap-2 cursor-default" style={{ boxShadow: '0px -4px 16px -2px rgba(94, 184, 81, 0.24) inset' }}>
              <div className="relative">
                <div className="w-2 h-2 rounded-full bg-green1" />
                <div className="absolute inset-0 w-2 h-2 rounded-full bg-green1 animate-ping opacity-75" />
              </div>
              <span className="text-xs font-semibold text-green1 hidden sm:inline">Live</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
