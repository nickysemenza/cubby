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
