import { useState, useEffect, useRef, type DependencyList } from "react";

export interface CancellationSignal {
  cancelled: boolean;
}

/**
 * Check if two values are equivalent for the purpose of avoiding re-renders.
 * Handles empty objects/arrays specially to prevent unnecessary updates.
 */
function isEquivalent<T>(a: T, b: T): boolean {
  // Same reference
  if (a === b) return true;

  // Both are empty objects
  if (
    typeof a === "object" &&
    a !== null &&
    typeof b === "object" &&
    b !== null &&
    !Array.isArray(a) &&
    !Array.isArray(b) &&
    Object.keys(a).length === 0 &&
    Object.keys(b).length === 0
  ) {
    return true;
  }

  return false;
}

/**
 * Like useMemo, but for async operations with cancellation support.
 *
 * Returns the initial value until the async function resolves.
 * If dependencies change before the async function completes,
 * the stale result is discarded.
 *
 * @example
 * ```tsx
 * // Use Promise.all for parallel execution (preferred for performance)
 * const mappings = useAsyncMemo(
 *   async (signal) => {
 *     const entries = await Promise.all(
 *       data.map(async (item) => [item.id, await fetchData(item)] as const)
 *     );
 *     if (signal.cancelled) return {};
 *     return Object.fromEntries(entries);
 *   },
 *   [data],
 *   {}
 * );
 * ```
 */
export function useAsyncMemo<T>(
  asyncFn: (signal: CancellationSignal) => Promise<T>,
  deps: DependencyList,
  initialValue: T,
): T {
  const [value, setValue] = useState<T>(initialValue);
  const valueRef = useRef<T>(initialValue);

  useEffect(() => {
    const signal: CancellationSignal = { cancelled: false };

    void (async () => {
      const result = await asyncFn(signal);
      if (!signal.cancelled) {
        // Only update state if the result is meaningfully different
        // This prevents re-renders when returning equivalent empty objects
        if (!isEquivalent(valueRef.current, result)) {
          valueRef.current = result;
          setValue(result);
        }
      }
    })();

    return () => {
      signal.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
