import { useEffect, useState } from "react";

// Exclude function types - useDebounce is for values, not callbacks
// biome-ignore lint/complexity/noBannedTypes: intentional use of Function type for exclusion
type NonFunction<T> = T extends Function ? never : T;

/**
 * Debounces a value by the specified delay.
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
