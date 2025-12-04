import { useState, useEffect, type DependencyList } from "react";

export interface CancellationSignal {
  cancelled: boolean;
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
 * const mappings = useAsyncMemo(
 *   async (signal) => {
 *     const result = {};
 *     for (const item of data) {
 *       if (signal.cancelled) return result;
 *       result[item.id] = await fetchData(item);
 *     }
 *     return result;
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

  useEffect(() => {
    const signal: CancellationSignal = { cancelled: false };

    void (async () => {
      const result = await asyncFn(signal);
      if (!signal.cancelled) {
        setValue(result);
      }
    })();

    return () => {
      signal.cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return value;
}
