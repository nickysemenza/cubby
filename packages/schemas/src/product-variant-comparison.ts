import { z } from "zod";

const fact = z.object({
  first: z.string().nullable(),
  second: z.string().nullable(),
  relation: z.enum(["same", "different", "unknown"]),
});

/** Explicit words in two Product titles; neither side is a reading of the photo. */
export const productVariantComparison = z.object({
  color: fact,
  size: fact,
});
export type ProductVariantComparison = z.infer<typeof productVariantComparison>;
