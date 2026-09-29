import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";

import { usdaFoodContract } from "~/contracts/usda.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";

export const usdaFoodHandlers = implementOperationDomain(usdaFoodContract, {
  list: async (context, input) => {
    const { data, count } = await context.usdaService.listFoods(
      input.filters.nameFilter,
      input.filters.dataTypeFilter,
      normalizeSorts(input.sort)[0]!,
      input.pagination,
      input.filters.foodsOnly,
      input.filters.dataTypes,
      input.filters.linkedProductsOnly,
    );
    return buildPaginatedResponse(input.pagination, data, count);
  },
  detail: (context, input) => context.usdaService.getFoodSummaryByID(input.id),
  alternateId: (context, input) => context.usdaService.findFood(input),
  search: async (context, input) => {
    const pagination = {
      pageIndex: input.pageIndex,
      pageSize: input.pageSize,
    };
    const { data, count } = await context.usdaService.listFoods(
      input.query,
      input.dataType,
      { orderBy: "relevance", direction: "asc" },
      pagination,
      true,
    );
    return buildPaginatedResponse(pagination, data, count);
  },
  byFdcId: async (context, input) => ({
    food: await context.usdaService.getFoodSummaryByID(input.fdcId),
  }),
  find: async (context, input) => ({
    food: await context.usdaService.findFood(
      input.upc !== undefined
        ? { kind: "upc", gtin_upc: input.upc }
        : { kind: "ndb", ndb_number: requiredNdb(input.ndbNumber) },
    ),
  }),
});

/** The input refinement guarantees exactly one of `upc` / `ndbNumber`. */
function requiredNdb<T>(ndbNumber: T | undefined): T {
  if (ndbNumber === undefined)
    throw new Error("Validated USDA lookup input is incomplete");
  return ndbNumber;
}
