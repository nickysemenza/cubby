import { recipeAvailabilityOut } from "@cubby/schemas/availability";
import { equivalenceReportSchema } from "@cubby/schemas/equivalences";
import {
  type chunkRequestInput,
  chunkResponseOut,
  type cookbookDiffInput,
  cookbookDiffOut,
  type cookbookIdInput,
  cookbookIdOut,
  cookbookSourceOut,
  deleteCookbookOut,
  importRecipeSchema,
  notionPreviewOut,
  type parseRecipeHtmlInput,
  type scrapeRecipeInput,
  type setCookbookProductInput,
  type upsertCookbookInput,
} from "@cubby/schemas/import-recipe";
import { ingredientCooccurrenceSchema } from "@cubby/schemas/ingredient-cooccurrence";
import { ingredientUsageSchema } from "@cubby/schemas/ingredient-usage";
import {
  cookbookSummary,
  type recipeCooccurrenceInput,
  type recipeCookbookScopeInput,
  recipeDryRunRecomputeTotalsOut,
  recipeGraphListOut,
  type recipeIdInput,
  type recipeIdsInput,
  recipeRecomputeAllOut,
  recipeRecomputeDurableEventSchema,
  recipeTagsOut,
  recipeWithSideEffectsOut,
} from "@cubby/schemas/recipe";
import { recipeDependencyGraphSchema } from "@cubby/schemas/recipe-dependency-graph";
import {
  recipeFlowArtifactSchema,
  type recipeFlowGenerateInputSchema,
  type recipeFlowGetInputSchema,
  recipeFlowStateSchema,
} from "@cubby/schemas/recipe-flow";
import { recipeCostingExplain } from "@cubby/schemas/recipe-shared";
import {
  type makeableRecipesInput,
  makeableRecipesOut,
  type recipeAvailabilityInput,
} from "@cubby/schemas/suggestions";
import {
  mutationOptions,
  queryOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";
import { createServerFn } from "@tanstack/react-start";
import type { z } from "zod";
import {
  type StartOperation,
  startOperation,
} from "~/integrations/tanstack-query/start-transport";
import type { BulkProgressEvent } from "~/lib/bulk-progress";
import { markFreshReads } from "~/lib/fresh-read-marker";
import { queryKeys } from "~/lib/query-keys";
import { openWorkflowStream } from "~/lib/workflow-stream";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/recipe-browser.server";

const operation = <Input, Output>(
  name: string,
  fn: Parameters<typeof startOperation<Input, Output>>[0]["transport"],
  parse: (value: unknown) => Output,
  kind?: "mutation",
): StartOperation<Input, Output> =>
  startOperation<Input, Output>({
    operation: name,
    ...(kind ? { kind } : {}),
    transport: fn,
    parse,
  });

const getManyTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof recipeIdsInput>)
  .handler(async ({ data, context }) =>
    browser.recipeGetMany({ data, request: context.startOperation }),
  );
const tagsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as undefined)
  .handler(async ({ data, context }) =>
    browser.recipeGetAllTags({ data, request: context.startOperation }),
  );
const duplicateTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof recipeIdInput>)
  .handler(async ({ data, context }) =>
    browser.recipeDuplicate({ data, request: context.startOperation }),
  );
const cooccurrenceTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof recipeCooccurrenceInput>,
  )
  .handler(async ({ data, context }) =>
    browser.recipeCooccurrence({ data, request: context.startOperation }),
  );
const dependencyGraphTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof recipeCookbookScopeInput>,
  )
  .handler(async ({ data, context }) =>
    browser.recipeDependencyGraph({ data, request: context.startOperation }),
  );
const ingredientUsageTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof recipeCookbookScopeInput>,
  )
  .handler(async ({ data, context }) =>
    browser.recipeIngredientUsage({ data, request: context.startOperation }),
  );
const recomputeOneTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof recipeIdInput>)
  .handler(async ({ data, context }) =>
    browser.recipeRecomputeOne({ data, request: context.startOperation }),
  );
const dryRunTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as undefined)
  .handler(async ({ data, context }) =>
    browser.recipeDryRun({ data, request: context.startOperation }),
  );
const explainTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof recipeIdInput>)
  .handler(async ({ data, context }) =>
    browser.recipeExplainCosting({ data, request: context.startOperation }),
  );
const flowTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof recipeFlowGetInputSchema>,
  )
  .handler(async ({ data, context }) =>
    browser.recipeGetFlow({ data, request: context.startOperation }),
  );
const generateFlowTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof recipeFlowGenerateInputSchema>,
  )
  .handler(async ({ data, context }) =>
    browser.recipeGenerateFlow({ data, request: context.startOperation }),
  );
const equivalencesTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as undefined)
  .handler(async ({ data, context }) =>
    browser.recipeHarvestEquivalences({
      data,
      request: context.startOperation,
    }),
  );
const availabilityTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof recipeAvailabilityInput>,
  )
  .handler(async ({ data, context }) =>
    browser.suggestionAvailability({ data, request: context.startOperation }),
  );
const makeableTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof makeableRecipesInput>)
  .handler(async ({ data, context }) =>
    browser.suggestionMakeable({ data, request: context.startOperation }),
  );
const scrapeTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof scrapeRecipeInput>)
  .handler(async ({ data, context }) =>
    browser.recipeScrape({ data, request: context.startOperation }),
  );
const parseHtmlTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof parseRecipeHtmlInput>)
  .handler(async ({ data, context }) =>
    browser.recipeParseHtml({ data, request: context.startOperation }),
  );
const upsertCookbookTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof upsertCookbookInput>)
  .handler(async ({ data, context }) =>
    browser.recipeUpsertCookbook({ data, request: context.startOperation }),
  );
const cookbookSourceTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof cookbookIdInput>)
  .handler(async ({ data, context }) =>
    browser.recipeCookbookSource({ data, request: context.startOperation }),
  );
const cookbookDiffTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof cookbookDiffInput>)
  .handler(async ({ data, context }) =>
    browser.recipeCookbookDiff({ data, request: context.startOperation }),
  );
const previewNotionTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as undefined)
  .handler(async ({ data, context }) =>
    browser.recipePreviewNotion({ data, request: context.startOperation }),
  );
const setCookbookProductTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (input: unknown) => input as z.input<typeof setCookbookProductInput>,
  )
  .handler(async ({ data, context }) =>
    browser.recipeSetCookbookProduct({ data, request: context.startOperation }),
  );
const deleteCookbookTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof cookbookIdInput>)
  .handler(async ({ data, context }) =>
    browser.recipeDeleteCookbook({ data, request: context.startOperation }),
  );
const extractCookbookChunkTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((input: unknown) => input as z.input<typeof chunkRequestInput>)
  .handler(
    async ({ data, context }) =>
      (await browser.recipeExtractCookbookChunk({
        data,
        request: context.startOperation,
      })) as never,
  );

const getMany = operation(
  "recipe.getManyByIDs",
  (data, { signal, headers }) => getManyTransport({ data, signal, headers }),
  (value) => recipeGraphListOut.parse(value),
);
const tags = operation(
  "recipe.getAllTags",
  (data, { signal, headers }) => tagsTransport({ data, signal, headers }),
  (value) => recipeTagsOut.parse(value),
);
const duplicate = operation(
  "recipe.duplicate",
  (data, { signal, headers }) => duplicateTransport({ data, signal, headers }),
  (value) => recipeWithSideEffectsOut.parse(value),
  "mutation",
);
const cooccurrence = operation(
  "recipe.getIngredientCooccurrence",
  (data, { signal, headers }) =>
    cooccurrenceTransport({ data, signal, headers }),
  (value) => ingredientCooccurrenceSchema.parse(value),
);
const dependencyGraph = operation(
  "recipe.getDependencyGraph",
  (data, { signal, headers }) =>
    dependencyGraphTransport({ data, signal, headers }),
  (value) => recipeDependencyGraphSchema.parse(value),
);
const ingredientUsage = operation(
  "recipe.getIngredientUsage",
  (data, { signal, headers }) =>
    ingredientUsageTransport({ data, signal, headers }),
  (value) => ingredientUsageSchema.parse(value),
);
const recomputeOne = operation(
  "recipe.recomputeOne",
  (data, { signal, headers }) =>
    recomputeOneTransport({ data, signal, headers }),
  (value) => recipeRecomputeAllOut.parse(value),
  "mutation",
);
const dryRun = operation(
  "recipe.dryRunRecomputeTotals",
  (data, { signal, headers }) => dryRunTransport({ data, signal, headers }),
  (value) => recipeDryRunRecomputeTotalsOut.parse(value),
);
const explain = operation(
  "recipe.explainCosting",
  (data, { signal, headers }) => explainTransport({ data, signal, headers }),
  (value) => recipeCostingExplain.parse(value),
);
const flow = operation(
  "recipe.getFlow",
  (data, { signal, headers }) => flowTransport({ data, signal, headers }),
  (value) => recipeFlowStateSchema.parse(value),
);
const generateFlow = operation(
  "recipe.generateFlow",
  (data, { signal, headers }) =>
    generateFlowTransport({ data, signal, headers }),
  (value) => recipeFlowArtifactSchema.parse(value),
  "mutation",
);
const equivalences = operation(
  "recipe.harvestEquivalences",
  (data, { signal, headers }) =>
    equivalencesTransport({ data, signal, headers }),
  (value) => equivalenceReportSchema.parse(value),
);
const availability = operation(
  "suggestions.getRecipeAvailability",
  (data, { signal, headers }) =>
    availabilityTransport({ data, signal, headers }),
  (value) => recipeAvailabilityOut.parse(value),
);
const makeable = operation(
  "suggestions.getMakeable",
  (data, { signal, headers }) => makeableTransport({ data, signal, headers }),
  (value) => makeableRecipesOut.parse(value),
);
const scrape = operation(
  "recipe.scrape",
  (data, { signal, headers }) => scrapeTransport({ data, signal, headers }),
  (value) => importRecipeSchema.parse(value),
  "mutation",
);
const parseHtml = operation(
  "recipe.parseHtml",
  (data, { signal, headers }) => parseHtmlTransport({ data, signal, headers }),
  (value) => importRecipeSchema.parse(value),
  "mutation",
);
const upsertCookbook = operation(
  "recipe.upsertCookbook",
  (data, { signal, headers }) =>
    upsertCookbookTransport({ data, signal, headers }),
  (value) => cookbookIdOut.parse(value),
  "mutation",
);
const cookbookSource = operation(
  "recipe.getCookbookSource",
  (data, { signal, headers }) =>
    cookbookSourceTransport({ data, signal, headers }),
  (value) => cookbookSourceOut.parse(value),
);
const cookbookDiff = operation(
  "recipe.getCookbookDiff",
  (data, { signal, headers }) =>
    cookbookDiffTransport({ data, signal, headers }),
  (value) => cookbookDiffOut.parse(value),
);
const previewNotion = operation(
  "recipe.previewNotionSync",
  (data, { signal, headers }) =>
    previewNotionTransport({ data, signal, headers }),
  (value) => notionPreviewOut.parse(value),
);
const setCookbookProduct = operation(
  "recipe.setCookbookProduct",
  (data, { signal, headers }) =>
    setCookbookProductTransport({ data, signal, headers }),
  (value) => cookbookSummary.parse(value),
  "mutation",
);
const deleteCookbook = operation(
  "recipe.deleteCookbook",
  (data, { signal, headers }) =>
    deleteCookbookTransport({ data, signal, headers }),
  (value) => deleteCookbookOut.parse(value),
  "mutation",
);
const extractCookbookChunk = operation<
  z.input<typeof chunkRequestInput>,
  z.output<typeof chunkResponseOut>
>(
  "recipe.extractCookbookChunk",
  (data, { signal, headers }) =>
    extractCookbookChunkTransport({ data, signal, headers }),
  (value) => chunkResponseOut.parse(value),
  "mutation",
);

const mutation = <I, O>(
  key: readonly unknown[],
  current: ReturnType<typeof operation<I, O>>,
  options?: UseMutationOptions<O, Error, I>,
) =>
  mutationOptions({
    ...options,
    mutationKey: key,
    mutationFn: async (input: I) => {
      const result = await current.call(input);
      markFreshReads();
      return result;
    },
    meta: current.meta,
  });

export const recipeGetManyByIDsQueryOptions = (
  input: z.input<typeof recipeIdsInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "getManyByIDs"], input] as const,
    queryFn: ({ signal }) => getMany.call(input, { signal }),
    meta: getMany.meta,
  });
export const recipeGetAllTagsQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "getAllTags"]] as const,
    queryFn: ({ signal }) => tags.call(undefined, { signal }),
    meta: tags.meta,
  });
export const recipeDuplicateMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof recipeWithSideEffectsOut>,
    Error,
    z.input<typeof recipeIdInput>
  >,
) => mutation([...queryKeys.recipe.all, "duplicate"], duplicate, options);
export const recipeCooccurrenceQueryOptions = (
  input: z.input<typeof recipeCooccurrenceInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "cooccurrence"], input] as const,
    queryFn: ({ signal }) => cooccurrence.call(input, { signal }),
    meta: cooccurrence.meta,
  });
export const recipeDependencyGraphQueryOptions = (
  input: z.input<typeof recipeCookbookScopeInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "dependencyGraph"], input] as const,
    queryFn: ({ signal }) => dependencyGraph.call(input, { signal }),
    meta: dependencyGraph.meta,
  });
export const recipeIngredientUsageQueryOptions = (
  input: z.input<typeof recipeCookbookScopeInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "ingredientUsage"], input] as const,
    queryFn: ({ signal }) => ingredientUsage.call(input, { signal }),
    meta: ingredientUsage.meta,
  });
export const recipeRecomputeOneMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof recipeRecomputeAllOut>,
    Error,
    z.input<typeof recipeIdInput>
  >,
) => mutation([...queryKeys.recipe.all, "recomputeOne"], recomputeOne, options);
export const recipeDryRunQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "dryRun"]] as const,
    queryFn: ({ signal }) => dryRun.call(undefined, { signal }),
    meta: dryRun.meta,
  });
export const recipeExplainCostingQueryOptions = (
  input: z.input<typeof recipeIdInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "explain"], input] as const,
    queryFn: ({ signal }) => explain.call(input, { signal }),
    meta: explain.meta,
  });
export const recipeFlowQueryOptions = (
  input: z.input<typeof recipeFlowGetInputSchema>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.flow], input] as const,
    queryFn: ({ signal }) => flow.call(input, { signal }),
    meta: flow.meta,
  });
export const recipeGenerateFlowMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof recipeFlowArtifactSchema>,
    Error,
    z.input<typeof recipeFlowGenerateInputSchema>
  >,
) => mutation([...queryKeys.recipe.flow, "generate"], generateFlow, options);
export const recipeHarvestEquivalencesQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "equivalences"]] as const,
    queryFn: ({ signal }) => equivalences.call(undefined, { signal }),
    meta: equivalences.meta,
  });
export const recipeAvailabilityQueryOptions = (
  input: z.input<typeof recipeAvailabilityInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "availability"], input] as const,
    queryFn: ({ signal }) => availability.call(input, { signal }),
    meta: availability.meta,
  });
export const makeableRecipesQueryOptions = (
  input: z.input<typeof makeableRecipesInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "makeable"], input] as const,
    queryFn: ({ signal }) => makeable.call(input, { signal }),
    meta: makeable.meta,
  });
export const recipeScrapeMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof importRecipeSchema>,
    Error,
    z.input<typeof scrapeRecipeInput>
  >,
) => mutation([...queryKeys.recipe.all, "scrape"], scrape, options);
export const recipeParseHtmlMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof importRecipeSchema>,
    Error,
    z.input<typeof parseRecipeHtmlInput>
  >,
) => mutation([...queryKeys.recipe.all, "parseHtml"], parseHtml, options);
export const recipeUpsertCookbookMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof cookbookIdOut>,
    Error,
    z.input<typeof upsertCookbookInput>
  >,
) => mutation([...queryKeys.cookbook.all, "upsert"], upsertCookbook, options);
export const recipeCookbookSourceQueryOptions = (
  input: z.input<typeof cookbookIdInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.cookbook.all, "source"], input] as const,
    queryFn: ({ signal }) => cookbookSource.call(input, { signal }),
    meta: cookbookSource.meta,
  });
export const recipeCookbookDiffQueryOptions = (
  input: z.input<typeof cookbookDiffInput>,
) =>
  queryOptions({
    queryKey: [[...queryKeys.cookbook.all, "diff"], input] as const,
    queryFn: ({ signal }) => cookbookDiff.call(input, { signal }),
    meta: cookbookDiff.meta,
  });
export const recipePreviewNotionQueryOptions = () =>
  queryOptions({
    queryKey: [[...queryKeys.recipe.all, "previewNotion"]] as const,
    queryFn: ({ signal }) => previewNotion.call(undefined, { signal }),
    meta: previewNotion.meta,
  });
export const recipeSetCookbookProductMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof cookbookSummary>,
    Error,
    z.input<typeof setCookbookProductInput>
  >,
) =>
  mutation(
    [...queryKeys.cookbook.all, "setProduct"],
    setCookbookProduct,
    options,
  );
export const recipeDeleteCookbookMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof deleteCookbookOut>,
    Error,
    z.input<typeof cookbookIdInput>
  >,
) => mutation([...queryKeys.cookbook.all, "delete"], deleteCookbook, options);
export const recipeExtractCookbookChunkMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof chunkResponseOut>,
    Error,
    z.input<typeof chunkRequestInput>
  >,
) =>
  mutation(
    [...queryKeys.cookbook.all, "extractChunk"],
    extractCookbookChunk,
    options,
  );

type RecipeRecomputeDurableResult = {
  enqueued: number;
  total: number;
  batchId: string | null;
};
const recomputeEventSchema = recipeRecomputeDurableEventSchema as z.ZodType<
  BulkProgressEvent<unknown, RecipeRecomputeDurableResult>
>;
export const openRecipeRecomputeAllStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "recipe.recomputeAllDurable",
    kind: "mutation",
    url: "/api/recipe-stream/recompute-all",
    input: undefined,
    eventSchema: recomputeEventSchema,
    signal,
  });
export const openRecipeRecomputeStaleStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "recipe.recomputeStaleDurable",
    kind: "mutation",
    url: "/api/recipe-stream/recompute-stale",
    input: undefined,
    eventSchema: recomputeEventSchema,
    signal,
  });
