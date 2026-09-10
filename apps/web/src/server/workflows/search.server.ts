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
  defineWorkflowOperation,
  bindWorkflow,
  workflow,
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

export const repairSearchDocumentsWorkflow = bindWorkflow(
  workflow<Database, undefined>("search.repairDocuments")
    .commit("repair", async ({ context }) => repairSearchDocuments(context))
    .output(({ repair }) => repair),
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
export const inspectSearchDebugWorkflow = bindWorkflow(
  workflow<Database, SearchDebugInput>("search.debug")
    .parallel("searches", 2, {
      lexical: async ({ context }, { input }) => findSearchHits(context, input),
      related: async ({ context }, { input }) =>
        findRelatedSearchHits(context, input),
    })
    .call("assemble", async (_, { input, searches }) => ({
      query: input.query,
      lexical: searches.lexical,
      semantic: searches.related.results,
      results: searches.lexical,
    }))
    .output(({ assemble }) => assemble),
  (db: Database, input: SearchDebugInput) => ({ context: db, input }),
);

type EnqueueEmbeddingBackfillInput = z.output<
  typeof enqueueEmbeddingBackfillInputSchema
>;
export const enqueueEmbeddingBackfillWorkflow = bindWorkflow(
  workflow<Database, EnqueueEmbeddingBackfillInput>(
    "search.enqueueEmbeddingBackfill",
  )
    .commit("enqueue", async ({ context }, { input }) =>
      enqueueEntityEmbeddingBackfill(context, input),
    )
    .output(({ enqueue }) => enqueue),
  (db: Database, input: EnqueueEmbeddingBackfillInput) => ({
    context: db,
    input,
  }),
);

type RefreshInput = z.output<typeof requestEmbeddingRefreshInputSchema>;
export const requestEmbeddingRefreshWorkflow = bindWorkflow(
  workflow<Database, RefreshInput>("search.embeddingRefresh")
    .call("resolve", async ({ context }, { input }) => ({
      entityType: input.entityType,
      entityId: await resolveOrThrow(context, input.entityType, input.entityId),
    }))
    .commit("dispatch", async ({ context }, { resolve }) => {
      const dispatched = await dispatchBackgroundJobs(context, {
        kind: "entity-embedding.refresh",
        source: "ui",
        metadata: {
          source: "relatedness.indexNow",
          entityType: resolve.entityType,
        },
        jobs: [
          {
            kind: "entity-embedding.refresh",
            dedupeKey: `entity-embedding.refresh:${resolve.entityType}:${resolve.entityId}`,
            payload: {
              entityType: resolve.entityType,
              entityId: resolve.entityId,
            },
          },
        ],
      });
      return dispatched;
    })
    .output(({ dispatch }) => ({
      batchId: dispatch.batchId,
      totalJobs: dispatch.jobIds.length,
    })),
  (db: Database, input: RefreshInput) => ({ context: db, input }),
);
