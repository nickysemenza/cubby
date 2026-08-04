import { z } from "zod";
import { plainDate } from "./base-entity";

/** Scale multiplier for a planned recipe (e.g. 1.5x). */
export const mealScale = z.number().min(0.01).max(1000);

/** A calendar day as a plain "YYYY-MM-DD" string, timezone-free. */
export const mealDate = plainDate;

/** An inclusive [from, to] calendar-day range (both required). */
export const mealDateRange = z.object({ from: mealDate, to: mealDate });
