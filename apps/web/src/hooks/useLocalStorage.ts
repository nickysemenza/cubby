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

  const getSnapshot = useCallback(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item !== null ? (JSON.parse(item) as T) : initialValue;
    } catch (error) {
      console.error(`Error loading localStorage key "${key}":`, error);
      return initialValue;
    }
  }, [key, initialValue]);

  const getServerSnapshot = useCallback(() => initialValue, [initialValue]);

  const storedValue = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      try {
        const currentValue = getSnapshot();
        const valueToStore =
          value instanceof Function ? value(currentValue) : value;

        window.localStorage.setItem(key, JSON.stringify(valueToStore));
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
