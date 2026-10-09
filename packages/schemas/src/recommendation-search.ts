import { z } from "zod";
import { inventoryShortcode, productShortcode } from "./identifier-fields";

// Kept apart from `./recommendations`: a route's `validateSearch` loads with
// the app entry, and the response schemas there import generated entity
// field schemas.

export const recommendationKind = z.enum([
  "product-related",
  "duplicate-product",
  "product-match",
  "tag-propagation",
  "placement",
]);
export type RecommendationKind = z.infer<typeof recommendationKind>;

/** Only an entity shortcode is permitted in the workbench URL. */
export const recommendationWorkbenchSearch = z
  .object({
    kind: recommendationKind.optional(),
    source: productShortcode.optional(),
    candidate: productShortcode.optional(),
    inventory: inventoryShortcode.optional(),
  })
  .strict();
