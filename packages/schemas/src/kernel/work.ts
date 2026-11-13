import { z } from "zod";

import { passWork, kernelWaitCause } from "./machinery";
import { kernelGap, kernelStage } from "./stage";

export const needsYouPage = z.object({
  items: z.array(
    z.object({
      entity: z.string(),
      shortcode: z.string(),
      stage: kernelStage,
      firstGap: z.string(),
      actions: kernelGap.shape.actions,
      since: z.iso.datetime().nullable(),
    }),
  ),
  count: z.number().int().nonnegative(),
});
export type NeedsYouPage = z.infer<typeof needsYouPage>;

export const runWork = z.object({
  scopes: z.array(
    z.object({
      kind: z.string(),
      key: z.string(),
      stage: kernelStage,
      firstGap: z.string().nullable(),
      costMicros: z.number().int().nonnegative(),
    }),
  ),
  asks: z.array(
    z.object({
      inputHash: z.string(),
      feature: z.string(),
      state: z.enum(["queued", "sent", "answered", "unknown", "abandoned"]),
      stage: kernelStage,
      waitCause: kernelWaitCause.nullable(),
      availableAt: z.iso.datetime(),
      costMicros: z.number().int().nonnegative(),
    }),
  ),
  passes: z.array(passWork),
  totalCostMicros: z.number().int().nonnegative(),
});
export type RunWork = z.infer<typeof runWork>;
