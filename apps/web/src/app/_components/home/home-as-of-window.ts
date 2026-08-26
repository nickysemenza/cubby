import { householdDaysFromNow, householdLocalDate } from "~/lib/household-date";

const MONTH_COUNT = 6;

export interface HomeAsOfWindow {
  meals: { from: string; to: string };
  spend: {
    months: string[];
    filters: { dateFrom: string; dateTo: string; future: false };
  };
}

function monthKey(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function calendarDate(year: number, month: number, day: number): string {
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
}

/** Shared household-local query inputs for SSR and hydration. */
export function getHomeAsOfWindow(now: Date = new Date()): HomeAsOfWindow {
  const today = householdLocalDate(now);
  const [year, month] = today.split("-").map(Number);
  if (year == null || month == null) {
    throw new Error(`Could not resolve household date: ${today}`);
  }

  const months = Array.from({ length: MONTH_COUNT }, (_, index) => {
    const offset = month - (MONTH_COUNT - 1) + index;
    const adjustedYear = year + Math.floor((offset - 1) / 12);
    const adjustedMonth = ((offset - 1 + 12) % 12) + 1;
    return monthKey(adjustedYear, adjustedMonth);
  });
  const firstMonth = months[0]!;

  return {
    meals: { from: today, to: householdDaysFromNow(6, now) },
    spend: {
      months,
      filters: {
        dateFrom: `${firstMonth}-01`,
        dateTo: calendarDate(year, month + 1, 0),
        future: false,
      },
    },
  };
}
