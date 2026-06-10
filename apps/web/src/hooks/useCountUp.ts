import { useEffect, useRef, useState } from "react";

const prefersReducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

// easeOutCubic — fast start, gentle settle.
const ease = (t: number) => 1 - (1 - t) ** 3;

/**
 * Animates a number from its previous value up to `target` over `durationMs`,
 * returning the current frame's integer value. Pass `undefined` while the value
 * is still loading — the hook holds at 0 and animates once a number arrives.
 *
 * Honors prefers-reduced-motion (snaps straight to the target).
 */
export function useCountUp(
  target: number | undefined,
  {
    durationMs = 900,
    delayMs = 0,
  }: { durationMs?: number; delayMs?: number } = {},
): number {
  const [value, setValue] = useState(0);
  const fromRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (target === undefined) return;

    if (prefersReducedMotion()) {
      setValue(target);
      fromRef.current = target;
      return;
    }

    const from = fromRef.current;
    const start = performance.now() + delayMs;

    const tick = (now: number) => {
      const elapsed = now - start;
      if (elapsed < 0) {
        rafRef.current = requestAnimationFrame(tick);
        return;
      }
      const t = Math.min(1, elapsed / durationMs);
      setValue(Math.round(from + (target - from) * ease(t)));
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
    };
  }, [target, durationMs, delayMs]);

  return value;
}
