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
});
export type DerivedBacklog = z.infer<typeof derivedBacklog>;
