import { useSyncExternalStore } from "react";
import { FLAG_KEYS, FLAGS, type FlagKey } from "./flags";

/**
 * Flag store. A module-level cache keeps every flag's value in memory so
 * `getFlag` is an O(1) object read (it runs on the WASM hot path) — never a
 * localStorage hit per call. The cache is rebuilt whenever a `storage` event
 * fires (cross-tab, and same-tab because `setFlag` dispatches one, mirroring
 * `useLocalStorage`).
 */
const listeners = new Set<() => void>();
let cache: Record<FlagKey, boolean> | null = null;
let installed = false;

function readFlag(key: FlagKey): boolean {
  const def = FLAGS[key];
  if (typeof window === "undefined") return def.default;
  try {
    const raw = window.localStorage.getItem(def.storageKey);
    return raw === null ? def.default : (JSON.parse(raw) as boolean);
  } catch {
    return def.default;
  }
}

function buildCache(): Record<FlagKey, boolean> {
  const out = {} as Record<FlagKey, boolean>;
  for (const key of FLAG_KEYS) out[key] = readFlag(key);
  return out;
}

function ensureCache(): Record<FlagKey, boolean> {
  if (cache === null) {
    cache = buildCache();
    if (typeof window !== "undefined" && !installed) {
      installed = true;
      const flagStorageKeys = new Set<string>(
        FLAG_KEYS.map((k) => FLAGS[k].storageKey),
      );
      window.addEventListener("storage", (e) => {
        // null key = storage cleared; otherwise only react to flag keys.
        if (e.key !== null && !flagStorageKeys.has(e.key)) return;
        cache = buildCache();
        for (const listener of listeners) listener();
      });
    }
  }
  return cache;
}

/** Synchronous read for hot paths (e.g. the WASM proxy). Cheap after first call. */
export function getFlag(key: FlagKey): boolean {
  return ensureCache()[key];
}

export function setFlag(key: FlagKey, value: boolean): void {
  if (typeof window === "undefined") return;
  const { storageKey } = FLAGS[key];
  try {
    const json = JSON.stringify(value);
    window.localStorage.setItem(storageKey, json);
    // Notify this tab (native `storage` only fires in other tabs).
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        newValue: json,
        storageArea: window.localStorage,
      }),
    );
  } catch (error) {
    console.error(`Error setting flag "${key}":`, error);
  }
}

export function resetFlags(): void {
  if (typeof window === "undefined") return;
  for (const key of FLAG_KEYS) {
    window.localStorage.removeItem(FLAGS[key].storageKey);
  }
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: null,
      storageArea: window.localStorage,
    }),
  );
}

function subscribe(callback: () => void): () => void {
  listeners.add(callback);
  return () => listeners.delete(callback);
}

/** Reactive single-flag read for components. */
export function useFlag(key: FlagKey): boolean {
  return useSyncExternalStore(
    subscribe,
    () => getFlag(key),
    () => FLAGS[key].default,
  );
}

// Stable server snapshot (must be cached, or useSyncExternalStore warns about an
// infinite loop). All-defaults on the server; safe to reuse across requests.
let serverSnapshot: Record<FlagKey, boolean> | null = null;
function getServerSnapshot(): Record<FlagKey, boolean> {
  serverSnapshot ??= buildCache();
  return serverSnapshot;
}

/** All flag values + setters, for the settings page. */
export function useFlags(): {
  flags: Record<FlagKey, boolean>;
  setFlag: typeof setFlag;
  resetFlags: typeof resetFlags;
} {
  const flags = useSyncExternalStore(subscribe, ensureCache, getServerSnapshot);
  return { flags, setFlag, resetFlags };
}
