import { useRef, useState, useCallback, useEffect, type ReactNode, type MouseEvent as ReactMouseEvent } from 'react';

interface GlowButtonProps {
  children: ReactNode;
  color?: string;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}

export function GlowButton({
  children,
  color = '#C4B5D4',
  onClick,
  disabled = false,
  className = '',
}: GlowButtonProps) {
  const containerRef = useRef<HTMLButtonElement>(null);
  const [isHovered, setIsHovered] = useState(false);
  const [mouseX, setMouseX] = useState(60);
  const [mouseY, setMouseY] = useState(50);

  const stretchFactor = 1 + Math.abs(mouseX / 100 - 0.5) * 2;
  const rotation = ((mouseX - 50) * -0.5 + (mouseY - 50) * 0.5) * 0.5;

  // Constrained Y for the big ellipse
  const bigEllipseY = (() => {
    const centerY = 50;
    const maxOffsetPct = 20;
    const offset = (mouseY - centerY) * (maxOffsetPct / 50);
    return centerY + Math.max(-maxOffsetPct, Math.min(maxOffsetPct, offset));
  })();

  const handleMouseMove = useCallback((e: globalThis.MouseEvent) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * 100;
    const ry = ((e.clientY - rect.top) / rect.height) * 100;
    setMouseX(Math.max(0, Math.min(100, rx)));
    setMouseY(Math.max(0, Math.min(100, ry)));
  }, []);

  useEffect(() => {
    if (isHovered) {
      window.addEventListener('mousemove', handleMouseMove);
      return () => window.removeEventListener('mousemove', handleMouseMove);
    }
  }, [isHovered, handleMouseMove]);

  return (
    <button
      ref={containerRef}
      className={`relative rounded-full outline-none ${className}`}
      onClick={onClick}
      disabled={disabled}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => { setIsHovered(false); setMouseX(60); setMouseY(50); }}
    >
      {/* Inner container */}
      <div className="relative rounded-full w-full h-full overflow-hidden">
        {/* Background */}
        <div
          className="absolute inset-0 rounded-full"
          style={{
            background: 'rgba(38, 38, 56, 0.56)',
            boxShadow: '0px -4px 16px -2px rgba(222, 206, 235, 0.24) inset',
            border: '1px solid rgba(255, 255, 255, 0.06)',
          }}
        />

        {/* Glow effect layer */}
        {isHovered && !disabled && (
          <div className="absolute inset-0 overflow-hidden rounded-full" style={{ transform: 'translateZ(0)' }}>
            {/* Layer 1 — large, colored */}
            <div
              className="absolute rounded-full pointer-events-none"
              style={{
                width: 64,
                height: 32,
                background: color,
                opacity: 0.95,
                filter: 'blur(10px)',
                mixBlendMode: 'plus-lighter',
                left: `${mouseX}%`,
                top: `${bigEllipseY}%`,
                transform: `translate(-50%, -50%) scaleX(${stretchFactor}) rotate(${rotation}deg)`,
                transition: 'transform 0.2s ease-out, left 0.15s ease-out, top 0.15s ease-out',
              }}
            />
            {/* Layer 2 — medium, lavender */}
            <div
              className="absolute rounded-full pointer-events-none"
              style={{
                width: 32,
                height: 16,
                background: '#F1E6FA',
                opacity: 0.88,
                filter: 'blur(9px)',
                mixBlendMode: 'plus-lighter',
                left: `${mouseX}%`,
                top: `${mouseY}%`,
                transform: `translate(-50%, -50%) scaleX(${stretchFactor}) rotate(${rotation}deg)`,
                transition: 'transform 0.3s ease-out, left 0.15s ease-out, top 0.15s ease-out',
              }}
            />
            {/* Layer 3 — small, tight */}
            <div
              className="absolute rounded-full pointer-events-none"
              style={{
                width: 8,
                height: 8,
                background: '#F1E6FA',
                opacity: 0.98,
                filter: 'blur(10px)',
                mixBlendMode: 'plus-lighter',
                left: `${mouseX}%`,
                top: `${mouseY}%`,
                transform: `translate(-50%, -50%) scaleX(${stretchFactor * 0.8}) rotate(${rotation}deg)`,
                transition: 'transform 0.3s ease-out, left 0.15s ease-out, top 0.15s ease-out',
              }}
            />
          </div>
        )}

        {/* Content (above glow) */}
        <div className="relative z-10 flex items-center justify-center gap-2 h-9 px-4 text-sm font-semibold text-lavender tracking-wide">
          {children}
        </div>
      </div>
    </button>
  );
}
