import { z } from "zod";
import { plainDate } from "./base-entity";

/** Shared historical filter choices; stored preset keys retain their meanings. */
export const historicalDateRangePresets = [
  { value: "1m", label: "Past month" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
  { value: "ytd", label: "Year to date" },
  { value: "1y", label: "Last 12 months" },
] as const;

/** Inclusive calendar dates; null bounds are unknown, never infinite timestamps. */
const calendarDate = plainDate.refine(
  (value) => z.iso.date().safeParse(value).success,
  "Expected a valid calendar date.",
);

export const storedDateRangeSchema = z.strictObject({
  start: calendarDate.nullable(),
  end: calendarDate.nullable(),
});

/** New writes are ordered; reads retain old stored bounds for correction. */
export const dateRangeSchema = storedDateRangeSchema.superRefine(
  (value, ctx) => {
    if (value.start === null && value.end === null)
      ctx.addIssue({
        code: "custom",
        message: "An empty date range must be null.",
      });
    if (value.start !== null && value.end !== null && value.end < value.start)
      ctx.addIssue({
        code: "custom",
        path: ["end"],
        message: "End must be on or after start.",
      });
  },
);
export type CalendarDateRange = z.infer<typeof dateRangeSchema>;

/** Physical columns stay unchanged; only the public value is composed. */
export function dateRangeFromDates(
  start: string | null,
  end: string | null,
): CalendarDateRange | null {
  return start === null && end === null ? null : { start, end };
}
