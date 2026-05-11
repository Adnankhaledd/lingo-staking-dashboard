/**
 * Card showing the dollar value of a fixed unit of an engagement reward
 * (e.g. "$4.40 per 10 shards"). Sized to read clearly at-a-glance — the
 * dollar value is the dominant visual element.
 */
interface RewardValueCardProps {
  label: string;            // e.g. "Shards"
  unitsLabel: string;       // e.g. "per 10 shards"
  usdValue: number;         // e.g. 4.4
  iconSrc: string;          // URL of icon (served from /public)
  accentColor?: string;     // hex, used for the icon background + accents
  helper?: string;          // small italic line below, optional context
}

function formatUsd(n: number): string {
  // Show cents when the value is under $10 so e.g. $4.40 stays informative,
  // round to dollars above that.
  if (Math.abs(n) < 10) return `$${n.toFixed(2)}`;
  return `$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
}

export function RewardValueCard({
  label,
  unitsLabel,
  usdValue,
  iconSrc,
  accentColor = '#C4B5D4',
  helper,
}: RewardValueCardProps) {
  return (
    <div className="flagship-card p-6 group transition-all duration-300 hover:scale-[1.02]">
      {/* Soft accent glow on hover */}
      <div
        className="absolute -top-16 -right-16 w-32 h-32 rounded-full blur-3xl opacity-0 group-hover:opacity-100 transition-opacity duration-500"
        style={{ backgroundColor: `${accentColor}20` }}
      />

      <div className="relative z-10">
        <div className="flex items-center justify-between mb-4">
          <div className="flex flex-col">
            <span className="text-xs text-purple-gray uppercase tracking-widest font-semibold">
              Reward Value
            </span>
            <span className="text-sm text-soft-gray mt-0.5">{label}</span>
          </div>
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center overflow-hidden"
            style={{ backgroundColor: `${accentColor}18`, border: `1px solid ${accentColor}30` }}
          >
            <img
              src={iconSrc}
              alt={`${label} icon`}
              className="w-9 h-9 object-contain"
              loading="lazy"
            />
          </div>
        </div>

        <div className="flex items-baseline gap-2 mt-2">
          <span className="text-4xl font-bold text-lavender tracking-tight">
            {formatUsd(usdValue)}
          </span>
          <span className="text-sm text-soft-gray">{unitsLabel}</span>
        </div>

        {helper && (
          <p className="text-xs text-purple-gray mt-2 italic">{helper}</p>
        )}
      </div>
    </div>
  );
}
