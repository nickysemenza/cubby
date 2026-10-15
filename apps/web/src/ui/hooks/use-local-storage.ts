import { useCallback, useRef, useSyncExternalStore } from "react";
import { z } from "zod";

type StorageValue<Schema extends z.ZodType> = z.output<Schema>;
type StorageUpdater<Value> = Value | ((previous: Value) => Value);

function isStorageUpdater<Value>(
  value: StorageUpdater<Value>,
): value is (previous: Value) => Value {
  return typeof value === "function";
}

export function useLocalStorage<Schema extends z.ZodType>(
  key: string,
  schema: Schema,
  initialValue: StorageValue<Schema>,
): [
  StorageValue<Schema>,
  (value: StorageUpdater<StorageValue<Schema>>) => void,
] {
  // Cache the parsed value to avoid infinite loops from JSON.parse returning new objects
  const cache = useRef<{
    raw: string | null;
    parsed: StorageValue<Schema>;
  }>({
    raw: null,
    parsed: initialValue,
  });

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
      if (item !== cache.current.raw) {
        cache.current.raw = item;
        const parsed =
          item === null ? null : schema.safeParse(JSON.parse(item));
        cache.current.parsed = parsed?.success ? parsed.data : initialValue;
      }
      return cache.current.parsed;
    } catch (error) {
      console.error(`Error loading localStorage key "${key}":`, error);
      return initialValue;
    }
  }, [key, schema, initialValue]);

  const getServerSnapshot = useCallback(() => initialValue, [initialValue]);

  const storedValue = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );

  const setValue = useCallback(
    (value: StorageUpdater<StorageValue<Schema>>) => {
      try {
        const currentValue = getSnapshot();
        const valueToStore = isStorageUpdater(value)
          ? value(currentValue)
          : value;

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
        // SILENT: private-mode/quota-exceeded localStorage throws on write; the
        // updated value stays in the in-memory `cache` for this session only
        // (already logged below via console.error).
        console.error(`Error setting localStorage key "${key}":`, error);
      }
    },
    [key, getSnapshot],
  );

  return [storedValue, setValue];
}
