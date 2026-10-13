import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let now: number | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function refresh() {
  now = Date.now();
  for (const listener of listeners) listener();
  clearTimeout(timer);
  timer = setTimeout(refresh, 60_000 - (now % 60_000));
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    refresh();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      clearTimeout(timer);
      timer = undefined;
      now = undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

const getSnapshot = () => now;
const getServerSnapshot = () => undefined;

/** One minute clock for mounted dates, refreshed on sleep/wake and focus. */
export function useDisplayNow() {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
