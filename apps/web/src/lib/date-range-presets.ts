import { match } from "ts-pattern";

import {
  householdLocalDate,
  shiftPlainDate,
  shiftPlainDateMonths,
} from "./household-date";

/** Relative filters stay relative in saved views; import callers freeze these bounds on selection. */
export function resolveDateRange(
  preset: string | undefined,
  today = householdLocalDate(),
): { dateFrom?: string; dateTo?: string } {
  const dateFrom = match(preset)
    .with("1m", () => shiftPlainDateMonths(today, -1))
    .with("30d", () => shiftPlainDate(today, -30))
    .with("90d", () => shiftPlainDate(today, -90))
    .with("ytd", () => `${today.slice(0, 4)}-01-01`)
    .with("1y", () => shiftPlainDateMonths(today, -12))
    .otherwise(() => undefined);
  return dateFrom ? { dateFrom, dateTo: today } : {};
}
