import { locationTypeValues } from "@cubby/shared/location-type-theme";
import { z } from "zod";

import { money } from "./money";

export const locationType = z
  .enum(locationTypeValues)
  .describe("type of location (room, container, etc)");
export type LocationType = z.infer<typeof locationType>;

const pricingCounts = z.object({
  priced: z.number().int().nonnegative(),
  missingPricing: z.number().int().nonnegative(),
  miscNoPrice: z.number().int().nonnegative(),
});

export const locationValuation = z.object({
  directValuation: money,
  totalValuation: money,
  directItemCount: z.number().int().nonnegative(),
  totalItemCount: z.number().int().nonnegative(),
  direct: pricingCounts,
  total: pricingCounts,
  installed: z
    .object({
      directValuation: money,
      totalValuation: money,
      directItemCount: z.number().int().nonnegative(),
      totalItemCount: z.number().int().nonnegative(),
    })
    .optional(),
  container: z
    .object({
      directValuation: money,
      totalValuation: money,
      directItemCount: z.number().int().nonnegative(),
      totalItemCount: z.number().int().nonnegative(),
    })
    .optional(),
});
export type LocationValuation = z.infer<typeof locationValuation>;
