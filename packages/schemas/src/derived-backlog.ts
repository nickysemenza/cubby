import { z } from "zod";
import { entitySchema } from "./entity-core";

export const derivedBacklog = z.object({
  total: z.number().int().nonnegative(),
  kinds: z.array(
    z.object({
      entity: entitySchema,
      field: z.string(),
      count: z.number().int().nonnegative(),
    }),
  ),
  /** How long the oldest waiting value has waited; null when none waits. */
  oldestWaitingSeconds: z.number().int().nonnegative().nullable(),
  /**
   * Values published per minute over the last `windowMinutes`, oldest first,
   * so a backlog that clears between reads still shows the work it did.
   */
  recent: z.object({
    windowMinutes: z.number().int().positive(),
    perMinute: z.array(z.number().int().nonnegative()),
  }),
});
export type DerivedBacklog = z.infer<typeof derivedBacklog>;
