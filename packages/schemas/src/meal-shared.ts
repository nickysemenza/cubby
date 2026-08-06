import { z } from "zod";
import { plainDate } from "./base-entity";

export const mealScale = z.number().min(0.01).max(1000);

export const mealDate = plainDate;

export const mealDateRange = z.object({ from: mealDate, to: mealDate });
