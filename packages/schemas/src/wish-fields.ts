import { moneyNullable } from "./money";
import { productShortcode } from "./identifier-fields";
import { z } from "zod";

export const wishCandidateOut = z.object({
  id: productShortcode,
  name: z.string(),
  manufacturer: z.string(),
  model: z.string().nullable(),
  price: moneyNullable,
  inventoried: z.boolean(),
});
export type WishCandidateOut = z.infer<typeof wishCandidateOut>;

export const wishPriceRangeOut = z.object({
  low: z.number(),
  high: z.number(),
  pricedCount: z.number().int().nonnegative(),
});
export type WishPriceRange = z.infer<typeof wishPriceRangeOut>;

/** Canonical candidate-price projection used by list rows and explanations. */
export const wishPriceRange = (
  candidates: readonly WishCandidateOut[],
): WishPriceRange | null => {
  const prices = candidates.flatMap((candidate) =>
    candidate.price === null ? [] : [candidate.price],
  );
  if (prices.length === 0) return null;
  return {
    low: Math.min(...prices),
    high: Math.max(...prices),
    pricedCount: prices.length,
  };
};
