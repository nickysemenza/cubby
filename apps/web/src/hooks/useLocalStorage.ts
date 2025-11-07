import { useCallback, useSyncExternalStore } from "react";

/**
 * Custom hook for managing localStorage with SSR support and type safety
 * Uses useSyncExternalStore for proper React 18+ external store synchronization
 * @param key - The localStorage key
 * @param initialValue - The initial value if no stored value exists
 * @returns A tuple of [storedValue, setValue] similar to useState
 */
export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  // Subscribe to localStorage changes
  const subscribe = useCallback(
    (callback: () => void) => {
      const handleStorageChange = (e: StorageEvent) => {
        if (e.key === key) {
          callback();
        }
      };

      window.addEventListener("storage", handleStorageChange);
      return () => window.removeEventListener("storage", handleStorageChange);
    },
    [key],
  );

  // Get the current value from localStorage
  const getSnapshot = useCallback(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item !== null ? (JSON.parse(item) as T) : initialValue;
    } catch (error) {
      console.error(`Error loading localStorage key "${key}":`, error);
      return initialValue;
    }
  }, [key, initialValue]);

  // Return initialValue for server-side rendering
  const getServerSnapshot = useCallback(() => initialValue, [initialValue]);

  // Sync with external store (localStorage)
  const storedValue = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  // Return a wrapped setter function that persists the new value to localStorage
  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        // Allow value to be a function so we have same API as useState
        const currentValue = getSnapshot();
        const valueToStore =
          value instanceof Function ? value(currentValue) : value;

        // Save to local storage (this will trigger the storage event in other tabs)
        window.localStorage.setItem(key, JSON.stringify(valueToStore));

        // Manually dispatch storage event for current tab
        window.dispatchEvent(
          new StorageEvent("storage", {
            key,
            newValue: JSON.stringify(valueToStore),
            oldValue: JSON.stringify(currentValue),
            storageArea: window.localStorage,
          }),
        );
      } catch (error) {
        console.error(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, getSnapshot],
  );

  return [storedValue, setValue];
}
