import { useState, useEffect } from "react";

// Exclude function types - useDebounce is for values, not callbacks
// eslint-disable-next-line @typescript-eslint/no-unsafe-function-type
type NonFunction<T> = T extends Function ? never : T;

/**
 * Debounces a value by the specified delay.
 *
 * @example
 * const [search, setSearch] = useState("");
 * const debouncedSearch = useDebounce(search, 300);
 *
 * useEffect(() => {
 *   // This runs 300ms after the user stops typing
 *   fetchResults(debouncedSearch);
 * }, [debouncedSearch]);
 */
export default function useDebounce<T>(
  value: NonFunction<T>,
  delay: number | undefined,
): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value as T);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [delay, value]);

  return debouncedValue;
}
