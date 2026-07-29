import { z } from "zod";

const dateParam = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);

export const calendarSearchSchema = z.object({
  date: dateParam,
  day: dateParam,
  kinds: z.string().optional().catch(undefined),
  projectKinds: z.string().optional().catch(undefined),
});

export const calendarSearchDefaults = {
  date: undefined,
  day: undefined,
  kinds: undefined,
  projectKinds: undefined,
} as const;
