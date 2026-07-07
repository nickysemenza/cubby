import { type ReactNode, useEffect, useRef, useState } from "react";

interface LazyMountProps {
  children: ReactNode;
  /** Reserves space so late-mounting content doesn't shift the page. */
  minHeight?: number;
}

/**
 * Defers mounting (and therefore any queries) of below-the-fold content until
 * the wrapper scrolls near the viewport. Once mounted it stays mounted.
 * Pre-loads slightly ahead of the fold (200px rootMargin) so content is
 * usually ready by the time it's visible.
 */
export function LazyMount({ children, minHeight = 200 }: LazyMountProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    if (mounted) return;
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setMounted(true);
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [mounted]);

  return (
    <div ref={ref} style={mounted ? undefined : { minHeight }}>
      {mounted ? children : null}
    </div>
  );
}
