import {
  foodSummaryWithLinkedProducts,
  type usdaFoodIdInput,
  usdaFoodListOut,
  type usdaListInput,
} from "@cubby/schemas/usda";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import {
  observedStartCall,
  unwrapStartOperationResult,
} from "~/integrations/tanstack-query/start-transport";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as usdaBrowser from "~/server/usda-browser.server";

const listUsdaFoodsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof usdaListInput>)
  .handler(
    async ({ data, context }) =>
      await usdaBrowser.listUsdaFoods({
        data,
        request: context.startOperation,
      }),
  );

const getUsdaFoodDetailTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof usdaFoodIdInput>)
  .handler(
    async ({ data, context }) =>
      await usdaBrowser.getUsdaFoodDetail({
        data,
        request: context.startOperation,
      }),
  );

export const usdaFoodListQueryOptions = (
  input: z.input<typeof usdaListInput>,
) =>
  queryOptions({
    queryKey: [["usda-food", "list"], { input }] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "usda-food.list",
        entity: "usda-food",
        input,
        call: async (headers) =>
          usdaFoodListOut.parse(
            unwrapStartOperationResult(
              "usda-food.list",
              await listUsdaFoodsTransport({ data: input, signal, headers }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "usda-food.list",
      entity: "usda-food",
      observedByTransport: true,
    },
  });

export const usdaFoodDetailQueryOptions = (id: number) =>
  queryOptions({
    queryKey: [["usda-food", "detail"], { id }] as const,
    queryFn: ({ signal }) =>
      observedStartCall({
        operation: "usda-food.detail",
        entity: "usda-food",
        input: { id },
        call: async (headers) =>
          foodSummaryWithLinkedProducts.nullable().parse(
            unwrapStartOperationResult(
              "usda-food.detail",
              await getUsdaFoodDetailTransport({
                data: { id },
                signal,
                headers,
              }),
            ),
          ),
      }),
    meta: {
      transport: "start",
      operation: "usda-food.detail",
      entity: "usda-food",
      observedByTransport: true,
    },
  });
