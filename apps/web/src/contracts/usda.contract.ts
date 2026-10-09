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

export const usdaFoodContract = defineContract("usda-food", {
  list: query({
    mcp: {
      omit: "client_view",
      note: "Native browse with linked-product filters; agents search with usda_food.search",
    },
    readPolicy: "strong",
    native: "Native USDA food browse",
    input: usdaListInput,
    output: usdaFoodListOut,
    cache: { tags: [["usda-food"]] },
  }),
  detail: query({
    mcp: { omit: "agent_twin", twin: "usda-food.byFdcId" },
    readPolicy: "strong",
    native: "Native USDA food detail",
    input: usdaFoodIdInput,
    output: foodSummaryWithLinkedProducts.nullable(),
    cache: { tags: [["usda-food"]], profile: "stable" },
  }),
  // AI and externally hydrated food reads own authoritative database helpers.
  alternateId: query({
    mcp: {
      omit: "agent_twin",
      twin: "usda-food.find",
      note: "UPC and NDB lookups; an FDC id goes through usda_food.get",
    },
    readPolicy: "strong",
    input: usdaFoodLookupInput,
    output: foodSummaryWithLinkedProducts.nullable(),
    cache: { tags: [["usda-food"]] },
  }),
  // Agent-facing (MCP `usda_food`): off the HTTP API.
  /** Relevance-ranked FoodData Central search. */
  search: query({
    http: false,
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
    http: false,
    input: z.object({ fdcId }),
    output: usdaFoodResult,
  }),
  /** By barcode (UPC/GTIN, 12-14 digits) or NDB number — exactly one. */
  find: query({
    http: false,
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
    http: false,
    input: z.object({ productId: productShortcode }),
    output: usdaProductSuggestionsOut,
  }),
});
