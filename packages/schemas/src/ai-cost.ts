import { z } from "zod";
export { aiCostEvidenceSchema } from "@cubby/shared/ai/pricing";
export type { AiCostEvidence } from "@cubby/shared/ai/pricing";
import { aiCostEvidenceSchema } from "@cubby/shared/ai/pricing";
export const aiCallCostFields = {
  standardCost: z.number().nullable(),
  chargedCost: z.number().nullable(),
  costEvidence: aiCostEvidenceSchema.nullable(),
};
export const aiCostSummaryFields = {
  standardCost: z.number(),
  chargedCost: z.number(),
  standardUnpricedCount: z.number().int().nonnegative(),
  chargedUnpricedCount: z.number().int().nonnegative(),
  savings: z.number(),
  comparedCalls: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  billingReasons: z.array(aiCostEvidenceSchema.shape.billingReason).optional(),
  standardComplete: z.boolean().optional(),
  chargedComplete: z.boolean().optional(),
};
