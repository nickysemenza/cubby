import type {
  requestEmbeddingRefreshInputSchema,
  searchQueryInputSchema,
} from "@cubby/schemas/search";
import type { z } from "zod";

import { publishBackgroundTasks } from "~/server/background-tasks/publish";
import type { Database } from "~/server/db";
import { resolveOrThrow } from "~/server/repo/shortcode-resolver";
import {
  findGroupedSearchHits,
  findRelatedSearchGroups,
} from "~/server/services/search-grouping.service";
import {
  findRelatedSearchHits,
  findSearchHits,
} from "~/server/services/search.service";
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

type RefreshInput = z.output<typeof requestEmbeddingRefreshInputSchema>;
export const requestEmbeddingRefreshWorkflow = bindWorkflow(
  workflow<Database, RefreshInput>("search.embeddingRefresh")
    .call("resolve", async ({ context }, { input }) => ({
      entityType: input.entityType,
      entityId: await resolveOrThrow(context, input.entityType, input.entityId),
    }))
    // Awaited, unlike a mutation's after-commit publication: this IS the
    // user's action, so its acknowledgment must mean the queue accepted it.
    .commit("publish", async ({ context }, { resolve }) =>
      publishBackgroundTasks(
        context,
        [
          {
            kind: "entity-embedding.refresh",
            requestedAt: new Date().toISOString(),
            entityType: resolve.entityType,
            entityId: resolve.entityId,
          },
        ],
        { source: "relatedness.indexNow" },
      ),
    )
    .output(() => ({ accepted: true as const })),
  (db: Database, input: RefreshInput) => ({ context: db, input }),
);
