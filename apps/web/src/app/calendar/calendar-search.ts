import { z } from "zod";

import { urlStringParam } from "~/lib/search-params";

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

export const calendarPeriodParam = z
  .enum(["month", "fortnight", "week"])
  .optional()
  .catch(undefined);

const calendarViewPeriodParam = z
  .enum(["month", "fortnight", "week", "schedule"])
  .optional()
  .catch(undefined);

/**
 * Filter params are {@link urlStringParam}, not `z.string()`.
 *
 * TanStack JSON-parses every search param, so `?future=true` arrives as the
 * BOOLEAN `true` — and a bare `z.string()` rejects it straight into
 * `.catch(undefined)`, leaving an unfiltered calendar that reads as a real
 * answer. `futureFilterOptions`' values are literally `"true"` / `"false"`,
 * so this is the live case, not a hypothetical one.
 *
 * Keys must match `calendarFilterSpecs`' URL keys exactly — a strict `z.object`
 * strips anything it doesn't declare, so an undeclared key would be written to
 * the URL and removed again before the bar could read it back.
 * `calendar-filter-specs.unit.test.ts` asserts the two stay in step.
 */
export const calendarSearchSchema = z.object({
  period: calendarViewPeriodParam,
  date: dateParam,
  day: dateParam,
  kinds: urlStringParam,
  project: urlStringParam,
  taskStatus: urlStringParam,
  taskTrade: urlStringParam,
  vendor: urlStringParam,
  future: urlStringParam,
  projectStatus: urlStringParam,
  projectKinds: urlStringParam,
});

/**
 * Every key must appear here, or `stripSearchParams` leaves a cleared filter
 * in the URL forever.
 */
export const calendarSearchDefaults = {
  period: undefined,
  date: undefined,
  day: undefined,
  kinds: undefined,
  project: undefined,
  taskStatus: undefined,
  taskTrade: undefined,
  vendor: undefined,
  future: undefined,
  projectStatus: undefined,
  projectKinds: undefined,
} as const;
