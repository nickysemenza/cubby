import { useEffect, useState } from "react";

import {
  householdDateTime,
  householdDaysFromNow,
  householdLocalDate,
} from "~/lib/household-date";

/** Keep an open nutrition page on the household day, including DST and sleep/wake. */
export function useHouseholdToday(initialDate?: string) {
  const [today, setToday] = useState(initialDate);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      const now = new Date();
      setToday(householdLocalDate(now));
      clearTimeout(timer);
      timer = setTimeout(
        refresh,
        householdDateTime(householdDaysFromNow(1, now)).getTime() -
          now.getTime() +
          100,
      );
    };
    refresh();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return today;
}
