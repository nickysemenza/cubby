import { productShortcode } from "@cubby/schemas/identifiers";
import { mcpPaginationFields } from "@cubby/schemas/pagination";
import {
  foodSummaryWithLinkedProducts,
  usdaFoodIdInput,
  usdaFoodListOut,
  usdaFoodListRow,
  usdaFoodLookupInput,
  usdaListInput,
} from "@cubby/schemas/usda";
import { dataTypeEnum, fdcId, ndb, upc } from "@cubby/usda";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

const usdaFoodResult = z.object({
  food: foodSummaryWithLinkedProducts.nullable(),
});

export const usdaSuggestionReason = z.enum([
  "upc",
  "name_manufacturer",
  "name",
]);

export const usdaProductSuggestionsOut = z.object({
  /** The product's current USDA link, so an agent sees what a pick replaces. */
  currentFdcId: z.number().int().nullable(),
  candidates: z.array(
    z.object({
      reason: usdaSuggestionReason,
      food: usdaFoodListRow,
    }),
  ),
});

export const usdaFoodContract = defineContract(
  "usda-food",
  {
    list: query({
      exposure: "view",
      note: "Native browse with linked-product filters; agents search with usda_food.search",
      readPolicy: "strong",
      input: usdaListInput,
      output: usdaFoodListOut,
      cache: { tags: [["usda-food"]] },
    }),
    detail: query({
      exposure: "view",
      readPolicy: "strong",
      input: usdaFoodIdInput,
      output: foodSummaryWithLinkedProducts.nullable(),
      cache: { tags: [["usda-food"]], profile: "stable" },
    }),
    // AI and externally hydrated food reads own authoritative database helpers.
    alternateId: query({
      exposure: "view",
      note: "UPC and NDB lookups; an FDC id goes through usda_food.by_fdc_id",
      readPolicy: "strong",
      input: usdaFoodLookupInput,
      output: foodSummaryWithLinkedProducts.nullable(),
      cache: { tags: [["usda-food"]] },
    }),
    // Agent-facing (MCP `usda_food`).
    /** Relevance-ranked FoodData Central search. */
    search: query({
      description:
        "Use this when the user needs to choose among USDA records for Product nutrition mapping. Returns ranked candidates, best match first, with source type, macros, and existing Cubby links. Present the top few (name, source type, key macros, fdc_id) and let the member pick one before linking; refine the query and search again if none fit. Do not invoke it when the Cubby Product already has a resolved USDA food or for a general nutrition question that does not require record selection.",
      openWorld: true,
      input: z.object({
        query: z.string().describe("Food name to search for"),
        dataType: dataTypeEnum
          .optional()
          .describe("Optional exact USDA data-type filter"),
        ...mcpPaginationFields({ defaultPageSize: 25, maxPageSize: 100 }),
      }),
      output: usdaFoodListOut,
    }),
    byFdcId: query({
      description:
        "One USDA food by its FDC id, with compact nutrients-per-100g and any linked Cubby products.",
      openWorld: true,
      input: z.object({ fdcId }),
      output: usdaFoodResult,
    }),
    /** By barcode (UPC/GTIN, 12-14 digits) or NDB number — exactly one. */
    find: query({
      description:
        "One USDA food by barcode (UPC/GTIN, 12-14 digits) or NDB number; provide exactly one.",
      openWorld: true,
      input: z
        .object({ upc: upc.optional(), ndbNumber: ndb.optional() })
        .refine(
          (input) =>
            (input.upc === undefined) !== (input.ndbNumber === undefined),
          { message: "Provide exactly one of `upc` or `ndbNumber`." },
        ),
      output: usdaFoodResult,
    }),
    /** Agent-facing: USDA foods that plausibly describe one Product. */
    suggestForProduct: query({
      description:
        'USDA foods that plausibly describe one Cubby Product (`productId` shortcode), best evidence first: an exact barcode hit (`reason: "upc"`), then a name + brandName search (`name_manufacturer`), then the bare name (`name`, only when the qualified search found nothing). `currentFdcId` is the Product\'s existing link, if any. Advisory: it never links anything; set `fdc_id` with entity.update after choosing, and treat a `name` match as a lead to confirm, not an identity.',
      openWorld: true,
      input: z.object({ productId: productShortcode }),
      output: usdaProductSuggestionsOut,
    }),
  },
  { exposure: "capability", mcpToolGroup: "usda_food" },
);
