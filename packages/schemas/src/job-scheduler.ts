import { z } from "zod";
import { jobShortcode } from "./identifiers";

export const schedulerDeadline = z.object({
  job: jobShortcode,
  kind: z.string(),
  at: z.iso.datetime(),
  reason: z.enum(["available", "lease-expiry"]),
});
export const schedulerEvent = z.object({
  id: z.uuid(),
  job: jobShortcode.nullable().default(null),
  at: z.iso.datetime(),
  event: z.string(),
  cause: z.string(),
  error: z.string().nullable(),
});
export const schedulerSnapshot = z.object({
  observedAt: z.iso.datetime().nullable(),
  deadlines: z.array(schedulerDeadline),
  alarmAt: z.iso.datetime().nullable(),
  deliveryPendingSince: z.iso.datetime().nullable(),
  deliveryAttempts: z.number(),
  observationAttempts: z.number().default(0),
  observationError: z.string().nullable().default(null),
  lastRecovery: z
    .object({
      at: z.iso.datetime(),
      cause: z.string(),
      error: z.string().nullable(),
    })
    .nullable(),
  events: z.array(schedulerEvent),
});
export type SchedulerSnapshot = z.infer<typeof schedulerSnapshot>;
