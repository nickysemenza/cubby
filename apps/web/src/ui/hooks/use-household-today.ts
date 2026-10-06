import { useCallback, useSyncExternalStore } from "react";

import {
  householdDateTime,
  householdDaysFromNow,
  householdLocalDate,
} from "~/lib/household-date";

const listeners = new Set<() => void>();
let today: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function refresh() {
  const now = new Date();
  const next = householdLocalDate(now);
  if (next !== today) {
    today = next;
    for (const listener of listeners) listener();
  }
  clearTimeout(timer);
  timer = setTimeout(
    refresh,
    householdDateTime(householdDaysFromNow(1, now)).getTime() -
      now.getTime() +
      100,
  );
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
      today = undefined;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    }
  };
}

const getSnapshot = () => today;

/** One household-day clock for mounted labels, including DST and sleep/wake. */
export function useHouseholdToday(initialDate?: string) {
  const getServerSnapshot = useCallback(() => initialDate, [initialDate]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
