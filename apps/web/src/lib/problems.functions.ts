import {
  type cleanupOrphanedEntityEmbeddingsInput,
  cleanupOrphanedEntityEmbeddingsOut,
  coverageTotalsSchema,
  type deleteUnusedIngredientsInput,
  deleteUnusedIngredientsOut,
  dryRunPruneAliasesOut,
  dryRunReparseOut,
  maintenanceCountsSchema,
  problemsCountSchema,
  problemsCoverageSchema,
  problemsFastSchema,
  problemsPruneAliasesEventSchema,
  problemsReparseEventSchema,
  problemsTrackerSchema,
  problemsUpcSchema,
  problemsViewsSchema,
  type recipeUsageByProductInput,
  recipeUsageByProductOut,
} from "@cubby/schemas/problems";
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
import { markFreshReads } from "~/lib/fresh-read-marker";
import { openWorkflowStream } from "~/lib/workflow-stream";
import { authenticatedStartServerFunction } from "~/server/middleware/entity-server-functions";
import * as browser from "~/server/problems-browser.server";

const getFastTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getFastProblemsForBrowser({ request: context.startOperation }),
  );
const getCountsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getProblemCountsForBrowser({ request: context.startOperation }),
  );
const getViewsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getViewProblemsForBrowser({ request: context.startOperation }),
  );
const getCoverageTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getCoverageProblemsForBrowser({ request: context.startOperation }),
  );
const getUpcTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getUpcProblemsForBrowser({ request: context.startOperation }),
  );
const getTrackerTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getTrackerProblemsForBrowser({ request: context.startOperation }),
  );
const getCoverageTotalsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getCoverageTotalsForBrowser({ request: context.startOperation }),
  );
const getMaintenanceCountsTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.getMaintenanceCountsForBrowser({ request: context.startOperation }),
  );
const dryRunReparseTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.dryRunReparseForBrowser({ request: context.startOperation }),
  );
const dryRunPruneAliasesTransport = createServerFn({ method: "GET" })
  .middleware([authenticatedStartServerFunction])
  .handler(({ context }) =>
    browser.dryRunPruneAliasesForBrowser({ request: context.startOperation }),
  );
const recipeUsageTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof recipeUsageByProductInput>)
  .handler(({ data, context }) =>
    browser.getRecipeUsageByProductForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const deleteUnusedTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator((v: unknown) => v as z.input<typeof deleteUnusedIngredientsInput>)
  .handler(({ data, context }) =>
    browser.deleteUnusedIngredientsForBrowser({
      data,
      request: context.startOperation,
    }),
  );
const cleanupOrphanedEmbeddingsTransport = createServerFn({ method: "POST" })
  .middleware([authenticatedStartServerFunction])
  .validator(
    (v: unknown) => v as z.input<typeof cleanupOrphanedEntityEmbeddingsInput>,
  )
  .handler(({ data, context }) =>
    browser.cleanupOrphanedEmbeddingsForBrowser({
      data,
      request: context.startOperation,
    }),
  );

const noInputOperation = <O>(
  operation: string,
  transport: (options: {
    signal?: AbortSignal;
    headers: HeadersInit;
  }) => Promise<unknown>,
  schema: z.ZodType<O>,
) =>
  startOperation<undefined, O>({
    operation,
    transport: (_input, options) => transport(options) as never,
    parse: (result) => schema.parse(result),
  });
const getFastOperation = noInputOperation(
  "problems.getFast",
  ({ signal, headers }) => getFastTransport({ signal, headers }),
  problemsFastSchema,
);
const getCountsOperation = noInputOperation(
  "problems.getCounts",
  ({ signal, headers }) => getCountsTransport({ signal, headers }),
  problemsCountSchema,
);
const getViewsOperation = noInputOperation(
  "problems.getViews",
  ({ signal, headers }) => getViewsTransport({ signal, headers }),
  problemsViewsSchema,
);
const getCoverageOperation = noInputOperation(
  "problems.getCoverage",
  ({ signal, headers }) => getCoverageTransport({ signal, headers }),
  problemsCoverageSchema,
);
const getUpcOperation = noInputOperation(
  "problems.getUpc",
  ({ signal, headers }) => getUpcTransport({ signal, headers }),
  problemsUpcSchema,
);
const getTrackerOperation = noInputOperation(
  "problems.getTracker",
  ({ signal, headers }) => getTrackerTransport({ signal, headers }),
  problemsTrackerSchema,
);
const getCoverageTotalsOperation = noInputOperation(
  "problems.getCoverageTotals",
  ({ signal, headers }) => getCoverageTotalsTransport({ signal, headers }),
  coverageTotalsSchema,
);
const getMaintenanceCountsOperation = noInputOperation(
  "problems.getMaintenanceCounts",
  ({ signal, headers }) => getMaintenanceCountsTransport({ signal, headers }),
  maintenanceCountsSchema,
);
const dryRunReparseOperation = noInputOperation(
  "problems.dryRunReparse",
  ({ signal, headers }) => dryRunReparseTransport({ signal, headers }),
  dryRunReparseOut,
);
const dryRunPruneAliasesOperation = noInputOperation(
  "problems.dryRunPruneAliases",
  ({ signal, headers }) => dryRunPruneAliasesTransport({ signal, headers }),
  dryRunPruneAliasesOut,
);
const recipeUsageOperation = startOperation({
  operation: "problems.recipeUsageByProduct",
  transport: (
    data: z.input<typeof recipeUsageByProductInput>,
    { signal, headers },
  ) => recipeUsageTransport({ data, signal, headers }),
  parse: (result) => recipeUsageByProductOut.parse(result),
});
const deleteUnusedOperation = startOperation({
  operation: "problems.deleteUnused",
  kind: "mutation",
  transport: (
    data: z.input<typeof deleteUnusedIngredientsInput>,
    { headers },
  ) => deleteUnusedTransport({ data, headers }),
  parse: (result) => deleteUnusedIngredientsOut.parse(result),
});
const cleanupOrphanedOperation = startOperation({
  operation: "problems.cleanupOrphanedEmbeddings",
  kind: "mutation",
  transport: (
    data: z.input<typeof cleanupOrphanedEntityEmbeddingsInput>,
    { headers },
  ) => cleanupOrphanedEmbeddingsTransport({ data, headers }),
  parse: (result) => cleanupOrphanedEntityEmbeddingsOut.parse(result),
});

export const problemsRootKey = (name: string) =>
  [["problems", name], { type: "query" }] as const;
const noInputQuery = <O>(
  name: string,
  operation: StartOperation<undefined, O>,
  options?: { enabled?: boolean; staleTime?: number },
) =>
  queryOptions({
    queryKey: problemsRootKey(name),
    meta: operation.meta,
    queryFn: ({ signal }) => operation.call(undefined, { signal }),
    ...options,
  });
export const problemsFastQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
}) => noInputQuery("getFast", getFastOperation, options);
export const problemsCountsQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
}) => noInputQuery("getCounts", getCountsOperation, options);
export const problemsViewsQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
}) => noInputQuery("getViews", getViewsOperation, options);
export const problemsCoverageQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
}) => noInputQuery("getCoverage", getCoverageOperation, options);
export const problemsUpcQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
}) => noInputQuery("getUpc", getUpcOperation, options);
export const problemsTrackerQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
}) => noInputQuery("getTracker", getTrackerOperation, options);
export const problemsCoverageTotalsQueryOptions = () =>
  noInputQuery("getCoverageTotals", getCoverageTotalsOperation);
export const problemsMaintenanceCountsQueryOptions = (options?: {
  enabled?: boolean;
  staleTime?: number;
  refetchInterval?: number | false;
}) =>
  queryOptions({
    ...noInputQuery(
      "getMaintenanceCounts",
      getMaintenanceCountsOperation,
      options,
    ),
    refetchInterval: options?.refetchInterval,
  });
export const problemsDryRunReparseQueryOptions = (options?: {
  enabled?: boolean;
}) => noInputQuery("dryRunReparse", dryRunReparseOperation, options);
export const problemsDryRunPruneAliasesQueryOptions = (options?: {
  enabled?: boolean;
}) => noInputQuery("dryRunPruneAliases", dryRunPruneAliasesOperation, options);
export const problemsRecipeUsageQueryOptions = (
  input: z.input<typeof recipeUsageByProductInput>,
) =>
  queryOptions({
    queryKey: [
      ["problems", "recipeUsageByProduct"],
      { input, type: "query" },
    ] as const,
    meta: recipeUsageOperation.meta,
    queryFn: ({ signal }) => recipeUsageOperation.call(input, { signal }),
  });
export const problemsDeleteUnusedMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof deleteUnusedIngredientsOut>,
    Error,
    z.input<typeof deleteUnusedIngredientsInput>
  >,
) =>
  mutationOptions({
    mutationKey: [["problems", "deleteUnused"]] as const,
    meta: deleteUnusedOperation.meta,
    mutationFn: async (input) => {
      const result = await deleteUnusedOperation.call(input);
      markFreshReads();
      return result;
    },
    ...options,
  });
export const problemsCleanupOrphanedEmbeddingsMutationOptions = (
  options?: UseMutationOptions<
    z.output<typeof cleanupOrphanedEntityEmbeddingsOut>,
    Error,
    z.input<typeof cleanupOrphanedEntityEmbeddingsInput>
  >,
) =>
  mutationOptions({
    mutationKey: [["problems", "cleanupOrphanedEmbeddings"]] as const,
    meta: cleanupOrphanedOperation.meta,
    mutationFn: async (input) => {
      const result = await cleanupOrphanedOperation.call(input);
      markFreshReads();
      return result;
    },
    ...options,
  });
export const cleanupOrphanedEmbeddings = (
  input: z.input<typeof cleanupOrphanedEntityEmbeddingsInput>,
) => cleanupOrphanedOperation.call(input);

export const openProblemsReparseStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "problems.reparseStale",
    kind: "mutation",
    url: "/api/problems-stream/reparse-stale",
    input: undefined,
    eventSchema: problemsReparseEventSchema,
    signal,
  });
export const openProblemsPruneAliasesStream = (signal?: AbortSignal) =>
  openWorkflowStream({
    operation: "problems.pruneAllUnusedAliases",
    kind: "mutation",
    url: "/api/problems-stream/prune-unused-aliases",
    input: undefined,
    eventSchema: problemsPruneAliasesEventSchema,
    signal,
  });
