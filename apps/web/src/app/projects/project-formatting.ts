import { TRADE_LABELS } from "@cubby/schemas/project";
import { capitalize } from "@cubby/shared";

import { formatCalendarDay } from "~/lib/date-format";
import { plainDateDaysBetween } from "~/lib/household-date";
import { parsePlainDate } from "~/lib/plain-date";

export { capitalize } from "@cubby/shared";

export { PROJECT_STATUS_LABELS } from "@cubby/schemas/project-fields";

export function monthLabel(key: string): string {
  const [year, month] = key.split("-");
  return formatCalendarDay(
    new Date(Number(year), Number(month) - 1, 1),
    "monthYearCompact",
  );
}

// NOTE: shared across the app (task due-date ranges, project date ranges,
// trade activity, etc) — see grep for `formatDateRange` before changing its
// output shape further.
export function formatDateRange(
  start: string | null,
  end: string | null,
): string {
  if (!start) return "No date";
  if (!end) return formatCalendarDay(start, "monthDay");
  // Most callers are short same-year ranges (a task's due window), where the
  // year would just be noise. But a project can span years (e.g. Dec 2025 →
  // Jul 2027) and "Dec 1 — Jul 1" silently drops which December/July —
  // include the year on both ends whenever the range crosses one.
  const crossesYear =
    parsePlainDate(start).getFullYear() !== parsePlainDate(end).getFullYear();
  return crossesYear
    ? `${formatCalendarDay(start, "dateShort")} — ${formatCalendarDay(end, "dateShort")}`
    : `${formatCalendarDay(start, "monthDay")} — ${formatCalendarDay(end, "monthDay")}`;
}

/**
 * A project date override's divergence from the derived bound, as a signed
 * day count plus whether that override NARROWS the window (hides real dated
 * work — the `date_window_drift` attention rule's condition) or merely widens
 * it (deliberate slack, e.g. an end date set out ahead of the last dated
 * expense). `days` is `effective - derived`, so a positive value always means
 * the override sits later on the calendar, whichever side it is.
 */
export interface ProjectDateDelta {
  days: number;
  narrows: boolean;
  label: string;
  description: string;
}

/**
 * Describe how an explicit start/end override diverges from the derived
 * bound. Returns null when they agree (nothing to show). Both arguments are
 * plain "YYYY-MM-DD" strings; the math goes through `plainDateDaysBetween`' UTC day
 * index, never a local `Date`.
 */
export function projectDateDelta(
  side: "start" | "end",
  derived: string,
  effective: string,
): ProjectDateDelta | null {
  const days = plainDateDaysBetween(derived, effective);
  if (days === 0) return null;
  const magnitude = Math.abs(days);
  const unit = `${magnitude} day${magnitude === 1 ? "" : "s"}`;
  const direction = days > 0 ? "after" : "before";
  const anchor = side === "start" ? "earliest dated work" : "latest dated work";
  // Narrowing = the override cuts into real dated work: a start set later
  // than the earliest work, or an end set earlier than the latest.
  const narrows = side === "start" ? days > 0 : days < 0;
  return {
    days,
    narrows,
    label: `${days > 0 ? "+" : "-"}${magnitude}d`,
    description: narrows
      ? `${capitalize(side)} is ${unit} ${direction} the ${anchor} — that work falls outside the window`
      : `${capitalize(side)} is ${unit} ${direction} the ${anchor}`,
  };
}

export { TRADE_LABELS };
