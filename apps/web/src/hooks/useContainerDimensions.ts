import { type RefObject, useEffect, useState } from "react";

interface Dimensions {
  width: number;
  height: number;
}

/**
 * Hook to track container dimensions with ResizeObserver.
 * Commonly used for responsive D3 visualizations.
 *
 * @param containerRef - Ref to the container element
 * @param minHeight - Minimum height to enforce (default: 300)
 * @param initialWidth - Initial width before measurement (default: 400)
 * @param initialHeight - Initial height before measurement (default: minHeight)
 */
export function useContainerDimensions(
  containerRef: RefObject<HTMLDivElement | null>,
  options: {
    minHeight?: number;
    initialWidth?: number;
    initialHeight?: number;
  } = {},
): Dimensions {
  const { minHeight = 300, initialWidth = 400, initialHeight } = options;
  const [dimensions, setDimensions] = useState<Dimensions>({
    width: initialWidth,
    height: initialHeight ?? minHeight,
  });

  // Initial measurement
  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDimensions({ width, height: Math.max(height, minHeight) });
    }
  }, [containerRef, minHeight]);

  // ResizeObserver for responsive updates
  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setDimensions({ width, height: Math.max(height, minHeight) });
      }
    });

    observer.observe(element);
    return () => observer.disconnect();
  }, [containerRef, minHeight]);

  return dimensions;
}
