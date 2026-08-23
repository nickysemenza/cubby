import { z } from "zod";
import { productShortcode } from "./identifiers";
import { relatednessOutSchema } from "./relatedness";

export const recommendationWorkbenchInput = z.object({
  sourceId: productShortcode,
});

export const recommendationKind = z.enum(["product-related"]);

/** Only an entity shortcode is permitted in the workbench URL. */
export const recommendationWorkbenchSearch = z
  .object({
    kind: recommendationKind,
    source: productShortcode.optional(),
  })
  .strict();

export const dismissProductRecommendationInput = z.object({
  sourceId: productShortcode,
  targetId: productShortcode,
});

export const recommendationWorkbenchOut = relatednessOutSchema;
