import {
  buildPaginatedResponse,
  normalizeSorts,
} from "@cubby/schemas/pagination";
import {
  foodSummaryWithLinkedProducts,
  usdaFoodIdInput,
  usdaFoodListOut,
  usdaListInput,
} from "@cubby/schemas/usda";
import type { z } from "zod";
import {
  runStartOperation,
  type StartOperationRequest,
} from "~/server/start-operation.server";

export const listUsdaFoods = async (options: {
  data: z.input<typeof usdaListInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "usda-food.list",
    type: "query",
    input: options.data,
    inputSchema: usdaListInput,
    outputSchema: usdaFoodListOut,
    request: options.request,
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
  });

export const getUsdaFoodDetail = async (options: {
  data: z.input<typeof usdaFoodIdInput>;
  request: StartOperationRequest;
}) =>
  await runStartOperation({
    operation: "usda-food.detail",
    type: "query",
    input: options.data,
    inputSchema: usdaFoodIdInput,
    outputSchema: foodSummaryWithLinkedProducts.nullable(),
    request: options.request,
    readPolicy: "strong",
    run: async (context, input) =>
      await context.usdaService.getFoodSummaryByID(input.id),
  });
