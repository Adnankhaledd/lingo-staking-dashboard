import { Clock, RefreshCw } from 'lucide-react';
import { formatDateTime } from '../../utils/formatters';
import { clearDuneCache } from '../../hooks/useDuneQuery';
import lingoLogo from '../../assets/logo-lingo.svg';

interface HeaderProps {
  lastUpdated: Date | null;
}

export function Header({ lastUpdated }: HeaderProps) {
  const handleRefresh = () => {
    clearDuneCache();
    // Also clear Mixpanel cache
    localStorage.removeItem('mixpanel_data_cache');
    window.location.reload();
  };

  return (
    <header className="sticky top-0 z-50 glass border-b border-white/5">
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
          <div className="flex items-center gap-4">
            {/* Last Updated */}
            {lastUpdated && (
              <div className="hidden md:flex items-center gap-2 text-xs text-soft-gray bg-dark3/60 px-3 py-1.5 rounded-lg border border-white/5">
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
            <div className="flex items-center gap-2 bg-green1/10 px-3 py-1.5 rounded-lg border border-green1/20">
              <div className="relative">
                <div className="w-2 h-2 rounded-full bg-green1" />
                <div className="absolute inset-0 w-2 h-2 rounded-full bg-green1 animate-ping opacity-75" />
              </div>
              <span className="text-xs font-medium text-green1 hidden sm:inline">Live</span>
            </div>
          </div>
        </div>
      </div>
    </header>
  );
}
