import { useCallback, useEffect, useState } from 'react';

export interface SectionNavItem {
  id: string;
  label: string;
}

interface SectionNavProps {
  sections: SectionNavItem[];
  /** Tailwind offset from the top of the viewport — should match the height
   *  of the main Header so this bar tucks just under it when sticky. */
  topOffsetClass?: string;
  /** Pixel offset used for scroll-to so anchors land below both the main
   *  header AND this nav. */
  scrollOffsetPx?: number;
}

/**
 * Sticky horizontal jump-nav. Highlights whichever section is currently
 * closest to the top of the viewport using IntersectionObserver.
 */
export function SectionNav({
  sections,
  topOffsetClass = 'top-[68px]',
  scrollOffsetPx = 130,
}: SectionNavProps) {
  const [activeId, setActiveId] = useState<string>(sections[0]?.id ?? '');

  // Track which section is currently in view. We observe each section and
  // pick the top-most one that's intersecting the viewport.
  useEffect(() => {
    const elements = sections
      .map(s => document.getElementById(s.id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) return;

    const observer = new IntersectionObserver(
      entries => {
        // Each tick: find the first intersecting section in document order.
        const visible = entries
          .filter(e => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible.length > 0) {
          setActiveId(visible[0].target.id);
        }
      },
      // rootMargin trims the viewport: top trim matches header+nav so we
      // don't activate a section that's only peeking under the bars.
      { rootMargin: `-${scrollOffsetPx}px 0px -50% 0px`, threshold: 0 }
    );

    elements.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [sections, scrollOffsetPx]);

  const scrollTo = useCallback(
    (id: string) => {
      const el = document.getElementById(id);
      if (!el) return;
      const y = el.getBoundingClientRect().top + window.scrollY - scrollOffsetPx;
      window.scrollTo({ top: y, behavior: 'smooth' });
      setActiveId(id);
    },
    [scrollOffsetPx]
  );

  return (
    <nav
      className={`sticky ${topOffsetClass} z-40 border-b border-white/5`}
      style={{
        background: 'rgba(20, 20, 31, 0.85)',
        backdropFilter: 'blur(20px)',
      }}
      aria-label="Section navigation"
    >
      <div className="w-full max-w-[1400px] mx-auto px-3 lg:px-6">
        {/* Horizontal scroll on narrow viewports so links never wrap. */}
        <div className="flex gap-1 overflow-x-auto no-scrollbar py-2">
          {sections.map(s => {
            const isActive = s.id === activeId;
            return (
              <button
                key={s.id}
                onClick={() => scrollTo(s.id)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
                  isActive
                    ? 'bg-purple/25 text-white border border-purple/40'
                    : 'text-soft-gray border border-transparent hover:bg-white/[0.05] hover:text-lavender'
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
      </div>
    </nav>
  );
}
