import { z } from "zod";

import { sweepFieldTargets } from "./run-fields";

/** A Sweep as a member or agent asks for it: entity scopes by shortcode. */
export const sweepStartInput = z.strictObject({
  families: z
    .array(
      z.discriminatedUnion("family", [
        z.strictObject({
          family: z.literal("field"),
          targets: sweepFieldTargets.optional(),
        }),
      ]),
    )
    .min(1)
    .max(2),
});
export type SweepStartInput = z.infer<typeof sweepStartInput>;
export const sweepEstimateOut = z.object({
  families: z.array(
    z.object({
      family: z.enum(["field"]),
      records: z.number().int().nonnegative(),
    }),
  ),
});
