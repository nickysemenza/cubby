import { type RefObject, useEffect, useState } from "react";

interface Dimensions {
  width: number;
  height: number;
}

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

  useEffect(() => {
    if (containerRef.current) {
      const { width, height } = containerRef.current.getBoundingClientRect();
      setDimensions({ width, height: Math.max(height, minHeight) });
    }
  }, [containerRef, minHeight]);

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
