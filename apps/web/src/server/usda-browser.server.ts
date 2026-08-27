import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import { usdaFood } from "~/entities/usda.functions";
import { implementOperationDomain } from "~/server/operation-domain.server";
import { findUsdaFoodWorkflow } from "~/server/workflows/usda.server";

export const usdaFoodHandlers = implementOperationDomain(usdaFood, {
  list: {
    readPolicy: "strong",
    run: async (context, input) => {
      try {
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
      } catch (error) {
        console.error(
          "[usda-food.list] failed, returning empty:",
          error,
          error instanceof Error ? error.cause : undefined,
        );
        return buildPaginatedResponse(input.pagination, [], 0);
      }
    },
  },
  detail: {
    readPolicy: "strong",
    run: (context, input) => context.usdaService.getFoodSummaryByID(input.id),
  },
  alternateId: {
    readPolicy: "strong",
    run: (context, input) => findUsdaFoodWorkflow(context.usdaService, input),
  },
});
