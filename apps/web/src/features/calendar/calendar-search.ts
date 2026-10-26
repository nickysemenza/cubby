import { z } from "zod";

import { compileFilterCodec } from "~/entity/filters";
import { urlStringParam } from "~/lib/search-params";

import { calendarFilterSpecs } from "./calendar-filter-specs";

export const calendarDateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

export const calendarPeriodParam = z
  .enum(["month", "fortnight", "week"])
  .optional()
  .catch(undefined);

const calendarViewPeriodParam = z
  .enum([
    "month",
    "fortnight",
    "week",
    "quarter",
    "half-year",
    "year",
    "schedule",
  ])
  .optional()
  .catch(undefined);

/** Filter URL keys follow their source declarations. */
export const calendarSearchSchema = z.object({
  period: calendarViewPeriodParam,
  date: calendarDateParam,
  day: calendarDateParam,
  ...Object.fromEntries(
    compileFilterCodec(calendarFilterSpecs).keys.map((key) => [
      key,
      urlStringParam,
    ]),
  ),
});
export const calendarSearchDefaults = Object.fromEntries(
  Object.keys(calendarSearchSchema.shape).map((key) => [key, undefined]),
);
