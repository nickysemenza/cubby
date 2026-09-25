import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";

import { usdaFoodContract } from "~/contracts/usda.contract";
import { implementOperationDomain } from "~/server/operation-domain.server";

export const usdaFoodHandlers = implementOperationDomain(usdaFoodContract, {
  list: {
    run: async (context, input) => {
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
  },
  detail: {
    run: (context, input) => context.usdaService.getFoodSummaryByID(input.id),
  },
  alternateId: {
    run: (context, input) => context.usdaService.findFood(input),
  },
});
