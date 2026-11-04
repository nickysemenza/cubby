import { z } from "zod";
import { entitySchema } from "./entity-core";

const backlogStatus = z.object({
  count: z.number().int().nonnegative(),
  refreshReasons: z
    .array(
      z.object({
        reason: z.string().nullable(),
        count: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  states: z
    .object({
      queued: z.number().int().nonnegative(),
      running: z.number().int().nonnegative(),
      waiting: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
    })
    .optional(),
  nextAttemptAt: z.iso.datetime().nullable().optional(),
});

export const derivedBacklog = z.object({
  total: z.number().int().nonnegative(),
  kinds: z.array(
    backlogStatus.extend({
      entity: entitySchema,
      field: z.string(),
    }),
  ),
  /** Internal records share the drain but have no public Entity field. */
  internal: z
    .array(backlogStatus.extend({ target: z.string(), label: z.string() }))
    .optional(),
  /** How long the oldest waiting value has waited; null when none waits. */
  oldestWaitingSeconds: z.number().int().nonnegative().nullable(),
  /**
   * Current committed publications by age over `windowMinutes`, oldest first.
   * A replacement moves that result's bucket; this is not an execution event rate.
   */
  recent: z.object({
    windowMinutes: z.number().int().positive(),
    perMinute: z.array(z.number().int().nonnegative()),
    sources: z
      .array(
        z.object({
          target: z.string().nullable(),
          label: z.string(),
          perMinute: z.array(z.number().int().nonnegative()),
        }),
      )
      .optional(),
  }),
});
export type DerivedBacklog = z.infer<typeof derivedBacklog>;
