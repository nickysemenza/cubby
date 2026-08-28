import { useSyncExternalStore } from "react";
import { z } from "zod";

import { FLAG_KEYS, FLAGS, type FlagKey } from "./flags";

/**
 * Flag store. A module-level cache keeps every flag's value in memory so
 * `getFlag` is an O(1) object read (it runs on the WASM hot path) — never a
 * localStorage hit per call. The cache is rebuilt whenever a `storage` event
 * fires (cross-tab, and same-tab because `setFlag` dispatches one, mirroring
 * `useLocalStorage`).
 */
const listeners = new Set<() => void>();
type FlagSnapshot = ReadonlyMap<FlagKey, boolean>;

let cache: FlagSnapshot | null = null;
let installed = false;

function readFlag(key: FlagKey): boolean {
  const def = FLAGS[key];
  const browserWindow = globalThis.window;
  if (!browserWindow) return def.default;
  try {
    const raw = browserWindow.localStorage.getItem(def.storageKey);
    if (raw === null) return def.default;
    const parsed = z.boolean().safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : def.default;
  } catch {
    return def.default;
  }
}

function buildCache(): FlagSnapshot {
  return new Map(FLAG_KEYS.map((key) => [key, readFlag(key)] as const));
}

function ensureCache(): FlagSnapshot {
  if (cache === null) {
    cache = buildCache();
    const browserWindow = globalThis.window;
    if (browserWindow && !installed) {
      installed = true;
      const flagStorageKeys = new Set<string>(
        FLAG_KEYS.map((k) => FLAGS[k].storageKey),
      );
      browserWindow.addEventListener("storage", (e) => {
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
  return ensureCache().get(key) ?? FLAGS[key].default;
}

export function setFlag(key: FlagKey, value: boolean): void {
  const browserWindow = globalThis.window;
  if (!browserWindow) return;
  const { storageKey } = FLAGS[key];
  try {
    const json = JSON.stringify(value);
    browserWindow.localStorage.setItem(storageKey, json);
    // Notify this tab (native `storage` only fires in other tabs).
    browserWindow.dispatchEvent(
      new StorageEvent("storage", {
        key: storageKey,
        newValue: json,
        storageArea: browserWindow.localStorage,
      }),
    );
  } catch (error) {
    console.error(`Error setting flag "${key}":`, error);
  }
}

function resetFlags(): void {
  const browserWindow = globalThis.window;
  if (!browserWindow) return;
  for (const key of FLAG_KEYS) {
    browserWindow.localStorage.removeItem(FLAGS[key].storageKey);
  }
  browserWindow.dispatchEvent(
    new StorageEvent("storage", {
      key: null,
      storageArea: browserWindow.localStorage,
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
let serverSnapshot: FlagSnapshot | null = null;
function getServerSnapshot(): FlagSnapshot {
  serverSnapshot ??= buildCache();
  return serverSnapshot;
}

/** All flag values + setters, for the settings page. */
interface FlagsController {
  flags: FlagSnapshot;
  setFlag: typeof setFlag;
  resetFlags: typeof resetFlags;
}

export function useFlags(): FlagsController {
  const flags = useSyncExternalStore(subscribe, ensureCache, getServerSnapshot);
  return { flags, setFlag, resetFlags };
}
