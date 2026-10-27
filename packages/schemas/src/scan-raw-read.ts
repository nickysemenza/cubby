/** Private scan planning facts; outward live records use canonical field envelopes. */
import { z } from "zod";
import { amount } from "./codec";
import { inventoryShortcode, productShortcode } from "./identifier-fields";
import { locationRefOut } from "./location-fields";
import { mutationSideEffectsSchema } from "./mutation-side-effects";

export const rawScanStray = z.object({
  entryId: inventoryShortcode,
  location: locationRefOut,
  amount,
  ambiguousQuantity: z
    .boolean()
    .describe(
      "The scan observed several units; moving one or all requires an explicit choice and server revalidation.",
    ),
});
export const rawScanProduct = z.object({
  id: productShortcode,
  name: z.string(),
  created: z.boolean(),
  brandName: z.string().nullable(),
});
export const rawScanAtLocation = z.object({
  outcome: z.enum(["added", "confirmed", "queued"]),
  product: rawScanProduct,
  strays: z.array(rawScanStray),
  sideEffects: mutationSideEffectsSchema,
});
export type RawScanAtLocation = z.output<typeof rawScanAtLocation>;
