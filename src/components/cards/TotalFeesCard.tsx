import { DollarSign } from 'lucide-react';

interface TotalFeesCardProps {
  totalFees: number;
  isLoading?: boolean;
}

function formatFullNumber(num: number): string {
  return Math.round(num).toLocaleString('en-US');
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

      {/* Mascot on the right side */}
      <div className="absolute right-4 lg:right-12 bottom-0 w-32 h-32 sm:w-40 sm:h-40 lg:w-52 lg:h-52 z-10 opacity-90 pointer-events-none">
        <img
          src="/mascot.jpg"
          alt="Lingo Mascot"
          className="w-full h-full object-contain drop-shadow-2xl"
        />
      </div>

      {/* Content */}
      <div className="relative z-10 p-8 lg:p-12">
        <div className="flex flex-col items-center text-center">
          {/* Label */}
          <div className="flex items-center gap-2 mb-6">
            <div className="w-10 h-10 rounded-xl bg-white/10 backdrop-blur-sm flex items-center justify-center border border-white/20">
              <DollarSign className="w-5 h-5 text-white" />
            </div>
            <span className="text-sm font-medium text-white/70 uppercase tracking-wider">
              Total Trading Fees Collected
            </span>
          </div>

          {/* Value */}
          {isLoading ? (
            <div className="skeleton h-20 w-80 rounded-xl bg-white/10" />
          ) : (
            <div className="flex items-baseline gap-3 justify-center">
              <span className="text-5xl sm:text-6xl lg:text-7xl xl:text-8xl font-bold text-white tracking-tight">
                ${formatFullNumber(totalFees)}
              </span>
            </div>
          )}

          {/* Subtitle */}
          <p className="mt-6 text-sm text-white/50">
            Accumulated from trading fees
          </p>
        </div>
      </div>

      {/* Bottom shine effect */}
      <div className="absolute bottom-0 left-0 right-0 h-px bg-gradient-to-r from-transparent via-white/30 to-transparent" />
    </div>
  );
}
