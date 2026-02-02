import { DollarSign } from 'lucide-react';

interface TotalFeesCardProps {
  totalFees: number;
  isLoading?: boolean;
}

function formatLargeNumber(num: number): string {
  if (num >= 1_000_000) {
    return (num / 1_000_000).toFixed(2) + 'M';
  }
  if (num >= 1_000) {
    return (num / 1_000).toFixed(2) + 'K';
  }
  return num.toFixed(2);
}

export function TotalFeesCard({ totalFees, isLoading }: TotalFeesCardProps) {
  return (
    <div className="relative overflow-hidden rounded-3xl">
      {/* Gradient background */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#7B61FF] via-[#5B4BC4] to-[#3D2E91]" />

      {/* Animated gradient orbs */}
      <div className="absolute top-[-50%] right-[-20%] w-[400px] h-[400px] bg-[#00D4FF]/30 rounded-full blur-[100px] animate-pulse" />
      <div className="absolute bottom-[-30%] left-[-10%] w-[300px] h-[300px] bg-[#7B61FF]/50 rounded-full blur-[80px]" />

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-10"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 p-8 lg:p-10">
        <div className="flex items-center justify-between">
          <div>
            {/* Label */}
            <div className="flex items-center gap-2 mb-4">
              <div className="w-10 h-10 rounded-xl bg-white/10 backdrop-blur-sm flex items-center justify-center border border-white/20">
                <DollarSign className="w-5 h-5 text-white" />
              </div>
              <span className="text-sm font-medium text-white/70 uppercase tracking-wider">
                Total Trading Fees Collected
              </span>
            </div>

            {/* Value */}
            {isLoading ? (
              <div className="skeleton h-16 w-64 rounded-xl bg-white/10" />
            ) : (
              <div className="flex items-baseline gap-2">
                <span className="text-5xl lg:text-6xl xl:text-7xl font-bold text-white tracking-tight">
                  ${formatLargeNumber(totalFees)}
                </span>
                <span className="text-2xl lg:text-3xl font-medium text-white/60">
                  USD
                </span>
              </div>
            )}

            {/* Subtitle */}
            <p className="mt-4 text-sm text-white/50">
              Accumulated from all staking transactions
            </p>
          </div>

          {/* Decorative element */}
          <div className="hidden lg:block">
            <div className="w-32 h-32 rounded-full border-4 border-white/10 flex items-center justify-center">
              <div className="w-24 h-24 rounded-full border-4 border-white/20 flex items-center justify-center">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-[#00D4FF]/50 to-[#7B61FF]/50 flex items-center justify-center backdrop-blur-sm">
                  <DollarSign className="w-8 h-8 text-white" />
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Bottom shine effect */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
    </div>
  );
}
