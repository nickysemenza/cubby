import { z } from "zod";
import { suggestionChildHandle } from "./suggestion-reference";
import { productShortcode } from "./identifier-fields";

export const duplicateProductIdentitySchema = z.object({
  suggestionId: suggestionChildHandle,
  fingerprint: z.string().nullable(),
  identityConflict: z.boolean(),
  pairs: z.array(
    z.object({
      suggestionId: suggestionChildHandle,
      fingerprint: z.string().nullable(),
      identityConflict: z.boolean(),
      productIds: z.tuple([productShortcode, productShortcode]),
    }),
  ),
  brandName: z.string().nullable(),
  model: z.string(),
  products: z.array(
    z.object({
      id: productShortcode,
      name: z.string(),
      gtins: z.array(z.string()),
      sources: z.array(z.string()),
    }),
  ),
});
