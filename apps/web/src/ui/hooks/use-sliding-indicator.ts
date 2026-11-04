import { useLayoutEffect, useRef } from "react";

/**
 * Places one indicator element under the container's `[data-indicator-active]`
 * descendant, so a current marker travels instead of jumping between entries.
 * The first placement waits for a frame before arming the transition, or the
 * indicator would fly in from the container's corner on mount.
 */
export function useSlidingIndicator<Container extends HTMLElement>(
  activeKey: string | undefined,
) {
  const containerRef = useRef<Container>(null);
  const indicatorRef = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const indicator = indicatorRef.current;
    if (!container || !indicator) return;
    const place = () => {
      const active = container.querySelector("[data-indicator-active]");
      indicator.hidden = !active;
      if (!active) return;
      const box = container.getBoundingClientRect();
      const rect = active.getBoundingClientRect();
      indicator.style.setProperty(
        "--indicator-x",
        `${rect.left - box.left + container.scrollLeft}px`,
      );
      indicator.style.setProperty(
        "--indicator-y",
        `${rect.top - box.top + container.scrollTop}px`,
      );
      indicator.style.setProperty("--indicator-w", `${rect.width}px`);
      indicator.style.setProperty("--indicator-h", `${rect.height}px`);
    };
    place();
    const frame = requestAnimationFrame(() => {
      indicator.dataset.armed = "";
    });
    const observer =
      "ResizeObserver" in window ? new ResizeObserver(place) : null;
    observer?.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer?.disconnect();
    };
  }, [activeKey]);
  return { containerRef, indicatorRef };
}
