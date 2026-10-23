import { moneyNullable } from "./money";
import { timestampedFields } from "./base-entity";
import { productShortcode } from "./identifier-fields";
import { z } from "zod";

export const wishCandidateOut = z.object({
  id: productShortcode,
  name: z.string(),
  brandName: z.string().nullable(),
  model: z.string().nullable(),
  price: moneyNullable,
  inventoried: z.boolean(),
  ...timestampedFields,
});
export type WishCandidateOut = z.infer<typeof wishCandidateOut>;

export const wishPriceRangeOut = z.object({
  low: z.number(),
  high: z.number(),
  pricedCount: z.number().int().nonnegative(),
});
export type WishPriceRange = z.infer<typeof wishPriceRangeOut>;
