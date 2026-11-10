import { useLayoutEffect, useState } from "react";

// The page's bottom padding below the grid.
const PAGE_GUTTER = 16;

/**
 * The element's width and the height left between its top edge and the
 * bottom of the page's main region (above the status footer and bottom app
 * chrome), so a calendar grid can end at the window's edge. The ref is a
 * callback: the grid mounts only after the calendar loads.
 */
export function useViewportFill<T extends HTMLElement>() {
  const [element, ref] = useState<T | null>(null);
  const [size, setSize] = useState({ width: 1200, height: 600 });
  useLayoutEffect(() => {
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      if (!rect.width) return;
      const bottom =
        Number.parseFloat(
          getComputedStyle(element).getPropertyValue("--app-chrome-bottom"),
        ) || 0;
      // Capped at the window so a main region that grows with its content
      // cannot feed the grid's own height back into the measurement.
      const limit = Math.min(
        window.innerHeight,
        element.closest("main")?.getBoundingClientRect().bottom ?? Infinity,
      );
      const next = {
        width: rect.width,
        height: Math.max(160, limit - rect.top - bottom - PAGE_GUTTER),
      };
      setSize((previous) =>
        previous.width === next.width && previous.height === next.height
          ? previous
          : next,
      );
    };
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    if (element.parentElement) observer.observe(element.parentElement);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [element]);
  return [ref, size] as const;
}
