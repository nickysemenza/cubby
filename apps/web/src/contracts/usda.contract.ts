import { mcpPaginationFields } from "@cubby/schemas/pagination";
import {
  foodSummaryWithLinkedProducts,
  usdaFoodIdInput,
  usdaFoodListOut,
  usdaFoodLookupInput,
  usdaListInput,
} from "@cubby/schemas/usda";
import { dataTypeEnum, fdcId, ndb, upc } from "@cubby/usda";
import { z } from "zod";

import { defineContract, query } from "~/contracts/define";

const usdaFoodResult = z.object({
  food: foodSummaryWithLinkedProducts.nullable(),
});

export const usdaFoodContract = defineContract("usda-food", {
  list: query({
    readPolicy: "strong",
    native: "Native USDA food browse",
    input: usdaListInput,
    output: usdaFoodListOut,
    cache: { tags: [["usda-food"]] },
  }),
  detail: query({
    readPolicy: "strong",
    native: "Native USDA food detail",
    input: usdaFoodIdInput,
    output: foodSummaryWithLinkedProducts.nullable(),
    cache: { tags: [["usda-food"]], profile: "stable" },
  }),
  // AI and externally hydrated food reads own authoritative database helpers.
  alternateId: query({
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
});
