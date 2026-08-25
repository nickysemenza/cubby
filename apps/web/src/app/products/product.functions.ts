import type {
  productCreateManyInput,
  productMarkUsdaUnavailableManyInput,
} from "@cubby/schemas/product";
import {
  productBackfillUpcImagesEvent,
  productCreateManyEvent,
  productMarkUsdaUnavailableEvent,
  productWorkflowSchemas,
} from "@cubby/schemas/product-workflow";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
  type UseQueryOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import {
  type StartOperation,
  startOperation,
} from "~/integrations/tanstack-query/start-transport";
import { queryKeys } from "~/lib/query-keys";
import type { StartOperationId } from "~/lib/start-operation-observability";
import { openWorkflowStream } from "~/lib/workflow-stream";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/product-browser.server";
import type { StartOperationResult } from "~/server/start-operation.contract";

const searchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof productWorkflowSchemas.search.input>,
  )
  .handler(({ data, context }) =>
    browser.searchProductsForBrowser({ data, request: context.startOperation }),
  );
const summariesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof productWorkflowSchemas.summaries.input>,
  )
  .handler(({ data, context }) =>
    browser.getProductSummariesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const quantitySummariesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.quantitySummaries.input>,
  )
  .handler(({ data, context }) =>
    browser.getProductQuantitySummariesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const inventoryEntriesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.inventoryEntriesByIds.input>,
  )
  .handler(({ data, context }) =>
    browser.getProductInventoryEntriesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const quickCreateTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.quickCreate.input>,
  )
  .handler(({ data, context }) =>
    browser.quickCreateProductForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const applyUpcDataTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.applyUpcData.input>,
  )
  .handler(({ data, context }) =>
    browser.applyProductUpcDataForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const findOrCreateByUpcTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.findOrCreateByUPC.input>,
  )
  .handler(({ data, context }) =>
    browser.findOrCreateProductByUpcForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const findOrCreateByCodeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.findOrCreateByCode.input>,
  )
  .handler(({ data, context }) =>
    browser.findOrCreateProductByCodeForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const tagOptionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getProductTagOptionsForBrowser({
      data: undefined,
      request: context.startOperation,
    }),
  );
const categoryDistributionTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getProductCategoryDistributionForBrowser({
      request: context.startOperation,
    }),
  );
const manufacturerOptionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getProductManufacturerOptionsForBrowser({
      data: undefined,
      request: context.startOperation,
    }),
  );
const externalIdSourceOptionsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getProductExternalIdSourceOptionsForBrowser({
      data: undefined,
      request: context.startOperation,
    }),
  );
const movementTimelineTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.movementTimeline.input>,
  )
  .handler(({ data, context }) =>
    browser.getProductMovementTimelineForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const getByShortcodesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.getByShortcodes.input>,
  )
  .handler(({ data, context }) =>
    browser.getProductsByShortcodesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const mergeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof productWorkflowSchemas.merge.input>,
  )
  .handler(({ data, context }) =>
    browser.mergeProductsForBrowser({ data, request: context.startOperation }),
  );
const projectUsesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.projectUses.input>,
  )
  .handler(({ data, context }) =>
    browser.listProductProjectUsesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const purchasesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof productWorkflowSchemas.purchases.input>,
  )
  .handler(({ data, context }) =>
    browser.listProductPurchasesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const componentsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.components.input>,
  )
  .handler(({ data, context }) =>
    browser.listProductComponentsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const kitComponentRowsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.kitComponentRows.input>,
  )
  .handler(({ data, context }) =>
    browser.listKitComponentRowsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const kitMembershipTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.kitMembership.input>,
  )
  .handler(({ data, context }) =>
    browser.listKitMembershipForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const attachComponentsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.attachComponents.input>,
  )
  .handler(({ data, context }) =>
    browser.attachProductComponentsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const detachComponentsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.detachComponents.input>,
  )
  .handler(({ data, context }) =>
    browser.detachProductComponentsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const setProjectUsesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.setProjectUses.input>,
  )
  .handler(({ data, context }) =>
    browser.setProductProjectUsesForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const discardTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof productWorkflowSchemas.discard.input>,
  )
  .handler(({ data, context }) =>
    browser.discardProductForBrowser({ data, request: context.startOperation }),
  );
const bulkSetStockTrackedTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) =>
      v as z.input<typeof productWorkflowSchemas.bulkSetStockTracked.input>,
  )
  .handler(({ data, context }) =>
    browser.bulkSetProductStockTrackedForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const defineOperation = <I extends z.ZodTypeAny, O extends z.ZodTypeAny>(
  operation: StartOperationId,
  schemas: { input: I; output: O },
  transport: (
    data: z.input<I>,
    options: { signal?: AbortSignal; headers: HeadersInit },
  ) => Promise<StartOperationResult<unknown>>,
  kind: "query" | "mutation" = "query",
): StartOperation<z.input<I>, z.output<O>> =>
  startOperation<z.input<I>, z.output<O>>({
    operation,
    kind,
    transport,
    parse: (result): z.output<O> => schemas.output.parse(result),
  });
const search = defineOperation(
  "product.search",
  productWorkflowSchemas.search,
  (data, o) => searchTransport({ data, ...o }),
);
const summaries = defineOperation(
  "product.summaries",
  productWorkflowSchemas.summaries,
  (data, o) => summariesTransport({ data, ...o }),
);
const quantitySummaries = defineOperation(
  "product.quantitySummaries",
  productWorkflowSchemas.quantitySummaries,
  (data, o) => quantitySummariesTransport({ data, ...o }),
);
const inventoryEntries = defineOperation(
  "product.inventoryEntriesByIds",
  productWorkflowSchemas.inventoryEntriesByIds,
  (data, o) => inventoryEntriesTransport({ data, ...o }),
);
const quickCreate = defineOperation(
  "product.quickCreate",
  productWorkflowSchemas.quickCreate,
  (data, o) => quickCreateTransport({ data, ...o }),
  "mutation",
);
const applyUpcData = defineOperation(
  "product.applyUpcData",
  productWorkflowSchemas.applyUpcData,
  (data, o) => applyUpcDataTransport({ data, ...o }),
  "mutation",
);
const findOrCreateByUPC = defineOperation(
  "product.findOrCreateByUPC",
  productWorkflowSchemas.findOrCreateByUPC,
  (data, o) => findOrCreateByUpcTransport({ data, ...o }),
  "mutation",
);
const findOrCreateByCode = defineOperation(
  "product.findOrCreateByCode",
  productWorkflowSchemas.findOrCreateByCode,
  (data, o) => findOrCreateByCodeTransport({ data, ...o }),
  "mutation",
);
const tagOptions = defineOperation(
  "product.tagOptions",
  productWorkflowSchemas.tagOptions,
  (_data, o) => tagOptionsTransport(o),
);
const categoryDistribution = defineOperation(
  "product.categoryDistribution",
  productWorkflowSchemas.categoryDistribution,
  (_data, o) => categoryDistributionTransport(o),
);
const manufacturerOptions = defineOperation(
  "product.manufacturerOptions",
  productWorkflowSchemas.manufacturerOptions,
  (_data, o) => manufacturerOptionsTransport(o),
);
const externalIdSourceOptions = defineOperation(
  "product.externalIdSourceOptions",
  productWorkflowSchemas.externalIdSourceOptions,
  (_data, o) => externalIdSourceOptionsTransport(o),
);
const movementTimeline = defineOperation(
  "product.movementTimeline",
  productWorkflowSchemas.movementTimeline,
  (data, o) => movementTimelineTransport({ data, ...o }),
);
const getByShortcodes = defineOperation(
  "product.getByShortcodes",
  productWorkflowSchemas.getByShortcodes,
  (data, o) => getByShortcodesTransport({ data, ...o }),
);
const merge = defineOperation(
  "product.merge",
  productWorkflowSchemas.merge,
  (data, o) => mergeTransport({ data, ...o }),
  "mutation",
);
const projectUses = defineOperation(
  "product.projectUses",
  productWorkflowSchemas.projectUses,
  (data, o) => projectUsesTransport({ data, ...o }),
);
const purchases = defineOperation(
  "product.purchases",
  productWorkflowSchemas.purchases,
  (data, o) => purchasesTransport({ data, ...o }),
);
const components = defineOperation(
  "product.components",
  productWorkflowSchemas.components,
  (data, o) => componentsTransport({ data, ...o }),
);
const kitComponentRows = defineOperation(
  "product.kitComponentRows",
  productWorkflowSchemas.kitComponentRows,
  (data, o) => kitComponentRowsTransport({ data, ...o }),
);
const kitMembership = defineOperation(
  "product.kitMembership",
  productWorkflowSchemas.kitMembership,
  (data, o) => kitMembershipTransport({ data, ...o }),
);
const attachComponents = defineOperation(
  "product.attachComponents",
  productWorkflowSchemas.attachComponents,
  (data, o) => attachComponentsTransport({ data, ...o }),
  "mutation",
);
const detachComponents = defineOperation(
  "product.detachComponents",
  productWorkflowSchemas.detachComponents,
  (data, o) => detachComponentsTransport({ data, ...o }),
  "mutation",
);
const setProjectUses = defineOperation(
  "product.setProjectUses",
  productWorkflowSchemas.setProjectUses,
  (data, o) => setProjectUsesTransport({ data, ...o }),
  "mutation",
);
const discard = defineOperation(
  "product.discard",
  productWorkflowSchemas.discard,
  (data, o) => discardTransport({ data, ...o }),
  "mutation",
);
const bulkSetStockTracked = defineOperation(
  "product.bulkSetStockTracked",
  productWorkflowSchemas.bulkSetStockTracked,
  (data, o) => bulkSetStockTrackedTransport({ data, ...o }),
  "mutation",
);

const query = <I, O>(
  name: string,
  operation: StartOperation<I, O>,
  input: I,
  options: Omit<UseQueryOptions<O>, "queryKey" | "queryFn"> = {},
) =>
  queryOptions({
    ...options,
    queryKey: [[...queryKeys.product.all, name], { input }] as const,
    meta: operation.meta,
    queryFn: ({ signal }) => operation.call(input, { signal }),
  });
const mutation =
  <I, O>(operation: StartOperation<I, O>) =>
  (
    callbacks: Omit<
      UseMutationOptions<O, Error, I>,
      "mutationFn" | "mutationKey"
    > = {},
  ) =>
    mutationOptions({
      ...callbacks,
      mutationKey: [operation.operation],
      mutationFn: async (input: I) => {
        const result = await operation.call(input);
        return result;
      },
      meta: operation.meta,
    });

export const productSearchQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.search.input>,
) => query("search", search, input);
export const productSummariesQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.summaries.input>,
  options?: Omit<
    UseQueryOptions<z.output<typeof productWorkflowSchemas.summaries.output>>,
    "queryKey" | "queryFn"
  >,
) => query("summaries", summaries, input, options);
export const productQuantitySummariesQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.quantitySummaries.input>,
) => query("quantitySummaries", quantitySummaries, input);
export const productInventoryEntriesByIdsQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.inventoryEntriesByIds.input>,
) => query("inventoryEntriesByIds", inventoryEntries, input);
export const productTagOptionsQueryOptions = () =>
  query("tagOptions", tagOptions, undefined);
export const productCategoryDistributionQueryOptions = () =>
  query("categoryDistribution", categoryDistribution, undefined);
export const productManufacturerOptionsQueryOptions = () =>
  query("manufacturerOptions", manufacturerOptions, undefined);
export const productExternalIdSourceOptionsQueryOptions = () =>
  query("externalIdSourceOptions", externalIdSourceOptions, undefined);
export const productMovementTimelineQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.movementTimeline.input>,
) => query("movementTimeline", movementTimeline, input);
export const productsByShortcodesQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.getByShortcodes.input>,
) => query("getByShortcodes", getByShortcodes, input);
export const productProjectUsesQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.projectUses.input>,
) => query("projectUses", projectUses, input);
export const productPurchasesQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.purchases.input>,
) => query("purchases", purchases, input);
export const productComponentsQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.components.input>,
) => query("components", components, input);
export const kitComponentRowsQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.kitComponentRows.input>,
) => query("kitComponentRows", kitComponentRows, input);
export const kitMembershipQueryOptions = (
  input: z.input<typeof productWorkflowSchemas.kitMembership.input>,
) => query("kitMembership", kitMembership, input);

export const quickCreateProductMutationOptions = mutation(quickCreate);
export const applyProductUpcDataMutationOptions = mutation(applyUpcData);
export const findOrCreateProductByUpcMutationOptions =
  mutation(findOrCreateByUPC);
export const findOrCreateProductByCodeMutationOptions =
  mutation(findOrCreateByCode);
export const mergeProductsMutationOptions = mutation(merge);
export const attachProductComponentsMutationOptions =
  mutation(attachComponents);
export const detachProductComponentsMutationOptions =
  mutation(detachComponents);
export const setProductProjectUsesMutationOptions = mutation(setProjectUses);
export const discardProductMutationOptions = mutation(discard);
export const bulkSetProductStockTrackedMutationOptions =
  mutation(bulkSetStockTracked);

export const createManyProductsStream = (
  input: z.input<typeof productCreateManyInput>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "product.createMany",
    kind: "mutation",
    url: "/api/product-stream/create-many",
    input,
    eventSchema: productCreateManyEvent,
    signal,
  });
export const markProductsUsdaUnavailableStream = (
  input: z.input<typeof productMarkUsdaUnavailableManyInput>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "product.markUsdaUnavailableMany",
    kind: "mutation",
    url: "/api/product-stream/mark-usda-unavailable",
    input,
    eventSchema: productMarkUsdaUnavailableEvent,
    signal,
  });
export const backfillProductUpcImagesStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "product.backfillUPCImages",
    kind: "mutation",
    url: "/api/product-stream/backfill-upc-images",
    input: undefined,
    eventSchema: productBackfillUpcImagesEvent,
    signal,
  });
