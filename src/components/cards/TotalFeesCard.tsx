import { DollarSign } from 'lucide-react';

interface TotalFeesCardProps {
  totalFees: {
    tradingTotal: number;
    lpTotal: number;
    grandTotal: number;
  };
  isLoading?: boolean;
}

function formatFullNumber(num: number): string {
  return Math.round(num).toLocaleString('en-US');
}

export function TotalFeesCard({ totalFees, isLoading }: TotalFeesCardProps) {
  return (
    <div className="relative overflow-hidden rounded-3xl">
      {/* Gradient background — flagship purple tones */}
      <div className="absolute inset-0 bg-gradient-to-br from-[#5B4BC4] via-[#3D2E91] to-[#2A1F6D]" />

      {/* Animated gradient orbs */}
      <div className="absolute top-[-50%] right-[-20%] w-[400px] h-[400px] bg-lavender/15 rounded-full blur-[100px] animate-pulse" />
      <div className="absolute bottom-[-30%] left-[-10%] w-[300px] h-[300px] bg-purple/20 rounded-full blur-[80px]" />

      {/* Grid pattern overlay */}
      <div
        className="absolute inset-0 opacity-8"
        style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.06) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.06) 1px, transparent 1px)`,
          backgroundSize: '40px 40px',
        }}
      />

      {/* Content */}
      <div className="relative z-10 p-8 lg:p-12">
        <div className="flex flex-col items-center text-center">
          {/* Label */}
          <div className="flex items-center gap-2 mb-6">
            <div className="w-10 h-10 rounded-xl bg-white/10 backdrop-blur-sm flex items-center justify-center border border-white/15">
              <DollarSign className="w-5 h-5 text-lavender" />
            </div>
            <span className="text-sm font-medium text-lavender/70 uppercase tracking-wider">
              Total Fees Collected
            </span>
          </div>

          {/* Value */}
          {isLoading ? (
            <div className="skeleton h-20 w-80 rounded-xl bg-white/10" />
          ) : (
            <div className="flex items-baseline gap-3 justify-center">
              <span className="text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-bold text-white tracking-tight">
                ${formatFullNumber(totalFees.grandTotal)}
              </span>
            </div>
          )}

          {/* Breakdown */}
          {!isLoading && (
            <div className="mt-6 flex flex-wrap items-center justify-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-purple" />
                <span className="text-lavender/60">Trading Fees:</span>
                <span className="text-white font-semibold">${formatFullNumber(totalFees.tradingTotal)}</span>
              </div>
              <div className="flex items-center gap-2">
                <div className="w-3 h-3 rounded-full bg-green1" />
                <span className="text-lavender/60">LP Fees:</span>
                <span className="text-white font-semibold">${formatFullNumber(totalFees.lpTotal)}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Bottom shine effect */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-lavender/30 to-transparent" />
    </div>
  );
}
