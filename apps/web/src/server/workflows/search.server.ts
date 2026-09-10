import type { enqueueEmbeddingBackfillInputSchema } from "@cubby/schemas/background-jobs";
import type {
  requestEmbeddingRefreshInputSchema,
  searchQueryInputSchema,
} from "@cubby/schemas/search";
import type { z } from "zod";

import { dispatchBackgroundJobs } from "~/server/background-dispatch";
import type { Database } from "~/server/db";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  findGroupedSearchHits,
  findRelatedSearchGroups,
} from "~/server/services/search-grouping.service";
import {
  findRelatedSearchHits,
  findSearchHits,
  inspectSearchDocumentHealth,
  repairSearchDocuments,
} from "~/server/services/search.service";
import { enqueueEntityEmbeddingBackfill } from "~/server/services/semantic-search.service";
import {
  callStep,
  committedCallStep,
  mapWorkflowValue,
  defineWorkflow,
  defineWorkflowFunction,
  defineWorkflowOperation,
  bindWorkflow,
  parallelStep,
  workflowInput,
  workflowValue,
} from "~/server/workflow-runtime";

export const findSearchHitsWorkflow = defineWorkflowOperation(
  "search.find",
  findSearchHits,
);
export const findGroupedSearchHitsWorkflow = defineWorkflowOperation(
  "search.grouped",
  findGroupedSearchHits,
);
export const inspectSearchDocumentHealthWorkflow = defineWorkflowOperation(
  "search.documentHealth",
  inspectSearchDocumentHealth,
);

type RepairSearchDocumentsOutput = Awaited<
  ReturnType<typeof repairSearchDocuments>
>;
const repairSearchDocumentsStep = committedCallStep({
  name: "repair",
  input: workflowInput<undefined>(),
  fn: defineWorkflowFunction<Database, undefined, RepairSearchDocumentsOutput>(
    "search.repairDocuments",
    async ({ context }) => repairSearchDocuments(context),
  ),
});
export const repairSearchDocumentsWorkflow = bindWorkflow(
  defineWorkflow({
    name: "search.repairDocuments",
    steps: [repairSearchDocumentsStep],
    output: repairSearchDocumentsStep.output,
  }),
  (db: Database) => ({ context: db, input: undefined }),
);

export const findRelatedSearchHitsWorkflow = defineWorkflowOperation(
  "search.related",
  findRelatedSearchHits,
);

export const findRelatedSearchGroupsWorkflow = defineWorkflowOperation(
  "search.relatedGrouped",
  findRelatedSearchGroups,
);

export { findSimilarEntitiesWorkflow } from "./semantic-similarity.server";

type SearchDebugInput = z.output<typeof searchQueryInputSchema>;
type SearchDebugLexical = Awaited<ReturnType<typeof findSearchHits>>;
type SearchDebugRelated = Awaited<ReturnType<typeof findRelatedSearchHits>>;
type SearchDebugBranches = {
  lexical: SearchDebugLexical;
  related: SearchDebugRelated;
};
type SearchDebugAssemblyInput = {
  input: SearchDebugInput;
  branches: SearchDebugBranches;
};
type SearchDebugOutput = {
  query: string;
  lexical: SearchDebugLexical;
  semantic: SearchDebugRelated["results"];
  results: SearchDebugLexical;
};

const searchDebugLexical = defineWorkflowFunction<
  Database,
  SearchDebugInput,
  SearchDebugLexical
>("search.debug.lexical", async ({ context }, input) =>
  findSearchHits(context, input),
);
const searchDebugRelated = defineWorkflowFunction<
  Database,
  SearchDebugInput,
  SearchDebugRelated
>("search.debug.related", async ({ context }, input) =>
  findRelatedSearchHits(context, input),
);
const searchDebugLexicalStep = callStep({
  name: "find",
  fn: searchDebugLexical,
  input: workflowInput<SearchDebugInput>(),
});
const searchDebugLexicalWorkflow = defineWorkflow({
  name: "lexical",
  steps: [searchDebugLexicalStep],
  output: searchDebugLexicalStep.output,
});
const searchDebugRelatedStep = callStep({
  name: "find",
  fn: searchDebugRelated,
  input: workflowInput<SearchDebugInput>(),
});
const searchDebugRelatedWorkflow = defineWorkflow({
  name: "related",
  steps: [searchDebugRelatedStep],
  output: searchDebugRelatedStep.output,
});
const searchDebugParallelStep = parallelStep({
  name: "searches",
  input: workflowInput<SearchDebugInput>(),
  concurrency: 2,
  branches: {
    lexical: searchDebugLexicalWorkflow,
    related: searchDebugRelatedWorkflow,
  },
});
const searchDebugBranches = workflowValue<
  SearchDebugInput,
  SearchDebugAssemblyInput
>(["$input", "searches"], (state) => {
  return {
    input: state.input,
    branches: searchDebugParallelStep.output.resolve(state),
  };
});
const assembleSearchDebug = defineWorkflowFunction<
  Database,
  SearchDebugAssemblyInput,
  SearchDebugOutput
>("search.debug.assemble", async (_, { input, branches }) => ({
  query: input.query,
  lexical: branches.lexical,
  semantic: branches.related.results,
  results: branches.lexical,
}));
const searchDebugOutputStep = callStep({
  name: "assemble",
  fn: assembleSearchDebug,
  input: searchDebugBranches,
});
const searchDebugWorkflowDefinition = defineWorkflow({
  name: "search.debug",
  steps: [searchDebugParallelStep, searchDebugOutputStep],
  output: searchDebugOutputStep.output,
});

export const inspectSearchDebugWorkflow = bindWorkflow(
  searchDebugWorkflowDefinition,
  (db: Database, input: SearchDebugInput) => ({ context: db, input }),
);

type EnqueueEmbeddingBackfillInput = z.output<
  typeof enqueueEmbeddingBackfillInputSchema
>;
type EnqueueEmbeddingBackfillOutput = Awaited<
  ReturnType<typeof enqueueEntityEmbeddingBackfill>
>;
const enqueueEmbeddingBackfillStep = committedCallStep({
  name: "enqueue",
  input: workflowInput<EnqueueEmbeddingBackfillInput>(),
  fn: defineWorkflowFunction<
    Database,
    EnqueueEmbeddingBackfillInput,
    EnqueueEmbeddingBackfillOutput
  >("search.enqueueEmbeddingBackfill", async ({ context }, input) =>
    enqueueEntityEmbeddingBackfill(context, input),
  ),
});
export const enqueueEmbeddingBackfillWorkflow = bindWorkflow(
  defineWorkflow({
    name: "search.enqueueEmbeddingBackfill",
    steps: [enqueueEmbeddingBackfillStep],
    output: enqueueEmbeddingBackfillStep.output,
  }),
  (db: Database, input: EnqueueEmbeddingBackfillInput) => ({
    context: db,
    input,
  }),
);

type RefreshInput = z.output<typeof requestEmbeddingRefreshInputSchema>;
type ResolvedRefresh = {
  entityType: RefreshInput["entityType"];
  entityId: Awaited<ReturnType<typeof resolveOrThrow>>;
};
const resolveRefreshEntity = defineWorkflowFunction<
  Database,
  RefreshInput,
  ResolvedRefresh
>("search.embeddingRefresh.resolve", async ({ context }, input) => ({
  entityType: input.entityType,
  entityId: await resolveOrThrow(context, input.entityType, input.entityId),
}));
const resolveRefreshStep = callStep({
  name: "resolve",
  fn: resolveRefreshEntity,
  input: workflowInput<RefreshInput>(),
});
const dispatchRefresh = defineWorkflowFunction<
  Database,
  ResolvedRefresh,
  Awaited<ReturnType<typeof dispatchBackgroundJobs>>
>(
  "search.embeddingRefresh.dispatch",
  async ({ context }, { entityType, entityId }) =>
    dispatchBackgroundJobs(context, {
      kind: "entity-embedding.refresh",
      source: "ui",
      metadata: { source: "relatedness.indexNow", entityType },
      jobs: [
        {
          kind: "entity-embedding.refresh",
          dedupeKey: `entity-embedding.refresh:${entityType}:${entityId}`,
          payload: { entityType, entityId },
        },
      ],
    }),
);
const dispatchRefreshStep = committedCallStep({
  name: "dispatch",
  fn: dispatchRefresh,
  input: resolveRefreshStep.output,
});
export const requestEmbeddingRefreshWorkflow = bindWorkflow(
  defineWorkflow({
    name: "search.embeddingRefresh",
    steps: [resolveRefreshStep, dispatchRefreshStep],
    output: mapWorkflowValue(dispatchRefreshStep.output, (dispatched) => ({
      batchId: dispatched.batchId,
      totalJobs: dispatched.jobIds.length,
    })),
  }),
  (db: Database, input: RefreshInput) => ({ context: db, input }),
);
