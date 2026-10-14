import { z } from "zod";

const relation = z.object({
  relation: z.enum(["same", "different", "unknown"]),
});

/** Closed model judgments plus the original source titles used as evidence. */
export const productVariantComparison = z.object({
  color: relation,
  size: relation,
  evidence: z.object({
    firstTitle: z.string(),
    secondTitle: z.string(),
  }),
});
export type ProductVariantComparison = z.infer<typeof productVariantComparison>;
