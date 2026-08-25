import {
  aiBackfillLocationDescriptionsEventSchema,
  aiEnrichmentProposalEventSchema,
  type aiLocationIdInput,
  type aiUsageRecentInput,
  aiUsageRecentOut,
  type aiUsageSummaryInput,
  aiUsageSummaryOut,
  type approveDetectedInventoryItemInput,
  approveDetectedInventoryItemOut,
  categoryAuditSchema,
  type categorySuggestionInput,
  categorySuggestionSchema,
  detectedInventorySchema,
  type enrichmentProposalPrecomputeInput,
  type ingredientMergeSuggestionBatchInput,
  ingredientMergeSuggestionBatchOut,
  locationDescriptionSchema,
  type locationSuggestionInput,
  locationSuggestionSchema,
  type locationTypeSuggestionInput,
  locationTypeSuggestionSchema,
  parsedSearchSchema,
  type parseSearchInput,
  type productIdentificationInput,
  productIdentificationSchema,
  type usdaFoodSuggestionBatchInput,
  usdaFoodSuggestionBatchOut,
  type usdaFoodSuggestionInput,
  usdaFoodSuggestionOut,
} from "@cubby/schemas/ai";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import { startOperation } from "~/integrations/tanstack-query/start-transport";
import type { StartOperationId } from "~/lib/start-operation-observability";
import { openWorkflowStream } from "~/lib/workflow-stream";
import * as browser from "~/server/ai-browser.server";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";

const suggestCategoryTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) => value as z.input<typeof categorySuggestionInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestCategoryForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const suggestLocationTypeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) => value as z.input<typeof locationTypeSuggestionInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestLocationTypeForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const suggestLocationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) => value as z.input<typeof locationSuggestionInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestLocationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const describeLocationTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof aiLocationIdInput>)
  .handler(({ data, context }) =>
    browser.describeLocationForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const detectInventoryItemsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof aiLocationIdInput>)
  .handler(({ data, context }) =>
    browser.detectInventoryItemsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const approveDetectedInventoryItemTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) =>
      value as z.input<typeof approveDetectedInventoryItemInput>,
  )
  .handler(({ data, context }) =>
    browser.approveDetectedInventoryItemForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const identifyProductTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) => value as z.input<typeof productIdentificationInput>,
  )
  .handler(({ data, context }) =>
    browser.identifyProductForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const suggestUsdaFoodTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) => value as z.input<typeof usdaFoodSuggestionInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestUsdaFoodForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const suggestUsdaFoodBatchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) => value as z.input<typeof usdaFoodSuggestionBatchInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestUsdaFoodBatchForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const suggestIngredientMergeBatchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (value: unknown) =>
      value as z.input<typeof ingredientMergeSuggestionBatchInput>,
  )
  .handler(({ data, context }) =>
    browser.suggestIngredientMergeBatchForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const parseSearchTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof parseSearchInput>)
  .handler(({ data, context }) =>
    browser.parseSearchForBrowser({ data, request: context.startOperation }),
  );
const usageRecentTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof aiUsageRecentInput>)
  .handler(({ data, context }) =>
    browser.listAiUsageRecentForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const usageSummaryTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((value: unknown) => value as z.input<typeof aiUsageSummaryInput>)
  .handler(({ data, context }) =>
    browser.summarizeAiUsageForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const auditCategoriesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.auditCategoriesForBrowser({ request: context.startOperation }),
  );

const operation = <I, O>(
  name: string,
  kind: "query" | "mutation",
  transport: (options: {
    data: I;
    signal?: AbortSignal;
    headers?: HeadersInit;
  }) => Promise<
    import("~/server/start-operation.contract").StartOperationResult<O>
  >,
  parse: (value: unknown) => O,
) =>
  startOperation<I, O>({
    operation: `ai.${name}` as StartOperationId,
    ...(kind === "mutation" ? { kind } : {}),
    transport: (data, { signal, headers }) =>
      transport({ data, signal, headers }),
    parse,
  });

const suggestCategory = operation(
  "suggestCategory",
  "query",
  suggestCategoryTransport,
  (result) => categorySuggestionSchema.parse(result),
);
const suggestLocationType = operation(
  "suggestLocationType",
  "query",
  suggestLocationTypeTransport,
  (result) => locationTypeSuggestionSchema.parse(result),
);
const suggestLocation = operation(
  "suggestLocation",
  "query",
  suggestLocationTransport,
  (result) => locationSuggestionSchema.parse(result),
);
const describeLocation = operation(
  "describeLocation",
  "mutation",
  describeLocationTransport,
  (result) => locationDescriptionSchema.parse(result),
);
const detectInventoryItems = operation(
  "detectInventoryItems",
  "mutation",
  detectInventoryItemsTransport,
  (result) => detectedInventorySchema.parse(result),
);
const approveDetectedInventoryItem = operation(
  "approveDetectedInventoryItem",
  "mutation",
  approveDetectedInventoryItemTransport,
  (result) => approveDetectedInventoryItemOut.parse(result),
);
const identifyProduct = operation(
  "identifyProduct",
  "mutation",
  identifyProductTransport,
  (result) => productIdentificationSchema.parse(result),
);
const suggestUsdaFood = operation(
  "suggestUsdaFood",
  "mutation",
  suggestUsdaFoodTransport,
  (result) => usdaFoodSuggestionOut.parse(result),
);
const suggestUsdaFoodBatch = operation(
  "suggestUsdaFoodBatch",
  "mutation",
  suggestUsdaFoodBatchTransport,
  (result) => usdaFoodSuggestionBatchOut.parse(result),
);
const suggestIngredientMergeBatch = operation(
  "suggestIngredientMergeBatch",
  "mutation",
  suggestIngredientMergeBatchTransport,
  (result) => ingredientMergeSuggestionBatchOut.parse(result),
);
const parseSearch = operation(
  "parseSearch",
  "mutation",
  parseSearchTransport,
  (result) => parsedSearchSchema.parse(result),
);
const usageRecent = operation(
  "usageRecent",
  "query",
  usageRecentTransport,
  (result) => aiUsageRecentOut.parse(result),
);
const usageSummary = operation(
  "usageSummary",
  "query",
  usageSummaryTransport,
  (result) => aiUsageSummaryOut.parse(result),
);
const auditCategories = startOperation<
  undefined,
  z.output<typeof categoryAuditSchema>
>({
  operation: "ai.auditCategories",
  kind: "mutation",
  transport: (_input, { signal, headers }) =>
    auditCategoriesTransport({ signal, headers }),
  parse: (result) => categoryAuditSchema.parse(result),
});

const query = <I, O>(
  name: string,
  op: {
    meta: object;
    call(input: I, options: { signal: AbortSignal }): Promise<O>;
  },
  input: I,
) =>
  queryOptions({
    queryKey: [["ai", name], { input, type: "query" }] as const,
    meta: op.meta as never,
    queryFn: ({ signal }) => op.call(input, { signal }),
  });
const mutation =
  <I, O>(name: string, op: { meta: object; call(input: I): Promise<O> }) =>
  (options?: UseMutationOptions<O, Error, I>) =>
    mutationOptions({
      mutationKey: [["ai", name]] as const,
      meta: op.meta as never,
      mutationFn: async (input: I) => {
        return op.call(input);
      },
      ...options,
    });

export const suggestCategoryQueryOptions = (
  input: z.input<typeof categorySuggestionInput>,
) => query("suggestCategory", suggestCategory, input);
export const aiUsageRecentQueryOptions = (
  input: z.input<typeof aiUsageRecentInput>,
) => query("usageRecent", usageRecent, input);
export const aiUsageSummaryQueryOptions = (
  input: z.input<typeof aiUsageSummaryInput>,
) => query("usageSummary", usageSummary, input);

export const describeLocationMutationOptions = mutation(
  "describeLocation",
  describeLocation,
);
export const detectInventoryItemsMutationOptions = mutation(
  "detectInventoryItems",
  detectInventoryItems,
);
export const approveDetectedInventoryItemMutationOptions = mutation(
  "approveDetectedInventoryItem",
  approveDetectedInventoryItem,
);
export const suggestUsdaFoodBatchMutationOptions = mutation(
  "suggestUsdaFoodBatch",
  suggestUsdaFoodBatch,
);
export const suggestIngredientMergeBatchMutationOptions = mutation(
  "suggestIngredientMergeBatch",
  suggestIngredientMergeBatch,
);
export const auditCategoriesMutationOptions = mutation(
  "auditCategories",
  auditCategories,
);

export const suggestCategoryForBrowser = (
  input: z.input<typeof categorySuggestionInput>,
  signal?: AbortSignal,
) => suggestCategory.call(input, { signal });
export const suggestLocationTypeForBrowser = (
  input: z.input<typeof locationTypeSuggestionInput>,
  signal?: AbortSignal,
) => suggestLocationType.call(input, { signal });
export const suggestLocationForBrowser = (
  input: z.input<typeof locationSuggestionInput>,
  signal?: AbortSignal,
) => suggestLocation.call(input, { signal });
export const identifyProductForBrowser = (
  input: z.input<typeof productIdentificationInput>,
  signal?: AbortSignal,
) => identifyProduct.call(input, { signal });
export const detectInventoryItemsForBrowser = (
  input: z.input<typeof aiLocationIdInput>,
  signal?: AbortSignal,
) => detectInventoryItems.call(input, { signal });
export const suggestUsdaFoodForBrowser = (
  input: z.input<typeof usdaFoodSuggestionInput>,
  signal?: AbortSignal,
) => suggestUsdaFood.call(input, { signal });
export const parseSearchForBrowser = (
  input: z.input<typeof parseSearchInput>,
  signal?: AbortSignal,
) => parseSearch.call(input, { signal });
export const auditCategoriesForBrowser = (signal?: AbortSignal) =>
  auditCategories.call(undefined, { signal });

export const backfillLocationDescriptionsStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "ai.backfillLocationDescriptions",
    kind: "mutation",
    url: "/api/ai-stream/backfill-location-descriptions",
    input: undefined,
    eventSchema: aiBackfillLocationDescriptionsEventSchema,
    signal,
  });
export const precomputeEnrichmentProposalsStream = (
  input: z.input<typeof enrichmentProposalPrecomputeInput>,
  signal?: AbortSignal,
) =>
  openWorkflowStream({
    operation: "ai.precomputeEnrichmentProposals",
    kind: "mutation",
    url: "/api/ai-stream/precompute-enrichment-proposals",
    input,
    eventSchema: aiEnrichmentProposalEventSchema,
    signal,
  });
