import {
  type FoodSummaryWithLinkedProducts,
  foodSummaryWithLinkedProducts,
  type usdaFoodIdInput,
  usdaFoodListOut,
  type usdaFoodLookupInput,
  type usdaListInput,
} from "@cubby/schemas/usda";
import { queryOptions } from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
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

const getUsdaFoodByAlternateIdTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof usdaFoodLookupInput>)
  .handler(
    async ({ data, context }) =>
      await usdaBrowser.getUsdaFoodByAlternateId({
        data,
        request: context.startOperation,
      }),
  );

const usdaListOperation = startOperation<
  z.input<typeof usdaListInput>,
  z.output<typeof usdaFoodListOut>
>({
  operation: "usda-food.list",
  entity: "usda-food",
  transport: (data, { signal, headers }) =>
    listUsdaFoodsTransport({ data, signal, headers }),
  parse: (result) => usdaFoodListOut.parse(result),
});

const usdaDetailOperation = startOperation<
  z.input<typeof usdaFoodIdInput>,
  FoodSummaryWithLinkedProducts | null
>({
  operation: "usda-food.detail",
  entity: "usda-food",
  transport: (data, { signal, headers }) =>
    getUsdaFoodDetailTransport({ data, signal, headers }),
  parse: (result) => foodSummaryWithLinkedProducts.nullable().parse(result),
});

const usdaAlternateIdOperation = startOperation<
  z.input<typeof usdaFoodLookupInput>,
  FoodSummaryWithLinkedProducts | null
>({
  operation: "usda-food.alternateId",
  entity: "usda-food",
  transport: (data, { signal, headers }) =>
    getUsdaFoodByAlternateIdTransport({ data, signal, headers }),
  parse: (result) => foodSummaryWithLinkedProducts.nullable().parse(result),
});

export const usdaFoodListQueryOptions = (
  input: z.input<typeof usdaListInput>,
) =>
  queryOptions({
    queryKey: [["usda-food", "list"], { input }] as const,
    meta: usdaListOperation.meta,
    queryFn: ({ signal }) => usdaListOperation.call(input, { signal }),
  });

export const usdaFoodDetailQueryOptions = (id: number) =>
  queryOptions({
    queryKey: [["usda-food", "detail"], { id }] as const,
    meta: usdaDetailOperation.meta,
    queryFn: ({ signal }) => usdaDetailOperation.call({ id }, { signal }),
  });

export const usdaFoodAlternateIdQueryOptions = (
  input: z.input<typeof usdaFoodLookupInput>,
) =>
  queryOptions({
    queryKey: [["usda-food", "alternateId"], { input }] as const,
    meta: usdaAlternateIdOperation.meta,
    queryFn: ({ signal }) => usdaAlternateIdOperation.call(input, { signal }),
  });
